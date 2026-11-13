import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import type { GeneralBalanceRpc } from "../app/generalBalances.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { publicAddress } from "./controlledHttp.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { consumeGeneralBroadcastPermit } from "./generalBroadcastCapability.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";

type Address = { address: string; family: number };
type ExchangeResult = { status: number; body: Uint8Array };
type TransportDependencies = {
  lookup(host: string): Promise<Address[]>;
  exchange(url: URL, addresses: Address[], body: string, signal: AbortSignal): Promise<ExchangeResult>;
};
const MAX_RESPONSE = 128 * 1024;
const READ_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getBalance", "eth_getCode", "eth_call"]);
const ESTIMATE_METHODS = new Set([...READ_METHODS, "eth_estimateGas"]);
const NONCE_METHODS = new Set(["eth_chainId", "eth_getTransactionCount"]);
const RECEIPT_METHODS = new Set(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
const BROADCAST_METHODS = new Set(["eth_chainId"]);
const FEE_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas"]);
const NONCE_HISTORY_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionCount"]);
// OS DNS lookups cannot always be canceled. Count them until they actually settle across this utility process.
let activeDns = 0;
let activeBroadcasts = 0;

function fail(code = "BALANCE_UNAVAILABLE"): never {
  throw new WalletError(code, "The network balance request could not be completed.");
}

function endpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return fail("RPC_ENDPOINT_INVALID"); }
  requireWallet(url.protocol === "https:" && !url.username && !url.password && !url.hash &&
    url.href.length <= 2048 && !url.search, "RPC_ENDPOINT_INVALID", "Invalid balance RPC endpoint.");
  return url;
}

async function exchange(url: URL, addresses: Address[], body: string, signal: AbortSignal): Promise<ExchangeResult> {
  return await new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: "POST", agent: false, signal,
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "content-length": Buffer.byteLength(body) },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, addresses as never);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
    }, (response) => {
      const encoding = response.headers["content-encoding"];
      if ((response.statusCode ?? 0) !== 200 || (encoding && encoding !== "identity")) {
        response.destroy();
        reject(new WalletError("BALANCE_UNAVAILABLE", "The network balance request could not be completed."));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) {
          response.destroy();
          reject(new WalletError("BALANCE_UNAVAILABLE", "The network balance request could not be completed."));
        } else chunks.push(Buffer.from(chunk));
      });
      response.once("error", () => reject(new WalletError("BALANCE_UNAVAILABLE", "The network balance request could not be completed.")));
      response.once("close", () => {
        if (!response.complete) reject(new WalletError("BALANCE_UNAVAILABLE", "The network balance request could not be completed."));
      });
      response.once("end", () => {
        if (!response.complete || signal.aborted) { reject(new WalletError("BALANCE_UNAVAILABLE", "The network balance request could not be completed.")); return; }
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks, size) });
      });
    });
    req.once("error", () => reject(new WalletError("BALANCE_UNAVAILABLE", "The network balance request could not be completed.")));
    req.end(body);
  });
}

const systemDependencies: TransportDependencies = {
  lookup: (host) => lookup(host, { all: true, verbatim: true }),
  exchange,
};

/** One instance belongs exclusively to the general-wallet utility, never the x402 runtime. */
export class GeneralRpcTransport implements GeneralBalanceRpc {
  private readonly url: URL;
  constructor(endpointUrl: string, private readonly dependencies: TransportDependencies = systemDependencies,
    private readonly purpose: "balance" | "estimate" | "nonce" | "nonce_history" | "receipt" | "broadcast" | "fee" = "balance") {
    requireWallet(purpose === "balance" || purpose === "estimate" || purpose === "nonce" || purpose === "nonce_history" ||
      purpose === "receipt" || purpose === "broadcast" || purpose === "fee", "RPC_METHOD_INVALID", "Invalid RPC purpose.");
    this.url = endpoint(endpointUrl);
  }

  async call(method: string, params: readonly unknown[], parent: AbortSignal): Promise<unknown> {
    requireWallet((this.purpose === "balance" ? READ_METHODS : this.purpose === "estimate" ? ESTIMATE_METHODS :
      this.purpose === "nonce" ? NONCE_METHODS : this.purpose === "nonce_history" ? NONCE_HISTORY_METHODS :
        this.purpose === "receipt" ? RECEIPT_METHODS : this.purpose === "fee" ? FEE_METHODS : BROADCAST_METHODS).has(method) && Array.isArray(params),
      "RPC_METHOD_INVALID", "Invalid balance RPC method.");
    return await this.request(method, params, parent);
  }

