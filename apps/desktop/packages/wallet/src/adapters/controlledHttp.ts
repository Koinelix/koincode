import { MAX_CONCURRENT_HTTP_STAGES } from "../domain/requestValidation.js";
import { httpStageTimeout } from "../domain/requestTiming.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { readHttpResponseBody } from "./httpResponseBody.js";
import type { ControlledHttp, HttpResult, HttpContextCheck, HttpContextStage } from "../app/requestPorts.js";
import type { FrozenRequest } from "../domain/requestModel.js";
import { requireWallet, WalletError } from "../domain/errors.js";
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6 || address.includes("%")) return false;
  const groups = address.toLowerCase().split(":");
  const first = parseInt(groups[0] || "0", 16),
    second = parseInt(groups[1] || "0", 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x0200 || second === 0x0db8))
  );
}
export function targetUrl(value: string, localTest: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WalletError("INVALID_URL", "A valid absolute URL is required.");
  }
  requireWallet(
    !url.username && !url.password && !url.hash && url.href.length <= 8192,
    "INVALID_URL",
    "URL credentials and fragments are not allowed.",
  );
  const test = localTest && url.origin === "http://127.0.0.1:8080";
  requireWallet(
    test || (url.protocol === "https:" && (url.port === "" || url.port === "443")),
    "UNSAFE_TARGET",
    "Only HTTPS on the approved port is allowed.",
  );
  return url;
}
export class PinnedHttp implements ControlledHttp {
  #active = 0;
  private constructor(private readonly localTest: boolean) {}
  static publicInternet(): PinnedHttp {
    return new PinnedHttp(false);
  }
  static baseSepoliaLocalTest(): PinnedHttp {
    return new PinnedHttp(true);
  }
  async send(
    frozen: FrozenRequest,
    secretHeaders: Readonly<Record<string, string>>,
    caller: AbortSignal,
    checkContext: HttpContextCheck,
  ): Promise<HttpResult> {
    requireWallet(this.#active < MAX_CONCURRENT_HTTP_STAGES, "HTTP_BUSY", "The HTTP queue is full.");
    this.#active++;
    try {
      const url = targetUrl(frozen.url, this.localTest),
        test = url.origin === "http://127.0.0.1:8080";
      const signal = AbortSignal.any([caller, AbortSignal.timeout(httpStageTimeout(frozen))]);
      const check = (stage: HttpContextStage) => {
        requireWallet(!signal.aborted, "WALLET_OPERATION_ABORTED", "The request was canceled.");
        const decision = typeof checkContext === "function" ? checkContext(stage) : false;
        if (decision !== true) {
          // A misconfigured asynchronous guard is denied; observe rejection to avoid a process crash.
          void Promise.resolve(decision).catch(() => {});
        }
        requireWallet(
          decision === true,
          "OUTBOUND_PERMISSION_REQUIRED",
          "The trusted request context is no longer current.",
        );
        requireWallet(!signal.aborted, "WALLET_OPERATION_ABORTED", "The request was canceled.");
      };
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (!test) check("dns");
      const answers = test
        ? [{ address: "127.0.0.1", family: 4 }]
        : await Promise.race([
            lookup(host, { all: true, verbatim: true }),
            new Promise<never>((_, reject) => {
              const timer = setTimeout(
                () => reject(new WalletError("DNS_UNAVAILABLE", "DNS lookup exceeded its limit.")),
                5000,
              );
              timer.unref();
            }),
          ]);
      requireWallet(
        !signal.aborted &&
          answers.length > 0 &&
          answers.length <= 32 &&
          (test || answers.every((a) => publicAddress(a.address))),
        "UNSAFE_TARGET",
        "The target resolves to a forbidden or unavailable address.",
      );
      return await new Promise<HttpResult>((resolve, reject) => {
        let received: IncomingMessage | undefined;
        const fail = () => {
          if (received) {
            received.destroy(new Error("The HTTP transport failed."));
            return;
          }
          reject(
            new WalletError(
              "HTTP_UNKNOWN",
              "The HTTP outcome is unknown; do not automatically resend.",
            ),
          );
        };
        const send = test ? httpRequest : httpsRequest;
        check("connect");
        const request = send(
          url,
          {
            method: frozen.method,
            agent: false,
            signal,
            headers: {
              ...frozen.headers,
              ...secretHeaders,
              "accept-encoding": "gzip, deflate, br",
              ...(frozen.body === null
                ? {}
                : { "content-length": String(Buffer.byteLength(frozen.body)) }),
            },
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, answers as never);
              else callback(null, answers[0]!.address, answers[0]!.family);
            },
          },
          (response) => {
            received = response;
            void (async () => {
              try {
                const headers: Record<string, string> = {};
                let count = 0;
                for (const [name, value] of Object.entries(response.headers))
                  if (typeof value === "string") {
                    count += name.length + value.length;
                    headers[name] = value;
                  }
                requireWallet(
                  count <= 32768,
                  "HTTP_RESPONSE_TOO_LARGE",
                  "Response headers exceed their limit.",
                );
                const body = await readHttpResponseBody(response, signal);
                resolve({ status: response.statusCode ?? 0, headers, body });
              } catch {
                response.destroy();
                request.destroy();
                reject(
                  new WalletError(
                    "HTTP_RESPONSE_INVALID",
                    "The complete response could not be safely decoded.",
                  ),
                );
              }
            })();
          },
        );
        request.on("error", fail);
        try {
          check("submit");
          request.end(frozen.body ?? undefined);
        } catch (error) {
          try {
            request.destroy();
          } catch {
            // A failed destroy cannot prove the connection or HTTP effect stopped.
          }
          reject(error);
        }
      });
    } finally {
      this.#active--;
    }
  }
}
