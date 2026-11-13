import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WalletRuntime } from "../app/runtime.js";
import type { WalletRequests } from "../app/requests.js";
import type { ClientHandle } from "../app/sessions.js";
import type { X402RequestInput, RequestView, HostPaymentInput, HostPaymentMaterial, HostPaymentPrepared } from "../domain/requestModel.js";
import { requireWallet } from "../domain/errors.js";
import { HostPayments } from "../app/hostPayments.js";
import { createHostPaymentSession, type HostPaymentWait } from "./hostPaymentSession.js";
import { createAuthenticatedPaymentClient } from "./paymentClient.js";
import { DurableOperationAdapter } from "./durableOperations.js";
import { createWalletClient } from "./walletClient.js";
import type { HostRequestClient } from "./hostRequestProtocol.js";
import { WalletToolCalls } from "./walletToolCalls.js";
import { ResponseExporter } from "./responseExport.js";
import type {
  PaymentApprovalView,
  PaymentApprovalChoice,
  PaymentApprovalDecision,
} from "../app/paymentApprovalTypes.js";

export interface HostWalletConnection extends HostRequestClient {
  callPaymentClient(method: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  prepareHostPayment(input: HostPaymentInput, source: string, signal?: AbortSignal): Promise<HostPaymentPrepared>;
  submitHostPayment(requestId: string, requestDigest: string, signal?: AbortSignal): Promise<HostPaymentMaterial>;
  approveDestination(requestId: string, directory: string, name: string, signal?: AbortSignal): Promise<string>;
  callTool(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  preparePayment(requestId: string, signal?: AbortSignal): Promise<PaymentApprovalView>;
  decidePayment(
    approvalId: string,
    choice: PaymentApprovalChoice,
    signal?: AbortSignal,
  ): Promise<PaymentApprovalDecision>;
  close(): Promise<void>;
}
export type HostPaymentPresenter = (
  view: PaymentApprovalView,
  signal: AbortSignal,
) => Promise<void>;
type PaymentWait = {
  signal: AbortSignal;
  lifetime: AbortController;
  approvalId?: string;
  walletId?: string;
  done: Promise<RequestView>;
};
const MAX_CONNECTIONS = 32;
const MAX_JOURNALS = 128;
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One utility-local owner per opened wallet service. Never constructed from model configuration. */
export class HostWalletConnections {
  private readonly directory: string;
  private readonly journals = new Map<string, DurableOperationAdapter>();
  private readonly connections = new Set<HostWalletConnection>();
  private readonly opening = new Set<Promise<HostWalletConnection>>();
  private closed = false;
  private closing?: Promise<void>;
  private readonly hostPayments: HostPayments;
  private readonly hostPaymentWork = new Set<string>();
  constructor(
    private readonly runtime: WalletRuntime,
    private readonly requests: WalletRequests,
    directory: string,
  ) {
    const canonical = realpathSync(directory);
    requireWallet(
      canonical === resolve(directory),
      "OPERATION_CONTEXT_REQUIRED",
      "The trusted wallet profile directory must be canonical.",
    );
    this.directory = canonical;
    this.hostPayments = new HostPayments(requests.store, requests.payment);
  }

  async connect(
    clientId: string,
    chatId: string,
    mode: "create" | "open",
    presentPayment?: HostPaymentPresenter,
    hostGrantScope?: string,
  ): Promise<HostWalletConnection> {
    this.assertOpen();
    requireWallet(
      typeof clientId === "string" &&
        CLIENT_ID.test(clientId) &&
        typeof chatId === "string" &&
        chatId.length > 0 &&
        chatId.length <= 256 &&
        (mode === "create" || mode === "open"),
      "CLIENT_CONTEXT_INVALID",
      "A registered internal client, host chat and explicit journal mode are required.",
    );
    requireWallet(
      this.connections.size + this.opening.size < MAX_CONNECTIONS,
      "CLIENT_CAPACITY_EXCEEDED",
      "The host wallet connection capacity is exhausted.",
    );
    // Register pending ownership before calling any asynchronous session implementation.
    const pending = Promise.resolve().then(async () => {
      this.assertOpen();
      const handle = await this.runtime.sessions.connect(clientId, chatId, hostGrantScope);
      try {
        this.assertOpen();
        let journal = this.journals.get(clientId);
        requireWallet(
          !journal || mode === "open",
          "OPERATION_CONTEXT_REQUIRED",
          "An initialized journal cannot be created again.",
        );
        if (!journal) {
          requireWallet(
            this.journals.size < MAX_JOURNALS,
            "CLIENT_CAPACITY_EXCEEDED",
            "The host wallet journal capacity is exhausted.",
          );
          const path = join(this.directory, `host-operations-${clientId}.sqlite`);
          journal =
            mode === "create"
              ? DurableOperationAdapter.create(path, clientId)
              : DurableOperationAdapter.open(path, clientId);
          this.journals.set(clientId, journal);
        }
        const connection = this.connection(handle, journal, presentPayment);
        this.connections.add(connection);
        return connection;
      } catch (error) {
        await this.runtime.sessions.disconnect(handle);
        throw error;
      }
    });
    this.opening.add(pending);
    try {
      return await pending;
    } finally {
      this.opening.delete(pending);
    }
  }

  async prepareDesktopClient(): Promise<{ clientId: string; mode: "open" }> {
    this.assertOpen();
    const result = await this.runtime.management.execute({ action: "ensure_desktop_client" });
    this.assertOpen();
    const clientId = result.clientId!;
    if (!this.journals.has(clientId)) {
      requireWallet(this.journals.size < MAX_JOURNALS, "CLIENT_CAPACITY_EXCEEDED", "The host journal inventory is full.");
      const path = join(this.directory, `host-operations-${clientId}.sqlite`);
      const journal = existsSync(path)
        ? result.freshHistory ? DurableOperationAdapter.resumeInitialization(path, clientId) : DurableOperationAdapter.open(path, clientId)
        : result.freshHistory ? DurableOperationAdapter.create(path, clientId) : DurableOperationAdapter.open(path, clientId);
      this.journals.set(clientId, journal);
    }
    return { clientId, mode: "open" };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    let finish!: () => void, fail!: (error: unknown) => void;
    this.closing = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // Mark and cancel every live connection synchronously before the first await.
    const pendingClose = [...this.connections].map((connection) => connection.close());
    void (async () => {
      const closed = await Promise.allSettled(pendingClose);
      await Promise.allSettled(this.opening);
      const failures: unknown[] = closed.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      for (const journal of this.journals.values()) {
        try {
          journal.close();
        } catch (error) {
          failures.push(error);
        }
      }
      this.journals.clear();
      if (failures.length) throw failures[0];
    })().then(finish, fail);
    return this.closing;
  }

  private assertOpen(): void {
    requireWallet(
      !this.closed,
      "CLIENT_AUTHENTICATION_REQUIRED",
      "The host wallet owner is closed.",
    );
  }

  private connection(
    handle: ClientHandle,
    journal: DurableOperationAdapter,
    presentPayment?: HostPaymentPresenter,
  ): HostWalletConnection {
    const sdk = createWalletClient(this.requests, handle, journal);
    const exporter = new ResponseExporter(this.requests);
    const tools = new WalletToolCalls(this.runtime, this.requests, handle, exporter);
    const lifetime = new AbortController();
    const work = new Set<Promise<unknown>>();
    const paymentWaits = new Map<string, PaymentWait>();
    const hostPaymentWaits = new Map<string, HostPaymentWait>();
    let ended = false,
      closing: Promise<void> | undefined;
    const assertLive = () => {
      this.assertOpen();
      requireWallet(
        !ended,
        "CLIENT_AUTHENTICATION_REQUIRED",
        "The host wallet connection is closed.",
      );
    };
    const run = async <T>(
      signal: AbortSignal | undefined,
      action: (combined: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      assertLive();
      const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
      const pending = Promise.resolve().then(() => {
        assertLive();
        combined.throwIfAborted();
        return action(combined);
      });
      work.add(pending);
      try {
        return await pending;
      } finally {
        work.delete(pending);
      }
    };
    const paymentClient = createAuthenticatedPaymentClient({ runtime: this.runtime, requests: this.requests, handle,
      scopeToSession: true,
      present: presentPayment ? async (view, _decide, signal) => {
        hostPaymentWaits.set(view.requestId, { signal, approvalId: view.approvalId, walletId: view.wallet.walletId });
        try { await presentPayment(view, signal); }
        finally { hostPaymentWaits.delete(view.requestId); }
      } : undefined });
    const connection: HostWalletConnection = Object.freeze({
      callPaymentClient: (method: string, input: Record<string, unknown>, signal?: AbortSignal) =>
        run(signal, combined => paymentClient.call(method, structuredClone(input), combined)),
      ...createHostPaymentSession({ requests: this.requests, payments: this.hostPayments, handle, journal,
        present: presentPayment, active: this.hostPaymentWork, waits: hostPaymentWaits, run, assertLive }),
      approveDestination: (requestId: string, directory: string, name: string, signal?: AbortSignal) =>
        run(signal, async (combined) => {
          this.runtime.sessions.resolve(handle);
          const ref = await exporter.approve(handle, directory, name, requestId);
          try {
            assertLive(); combined.throwIfAborted(); this.runtime.sessions.resolve(handle);
            return ref;
          } catch (error) { exporter.discard(handle, ref); throw error; }
        }),
      callTool: async (name: string, input: Record<string, unknown>, signal?: AbortSignal) => {
        assertLive();
        const snapshot = structuredClone(input);
        return run(signal, (combined) => tools.call(name, snapshot, combined));
      },
      request: async (input: X402RequestInput, source: string, signal?: AbortSignal) => {
        assertLive();
        const snapshot = structuredClone(input);
        return run(signal, async (combined) => {
          const delivered = await sdk.request(snapshot, source, combined);
          if (!presentPayment) return delivered;
          const result = this.requests.get(handle, delivered.requestId);
          if (!["awaiting_authorization", "waiting_for_unlock"].includes(result.transportStatus))
            return result;
          const previous = paymentWaits.get(result.requestId);
          if (previous) return previous.done;
          const promptLifetime = new AbortController();
          const wait: PaymentWait = {
            signal: AbortSignal.any([combined, promptLifetime.signal]),
            lifetime: promptLifetime,
            done: undefined!,
          };
          wait.done = Promise.resolve().then(async () => {
            try {
              let view = await this.requests.approvals.prepare(
                handle,
                result.requestId,
                wait.signal,
              );
              wait.walletId = view.wallet.walletId;
              for (let attempt = 0; attempt < 2; attempt++) {
                requireWallet(
                  view.wallet.walletId === wait.walletId,
                  "PAYMENT_CONTEXT_CHANGED",
                  "The displayed payment wallet changed.",
                );
                wait.approvalId = view.approvalId;
                await presentPayment(view, wait.signal);
                assertLive();
                wait.signal.throwIfAborted();
                const current = this.requests.get(handle, result.requestId);
                if (current.transportStatus === "canceled") return current;
                const continued = await this.requests.resume(
                  handle,
                  result.requestId,
                  wait.signal,
                  wait.walletId,
                );
                if (continued.transportStatus !== "waiting_for_unlock" || attempt === 1)
                  return continued;
                view = await this.requests.approvals.prepare(handle, result.requestId, wait.signal);
              }
              throw new Error("PAYMENT_APPROVAL_UNAVAILABLE");
            } catch (error) {
              await this.requests.cancel(handle, result.requestId).catch(() => {});
              throw error;
            } finally {
              wait.lifetime.abort();
              if (paymentWaits.get(result.requestId) === wait)
                paymentWaits.delete(result.requestId);
            }
          });
          paymentWaits.set(result.requestId, wait);
          return wait.done;
        });
      },
      preparePayment: (id: string, signal?: AbortSignal) =>
        run(signal, async (combined) => {
          const wait = paymentWaits.get(id) ?? hostPaymentWaits.get(id);
          requireWallet(
            wait,
            "OPERATION_CONTEXT_REQUIRED",
            "The original payment call is no longer waiting.",
          );
          const view = await this.requests.approvals.prepare(
            handle,
            id,
            AbortSignal.any([combined, wait.signal]),
          );
          requireWallet(
            (paymentWaits.get(id) === wait || hostPaymentWaits.get(id) === wait) && !wait.signal.aborted,
            "WALLET_OPERATION_ABORTED",
            "The original payment call ended during inspection.",
          );
          requireWallet(
            wait.walletId === undefined || wait.walletId === view.wallet.walletId,
            "PAYMENT_CONTEXT_CHANGED",
            "The displayed payment wallet changed.",
          );
          wait.approvalId = view.approvalId;
          return hostPaymentWaits.get(id) === wait ? { ...view, allowPersistent: false } : view;
        }),
      decidePayment: (id: string, choice: PaymentApprovalChoice, signal?: AbortSignal) =>
        run(signal, (combined) => {
          const wait = [...paymentWaits.values(), ...hostPaymentWaits.values()].find((value) => value.approvalId === id);
          requireWallet(
            wait,
            "OPERATION_CONTEXT_REQUIRED",
            "The original payment call is no longer waiting.",
          );
          requireWallet(choice !== "persistent" || ![...hostPaymentWaits.values()].includes(wait),
            "INVALID_REQUEST", "Persistent approval is unavailable for this client.");
          return this.requests.approvals.decide(
            handle,
            id,
            choice,
            AbortSignal.any([combined, wait.signal]),
          );
        }),
      close: () => {
        if (closing) return closing;
        ended = true;
        exporter.clear(handle);
        let finish!: () => void, fail!: (error: unknown) => void;
        closing = new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
        lifetime.abort();
        const disconnect = this.runtime.sessions.disconnect(handle);
        void Promise.allSettled([...work, disconnect]).then((results) => {
          this.connections.delete(connection);
          const error = results.at(-1)!;
          if (error.status === "rejected") fail(error.reason);
          else finish();
        });
        return closing;
      },
    });
    return connection;
  }
}