  /** The only send entry consumes a journal-issued permit after verifying the RPC chain. */
  async sendSigned(permit: object, preview: GeneralTransferPreview, riskId: string, raw: string, parent: AbortSignal): Promise<{
    status: "SUBMITTED" | "UNKNOWN"; transactionHash: string;
  }> {
    requireWallet(this.purpose === "broadcast" && !parent.aborted && activeBroadcasts < 2, "RPC_METHOD_INVALID", "Broadcast is unavailable.");
    const signal = AbortSignal.any([parent, AbortSignal.timeout(20000)]), pending = new Set<Promise<unknown>>();
    activeBroadcasts++;
    const bounded = async (work: Promise<unknown>): Promise<unknown> => {
      pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
      let abort = () => {};
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(new WalletError("GENERAL_BROADCAST_UNAVAILABLE", "The broadcast request stopped."));
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
      try { return await Promise.race([work, stopped]); } finally { signal.removeEventListener("abort", abort); }
    };
    try {
      const chain = await bounded(this.call("eth_chainId", [], signal)), network = generalNetwork(preview.networkId);
      requireWallet(typeof chain === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(chain) &&
        BigInt(chain) === BigInt(network.chainId) && !signal.aborted, "GENERAL_BROADCAST_UNAVAILABLE", "The broadcast network is unavailable.");
      const transactionHash = consumeGeneralBroadcastPermit(permit, preview, riskId, raw);
      try {
        const response = await bounded(this.request("eth_sendRawTransaction", [raw], signal));
        return { status: typeof response === "string" && response.toLowerCase() === transactionHash ? "SUBMITTED" : "UNKNOWN", transactionHash };
      } catch { return { status: "UNKNOWN", transactionHash }; }
    } finally {
      const release = () => { activeBroadcasts--; };
      if (pending.size) void Promise.allSettled(pending).then(release); else release();
    }
  }

  private async request(method: string, params: readonly unknown[], parent: AbortSignal): Promise<unknown> {
    let serialized: string;
    const id = randomUUID();
    try { serialized = JSON.stringify({ jsonrpc: "2.0", id, method, params }); }
    catch { return fail("RPC_METHOD_INVALID"); }
    requireWallet(Buffer.byteLength(serialized) <= 8192, "RPC_METHOD_INVALID", "Invalid balance RPC request.");
    const signal = AbortSignal.any([parent, AbortSignal.timeout(8000)]);
    if (signal.aborted) return fail("BALANCE_READ_CANCELED");
    const host = this.url.hostname.replace(/^\[|\]$/g, "");
    let addresses: Address[];
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
    else {
      if (activeDns >= 8) return fail("BALANCE_BUSY");
      activeDns++;
      const lookupPromise = Promise.resolve().then(() => this.dependencies.lookup(host)).finally(() => activeDns--);
      let onAbort: (() => void) | undefined;
      try {
        addresses = await Promise.race([lookupPromise, new Promise<never>((_, reject) => {
          onAbort = () => reject(new WalletError("BALANCE_READ_CANCELED", "The balance request was canceled."));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        })]);
      } catch (error) {
        if (signal.aborted) return fail("BALANCE_READ_CANCELED");
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        return fail(code === "ENOTFOUND" || code === "EAI_AGAIN" ? "BALANCE_DNS_UNAVAILABLE" : "BALANCE_UNAVAILABLE");
      }
      finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
    }
    requireWallet(Array.isArray(addresses) && addresses.length > 0 && addresses.length <= 32 &&
      addresses.every((answer) => answer && isIP(answer.address) === answer.family && publicAddress(answer.address)),
    "RPC_ENDPOINT_INVALID", "The RPC resolves to a forbidden network address.");
    if (signal.aborted) return fail("BALANCE_READ_CANCELED");
    let result: ExchangeResult;
    try { result = await this.dependencies.exchange(this.url, addresses, serialized, signal); }
    catch { return fail(signal.aborted ? "BALANCE_READ_CANCELED" : "BALANCE_UNAVAILABLE"); }
    if (signal.aborted) return fail("BALANCE_READ_CANCELED");
    requireWallet(result.status === 200 && result.body instanceof Uint8Array && result.body.byteLength <= MAX_RESPONSE,
      "BALANCE_UNAVAILABLE", "The network balance request could not be completed.");
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.body)); }
    catch { return fail(); }
    requireWallet(parsed && typeof parsed === "object" && !Array.isArray(parsed), "BALANCE_UNAVAILABLE", "Invalid balance RPC response.");
    const row = parsed as Record<string, unknown>;
    requireWallet(row.jsonrpc === "2.0" && row.id === id && Object.hasOwn(row, "result") && !Object.hasOwn(row, "error"),
      "BALANCE_UNAVAILABLE", "Invalid balance RPC response.");
    return row.result;
  }
}
