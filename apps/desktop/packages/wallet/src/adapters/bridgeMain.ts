#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { runWalletStdioBridge } from "./stdioBridge.js";
async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  const credentials = createReadStream("", { fd: 3, autoClose: true });
  const timer = setTimeout(
    () => credentials.destroy(new Error("Credential pipe timed out.")),
    5000,
  );
  try {
    for await (const chunk of credentials) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 4096) throw new Error("Credential pipe exceeds its bound.");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    let value: { socketPath: string; clientId: string; token: string };
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } finally {
      bytes.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
    if (
      !value ||
      typeof value.socketPath !== "string" ||
      typeof value.clientId !== "string" ||
      typeof value.token !== "string"
    )
      throw new Error("Invalid credential pipe.");
    await runWalletStdioBridge({ ...value, stdin: process.stdin, stdout: process.stdout });
  } finally {
    clearTimeout(timer);
    credentials.destroy();
  }
}
main().catch(() => {
  process.stderr.write("The authenticated wallet bridge is unavailable.\n");
  process.exitCode = 1;
});
