import type { Writable } from "node:stream";

type LogSink = (...args: unknown[]) => void;
type LogStream = Pick<Writable, "on" | "destroyed" | "writableEnded" | "writable">;

/** A failed diagnostic stream must never take down the service process. */
function protectStream(stream: LogStream, sinks: LogSink[]): LogSink[] {
  let failed = false;
  // Keep the listener for the process lifetime: late errors must remain handled.
  stream.on("error", () => {
    failed = true;
  });
  return sinks.map((sink) => (...args: unknown[]) => {
    if (failed || stream.destroyed || stream.writableEnded || !stream.writable) return;
    try {
      sink(...args);
    } catch {
      // Never log this failure through the same broken diagnostic channel.
      failed = true;
    }
  });
}

export function createSafeHostConsole(
  stdout: LogStream,
  stderr: LogStream,
  raw: { log: LogSink; warn: LogSink; error: LogSink },
): { log: LogSink; warn: LogSink; error: LogSink } {
  const [log] = protectStream(stdout, [raw.log]);
  const [warn, error] = protectStream(stderr, [raw.warn, raw.error]);
  return { log: log!, warn: warn!, error: error! };
}
