import { requestDeadline } from "./requestDeadline.js";
import { httpStageTimeout, REQUEST_PREPARATION_TIMEOUT_MS, RESPONSE_PROCESS_TIMEOUT_MS } from "../domain/requestTiming.js";
import type { ClientHandle } from "./sessions.js";
import type { RequestRecord, FrozenRequest, StoredQuote } from "../domain/requestModel.js";
import type { HttpResult, RequestWork, ResponseReservation } from "./requestPorts.js";
import type { RequestStore } from "./requestStore.js";
import type { RequestPayment } from "./requestPayment.js";
import type { WalletReconciliation } from "./reconciliation.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { RESPONSE_LIMIT } from "../domain/requestValidation.js";
import { abortable } from "./requestWait.js";
import { byteDigest } from "./requestFacts.js";
import { parseQuote } from "./requestQuote.js";
import { authorizeOutbound, checkOutbound } from "./outboundAuthorization.js";
import type { OutboundEffect } from "./requestPorts.js";
import type { ResponseRetentionOwner } from "./responseRetentionOwner.js";
import { encodeRetainedHttpContext, decodeRetainedHttpContext, type RetainedHttpContext } from "./retainedHttpContext.js";
export class RequestHttp {
  constructor(
    private readonly store: RequestStore,
    private readonly payment: RequestPayment,
    private readonly reconciliation: WalletReconciliation,
    private readonly retention?: ResponseRetentionOwner,
  ) {}
  async execute(
    handle: ClientHandle,
    r: RequestRecord,
    frozen: FrozenRequest,
    signal: AbortSignal,
    reservation: ResponseReservation,
    paymentHeader?: string,
    work?: RequestWork,
    retentionId?: string,
  ): Promise<number> {
    work?.assertCurrent();
    this.store.assertCurrent(handle, r, frozen);
    const preparation = requestDeadline(signal, REQUEST_PREPARATION_TIMEOUT_MS, this.store.env);
    let headers: Record<string, string>;
    try {
      requireWallet(
        (await abortable(
          authorizeOutbound(
            this.store,
            handle,
            r.requestId,
            frozen,
            paymentHeader ? "before_paid_http" : "before_initial_http",
            preparation.signal,
          ),
          preparation.signal,
        )) === true,
        "OUTBOUND_PERMISSION_REQUIRED",
        "The trusted host did not authorize this outbound action.",
      );
      preparation.check();
      headers = await this.store.credentials.headers(
        handle,
        frozen.credentialRef,
        frozen.url,
        frozen.credentialVersion,
      );
      work?.assertCurrent();
      this.store.assertCurrent(handle, r, frozen);
      requireWallet(!signal.aborted, "WALLET_OPERATION_ABORTED", "The request was canceled.");
      preparation.check();
    } finally { preparation.close(); }
    if (paymentHeader) headers["payment-signature"] = paymentHeader;
    Object.freeze(headers);
    const inspectionSecrets = Object.values(headers);
    await this.store.update(r.requestId, (record) => {
      requireWallet(!record.canceled, "WALLET_OPERATION_ABORTED", "The request was canceled.");
      requireWallet(
        paymentHeader || record.transportStatus === "prepared",
        "HTTP_ALREADY_STARTED",
        "Only the atomic winner of a prepared request may send its unsigned HTTP action.",
      );
      record.transportStatus = "running";
      delete record.diagnosticCode;
    });
    work?.assertCurrent();
    this.store.assertCurrent(handle, r, frozen);
    const network = requestDeadline(signal, httpStageTimeout(frozen), this.store.env);
    let response: HttpResult;
    try {
      const check = (effect: OutboundEffect) => {
        network.check();
        work?.assertCurrent();
        checkOutbound(
          this.store,
          handle,
          r.requestId,
          frozen,
          paymentHeader ? "before_paid_http" : "before_initial_http",
          effect,
          network.signal,
        );
        work?.assertCurrent();
        network.check();
        return true;
      };
      check("prepare_http");
      response = await this.store.env.http.send(frozen, headers, network.signal, check);
      network.check();
    } finally { network.close(); }
    const processing = requestDeadline(signal, RESPONSE_PROCESS_TIMEOUT_MS, this.store.env);
    signal = processing.signal;
    try {
      const timing = { receivedAt: this.store.env.wall(), receivedMonotonic: this.store.env.monotonic(),
        clockId: this.payment.clockId };
      if (this.retention && retentionId) {
        const context = encodeRetainedHttpContext({ version: 1, status: response.status,
          requestId: r.requestId, phase: paymentHeader ? "paid" : "initial",
          paymentIntentId: paymentHeader ? r.paymentIntentId! : null,
          headers: response.headers, secrets: inspectionSecrets, ...timing });
        try {
          await this.retention.write(retentionId, response.body, context, reservation, () => {
            processing.check();
            work?.assertCurrent(); this.store.assertCurrent(handle, r, frozen);
            processing.check();
          });
        } finally { context.fill(0); }
      }
      const checkResponse = () => {
        processing.check();
        this.store.assertCurrent(handle, r, frozen);
        if (this.retention && retentionId) this.retention.journal.ready(retentionId, this.store.env.wall());
        processing.check();
      };
      await this.receive(handle, r, frozen, response, inspectionSecrets, signal, reservation, timing, checkResponse, retentionId, !!paymentHeader);
      if (this.retention && retentionId)
        await this.retention.cleanup(retentionId).catch(() => {});
      return response.status;
    } finally { processing.close(); }
  }
  async recover(handle: ClientHandle, r: RequestRecord, frozen: FrozenRequest, id: string,
    signal: AbortSignal, reservation: ResponseReservation): Promise<void> {
    requireWallet(this.retention, "RESPONSE_RETENTION_UNAVAILABLE", "Retained response storage is unavailable.");
    const check = () => {
      requireWallet(!signal.aborted, "WALLET_OPERATION_ABORTED", "The request was canceled.");
      this.store.assertRetainedCurrent(handle, r, frozen);
      this.retention!.journal.ready(id, this.store.env.wall());
    };
    const saved = await this.retention.read(id, check);
    try {
      const context = decodeRetainedHttpContext(saved.context);
      const record = this.retention.journal.ready(id, this.store.env.wall());
      requireWallet(context.requestId === r.requestId && context.phase === record.phase &&
        (context.phase === "paid" ? context.paymentIntentId === r.paymentIntentId : !r.paymentIntentId),
      "RESPONSE_RETENTION_UNAVAILABLE", "The retained HTTP phase or payment identity differs.");
      check();
      await this.receive(handle, r, frozen, { status: context.status, headers: context.headers, body: saved.raw },
        context.secrets, signal, reservation, context, check, id, context.phase === "paid");
    } finally { saved.raw.fill(0); saved.context.fill(0); }
    await this.retention.cleanup(id).catch(() => {});
  }
  private async receive(
    handle: ClientHandle,
    r: RequestRecord,
    frozen: FrozenRequest,
    response: HttpResult,
    secrets: string[],
    signal: AbortSignal,
    reservation: ResponseReservation,
    timing: Pick<RetainedHttpContext, "receivedAt" | "receivedMonotonic" | "clockId">,
    checkCurrent = () => this.store.assertCurrent(handle, r, frozen),
    retentionId?: string,
    paid = false,
  ): Promise<void> {
    const { receivedAt, receivedMonotonic, clockId } = timing;
    checkCurrent();
    requireWallet(!signal.aborted, "WALLET_OPERATION_ABORTED", "The request was canceled.");
    requireWallet(
      response.body.byteLength <= RESPONSE_LIMIT,
      "HTTP_RESPONSE_TOO_LARGE",
      "The response exceeds its limit.",
    );
    const sanitized = await abortable(
      this.store.env.inspectResponse(
        response.headers,
        response.body,
        secrets,
        signal,
      ),
      signal,
    );
    checkCurrent();
    requireWallet(!signal.aborted, "WALLET_OPERATION_ABORTED", "The request was canceled.");
    requireWallet(
      sanitized.body.length <= RESPONSE_LIMIT,
      "HTTP_RESPONSE_TOO_LARGE",
      "The response exceeds its limit.",
    );
    const responseRef = await reservation.put(sanitized.body);
    let quote: StoredQuote | undefined, diagnosticCode: string | undefined;
    if (response.status === 402)
      try {
        quote = parseQuote(
          response.headers["payment-required"],
          frozen.url,
          receivedAt,
          receivedMonotonic,
          clockId,
          undefined, this.store.ctx.paymentNetwork,
        );
      } catch (error) {
        diagnosticCode = error instanceof WalletError ? error.code : "X402_INVALID_CHALLENGE";
      }
    const quoteRef = quote ? await this.store.putJson(quote, reservation) : undefined;
    let txHash: string | undefined;
    const claim = response.headers["payment-response"];
    if (claim && claim.length <= 8192)
      try {
        const parsed = JSON.parse(Buffer.from(claim, "base64").toString());
        if (parsed.network === this.store.ctx.paymentNetwork && /^0x[0-9a-f]{64}$/i.test(parsed.transaction))
          txHash = parsed.transaction.toLowerCase();
      } catch {
        /* A merchant claim is not chain evidence. */
      }
    await this.store.update(r.requestId, (record) => {
      checkCurrent();
      requireWallet(!signal.aborted, "WALLET_OPERATION_ABORTED", "The request was canceled.");
      record.transportStatus = record.canceled ? "canceled" : "completed";
      record.httpStatus = response.status;
      record.responseHeaders = sanitized.headers;
      record.sensitiveRedacted = sanitized.redacted;
      record.responseRef = responseRef;
      if (retentionId) record.responseRetentionId = retentionId;
      record.bodyRef = `wallet-response://requests/${r.requestId}/body`;
      record.byteLength = sanitized.body.length;
      record.sha256 = byteDigest(sanitized.body);
      if (paid && r.paymentIntentId && response.status === 402) {
        record.signedChallengeValid = !!quoteRef;
        if (!quoteRef) delete record.quoteRef;
      }
      if (quoteRef) {
        record.quoteRef = quoteRef;
        record.amountAtomic = quote!.selected.amount;
        record.network = quote!.selected.network;
        if (!record.paymentIntentId) record.paymentStatus = "quoted";
      }
      if (paid && txHash && record.paymentIntentId) record.transactionHash = txHash;
      if (diagnosticCode) record.diagnosticCode = diagnosticCode;
      else delete record.diagnosticCode;
      checkCurrent();
      requireWallet(!signal.aborted, "WALLET_OPERATION_ABORTED", "The request was canceled.");
    });
    if (paid && txHash && r.paymentIntentId && !signal.aborted)
      try {
        await this.reconciliation.settle(r.paymentIntentId, txHash, signal);
      } catch {
        /* Preserve the HTTP result independently of unverified payment. */
      }
  }
}
