import { REMOTE_HOST_LIMITS, RemoteHostError } from "@fcode/shared";

interface ScheduledRemoteOperation {
  callKey: string;
  endpointKey: string;
  write: boolean;
  signal?: AbortSignal;
  start(): void;
  reject(error: unknown): void;
  detach(): void;
}

/** One instance is owned by the data-root broker, including management connection tests. */
export class RemoteOperationScheduler {
  private readonly pending: ScheduledRemoteOperation[] = [];
  private readonly calls = new Map<string, number>();
  private readonly endpoints = new Map<string, { reads: number; write: boolean }>();
  private active = 0;
  private closed = false;

  run<T>(input: { callKey: string; endpointKey: string; write: boolean; signal?: AbortSignal }, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new RemoteHostError("canceled", "The broker scheduler has stopped.", "execution"));
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = this.pending.indexOf(item);
        if (index < 0) return;
        this.pending.splice(index, 1); item.detach();
        reject(new RemoteHostError("canceled", "The queued remote operation was canceled.", "execution"));
        this.drain();
      };
      const item: ScheduledRemoteOperation = { ...input, reject, detach: () => input.signal?.removeEventListener("abort", abort), start: () => {
        item.detach();
        this.active++;
        this.calls.set(input.callKey, (this.calls.get(input.callKey) ?? 0) + 1);
        const endpoint = this.endpoints.get(input.endpointKey) ?? { reads: 0, write: false };
        if (input.write) endpoint.write = true; else endpoint.reads++;
        this.endpoints.set(input.endpointKey, endpoint);
        void Promise.resolve().then(() => { input.signal?.throwIfAborted(); return operation(); }).then(resolve, reject).finally(() => {
          this.active--;
          const count = (this.calls.get(input.callKey) ?? 1) - 1;
          if (count) this.calls.set(input.callKey, count); else this.calls.delete(input.callKey);
          if (input.write) endpoint.write = false; else endpoint.reads--;
          if (!endpoint.write && !endpoint.reads) this.endpoints.delete(input.endpointKey);
          this.drain();
        });
      } };
      this.pending.push(item);
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort(); else this.drain();
    });
  }

  get snapshot(): { active: number; queued: number } { return { active: this.active, queued: this.pending.length }; }

  dispose(): void {
    this.closed = true;
    for (const item of this.pending.splice(0)) { item.detach(); item.reject(new RemoteHostError("canceled", "The broker scheduler has stopped.", "execution")); }
  }

  private drain(): void {
    if (this.closed) return;
    for (let index = 0; index < this.pending.length && this.active < REMOTE_HOST_LIMITS.globalConcurrency;) {
      const item = this.pending[index]!;
      const endpoint = this.endpoints.get(item.endpointKey);
      const earlierWriter = this.pending.slice(0, index).some((other) => other.endpointKey === item.endpointKey && other.write);
      const blocked = (this.calls.get(item.callKey) ?? 0) >= REMOTE_HOST_LIMITS.perCallConcurrency ||
        endpoint?.write || (item.write ? Boolean(endpoint?.reads) : (endpoint?.reads ?? 0) >= REMOTE_HOST_LIMITS.hostReadConcurrency || earlierWriter);
      if (blocked) { index++; continue; }
      this.pending.splice(index, 1); item.start();
    }
  }
}
