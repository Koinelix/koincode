import { execFile } from "node:child_process";
import { request } from "node:https";
import { promisify } from "node:util";
import { record, string, type HistoryRecord } from "./historyFiles.js";

const run = promisify(execFile);
const PROCESS_TIMEOUT_MS = 10_000;
const API_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const STEP_PAGE_SIZE = 1000;
interface Endpoint {
  port: number;
  token: string;
}

/** Credentials from process arguments are scoped to this local read and never logged. */
export async function antigravityEndpoints(): Promise<Endpoint[]> {
  const options = { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
  const processes: Array<{ pid: number; command: string }> = [];
  if (process.platform === "win32") {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @(Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%'\" | Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid -eq $currentSid } | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress",
      ],
      options,
    );
    const parsed: unknown = JSON.parse(stdout || "[]");
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const row = record(item);
      processes.push({ pid: Number(row.ProcessId), command: string(row.CommandLine) });
    }
  } else {
    const { stdout } = await run(
      "ps",
      ["-u", String(process.getuid?.()), "-o", "pid=,args="],
      options,
    );
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match) processes.push({ pid: Number(match[1]), command: match[2]! });
    }
  }
  const endpoints: Endpoint[] = [];
  for (const processInfo of processes) {
    if (!/language_server/i.test(processInfo.command) || !/antigravity/i.test(processInfo.command))
      continue;
    const token = processInfo.command
      .match(/--csrf_token(?:=|\s+)(?:"([^"]+)"|(\S+))/)
      ?.slice(1)
      .find(Boolean);
    if (!token || !Number.isSafeInteger(processInfo.pid) || processInfo.pid <= 0) continue;
    let ports: number[];
    if (process.platform === "win32") {
      const { stdout } = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `@(Get-NetTCPConnection -State Listen -OwningProcess ${processInfo.pid} -ErrorAction SilentlyContinue | Where-Object LocalAddress -eq '127.0.0.1' | Select-Object -ExpandProperty LocalPort) | ConvertTo-Json -Compress`,
        ],
        options,
      );
      const parsed: unknown = JSON.parse(stdout || "[]");
      ports = (Array.isArray(parsed) ? parsed : [parsed]).map(Number);
    } else {
      const { stdout } = await run(
        "lsof",
        ["-Pan", "-p", String(processInfo.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
        options,
      );
      ports = [...stdout.matchAll(/^n127\.0\.0\.1:(\d+)$/gm)].map((match) => Number(match[1]));
    }
    for (const port of ports) if (port > 0 && port <= 65535) endpoints.push({ port, token });
  }
  return endpoints;
}

export function callAntigravityReadApi(
  endpoint: Endpoint,
  method: "GetCascadeTrajectorySteps" | "GetAllCascadeTrajectories",
  params: HistoryRecord,
): Promise<HistoryRecord> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = request(
      {
        hostname: "127.0.0.1",
        port: endpoint.port,
        method: "POST",
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        // The identified local server uses a self-signed certificate. This does not alter global TLS.
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": endpoint.token,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error("source_response_too_large"));
          else chunks.push(chunk);
        });
        response.on("error", () => reject(new Error("antigravity_local_api_failed")));
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new Error("antigravity_local_api_failed"));
          try {
            resolve(record(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          } catch {
            reject(new Error("source_invalid_response"));
          }
        });
      },
    );
    req.setTimeout(API_TIMEOUT_MS, () => req.destroy(new Error("source_read_timeout")));
    req.on("error", () => reject(new Error("antigravity_local_api_failed")));
    req.end(body);
  });
}

export async function readAntigravitySteps(sessionId: string): Promise<HistoryRecord[]> {
  const endpoints = await antigravityEndpoints();
  for (const endpoint of endpoints) {
    try {
      const steps: HistoryRecord[] = [];
      for (let startIndex = 0; ; startIndex += STEP_PAGE_SIZE) {
        const page = await callAntigravityReadApi(endpoint, "GetCascadeTrajectorySteps", {
          cascadeId: sessionId,
          startIndex,
          endIndex: startIndex + STEP_PAGE_SIZE,
        });
        if (!Array.isArray(page.steps)) break;
        steps.push(...page.steps.map(record));
        if (page.steps.length < STEP_PAGE_SIZE) break;
      }
      if (steps.length) return steps;
    } catch {
      /* Another instance may own this historical conversation. */
    }
  }
  throw new Error("antigravity_open_required");
}
