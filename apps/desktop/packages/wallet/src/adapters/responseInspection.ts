import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WalletError, requireWallet } from "../domain/errors.js";
import { MAX_CONCURRENT_HTTP_STAGES, RESPONSE_LIMIT } from "../domain/requestValidation.js";
import type { RequestEnvironment } from "../app/requestPorts.js";

let activeInspectors = 0;
type Result = Awaited<ReturnType<RequestEnvironment["inspectResponse"]>>;
export const inspectResponse: RequestEnvironment["inspectResponse"] = async (
  headers,
  body,
  secrets,
  signal,
) => {
  requireWallet(!signal.aborted, "WALLET_OPERATION_ABORTED", "The request was canceled.");
  requireWallet(
    body.byteLength <= RESPONSE_LIMIT,
    "HTTP_RESPONSE_TOO_LARGE",
    "The response exceeds its limit.",
  );
  requireWallet(
    activeInspectors < MAX_CONCURRENT_HTTP_STAGES,
    "RESPONSE_INSPECTION_BUSY",
    "Response inspection capacity is unavailable.",
  );
  activeInspectors++;
  let child: ReturnType<typeof fork>;
  let copy: Uint8Array | undefined;
  try {
    copy = Uint8Array.from(body);
    child = fork(fileURLToPath(new URL("./response-worker.mjs", import.meta.url)), [], {
      execArgv: ["--max-old-space-size=192", "--max-semi-space-size=16"],
      // Electron's existing bundled Node mode is also used by the desktop Agent.
      // Release trust and fuse policy must validate this executable separately.
      env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch {
    activeInspectors--;
    copy?.fill(0);
    throw new WalletError("RESPONSE_INSPECTION_FAILED", "Response inspection could not start.");
  }
  return new Promise<Result>((resolve, reject) => {
    let stopping = false;
    let settled = false;
    let failure: WalletError | undefined;
    let result: Result | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const complete = (forced?: WalletError) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      copy?.fill(0);
      const error =
        forced ??
        failure ??
        (signal.aborted
          ? new WalletError("WALLET_OPERATION_ABORTED", "The request was canceled.")
          : undefined);
      if (error) {
        result?.body.fill(0);
        reject(error);
      } else resolve(result!);
    };
    const stop = (error?: WalletError, value?: Result) => {
      if (stopping) {
        value?.body.fill(0);
        return;
      }
      stopping = true;
      failure = error;
      result = value;
      clearTimeout(timer);
      stopTimer = setTimeout(
        () =>
          complete(
            new WalletError(
              "RESPONSE_INSPECTION_FAILED",
              "Response inspection did not stop safely.",
            ),
          ),
        1000,
      );
      try {
        child.kill("SIGKILL");
      } catch {
        /* A close event must prove termination. */
      }
    };
    const abort = () =>
      stop(new WalletError("WALLET_OPERATION_ABORTED", "The request was canceled."));
    const timer = setTimeout(
      () => stop(new WalletError("RESPONSE_INSPECTION_TIMEOUT", "Response inspection timed out.")),
      5000,
    );
    signal.addEventListener("abort", abort, { once: true });
    child.once("message", (message: { ok?: boolean; result?: Result }) => {
      const value = message?.result;
      if (
        message?.ok === true &&
        value &&
        value.body instanceof Uint8Array &&
        value.body.byteLength <= RESPONSE_LIMIT &&
        typeof value.redacted === "boolean" &&
        value.headers &&
        Object.keys(value.headers).length <= 5 &&
        Object.values(value.headers).every(
          (item) => typeof item === "string" && item.length <= 2048,
        )
      ) {
        stop(undefined, value);
      } else stop(new WalletError("RESPONSE_INSPECTION_FAILED", "Response inspection failed."));
    });
    child.once("error", () =>
      stop(new WalletError("RESPONSE_INSPECTION_FAILED", "Response inspection failed.")),
    );
    child.once("close", () => {
      activeInspectors--;
      clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      if (!stopping)
        failure = new WalletError("RESPONSE_INSPECTION_FAILED", "Response inspection stopped.");
      complete();
    });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      child.send(
        {
          moduleUrl: new URL(
            import.meta.url.endsWith(".ts") ? "./inspectResponseJob.ts" : "./inspectResponseJob.js",
            import.meta.url,
          ).href,
          job: { headers, body: copy, secrets },
        },
        (error) => {
          copy?.fill(0);
          if (error)
            stop(new WalletError("RESPONSE_INSPECTION_FAILED", "Response inspection failed."));
        },
      );
    } catch {
      stop(new WalletError("RESPONSE_INSPECTION_FAILED", "Response inspection failed."));
    }
  });
};
