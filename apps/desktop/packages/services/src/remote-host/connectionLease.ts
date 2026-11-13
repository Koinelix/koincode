import { RemoteHostError, type RemoteSftpPort, type RemoteSshConnection } from "@fcode/shared";

export interface RemoteConnectionLease { connection: RemoteSshConnection; redactionValues: string[]; release(): void }

/** A released or canceled task owns only its channels, never the shared SSH transport. */
export function sessionConnectionLease(physical: RemoteSshConnection, redactionValues: string[],
  check: () => void, returnConnection: () => void, signal?: AbortSignal): RemoteConnectionLease {
  let released = false;
  let files: Promise<RemoteSftpPort> | undefined;
  const opened = new Set<RemoteSftpPort>();
  const assertActive = () => {
    if (released) throw new RemoteHostError("canceled", "The SSH operation lease was released.");
    signal?.throwIfAborted(); check();
  };
  const closeFiles = () => {
    for (const file of opened) { try { file.close?.(); } catch { /* A failed channel close must not cancel another borrower. */ } }
    opened.clear();
  };
  const abort = () => closeFiles();
  signal?.addEventListener("abort", abort, { once: true });
  const release = () => {
    if (released) return; released = true;
    signal?.removeEventListener("abort", abort); closeFiles(); redactionValues.length = 0; returnConnection();
  };
  const connection: RemoteSshConnection = {
    isAlive: () => !released && !signal?.aborted && physical.isAlive?.() !== false,
    files: async () => {
      assertActive();
      files ??= physical.files().then((port) => {
        if (released || signal?.aborted) { port.close?.(); throw new RemoteHostError("canceled", "SFTP opened after its operation was canceled."); }
        opened.add(port); return port;
      });
      if (!signal) return files;
      return new Promise<RemoteSftpPort>((resolve, reject) => {
        const canceled = () => { signal.removeEventListener("abort", canceled); reject(signal.reason); };
        signal.addEventListener("abort", canceled, { once: true });
        if (signal.aborted) canceled();
        void files!.then((port) => { signal.removeEventListener("abort", canceled); resolve(port); },
          (error) => { signal.removeEventListener("abort", canceled); reject(error); });
      });
    },
    exec: (command, options) => {
      assertActive();
      return physical.exec(command, { ...options,
        signal: signal && options.signal && signal !== options.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options.signal });
    },
    close: release,
  };
  return { connection, redactionValues, release };
}
