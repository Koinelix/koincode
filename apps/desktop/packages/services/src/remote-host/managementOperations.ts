import { REMOTE_HOST_LIMITS, RemoteHostError } from "@fcode/shared";

interface ManagementOperation {
  controller: AbortController;
  completion: Promise<unknown>;
}

/** Main supplies the window identity; Renderer cannot cancel another window's preparation. */
export class RemoteManagementOperations {
  private readonly clients = new Map<string, Map<string, ManagementOperation>>();
  private closed = false;

  run<T>(clientId: string, operationId: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new RemoteHostError("canceled", "The management dispatcher has stopped."));
    const operations = this.clients.get(clientId) ?? new Map<string, ManagementOperation>();
    if (operations.has(operationId)) return Promise.reject(new RemoteHostError("idempotency_conflict", "This management operation is already running."));
    if (operations.size >= 16 || [...this.clients.values()].reduce((count, items) => count + items.size, 0) >= 256) {
      return Promise.reject(new RemoteHostError("transfer_limit", "Too many management operations are pending."));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new RemoteHostError("connection_timeout", "The management operation exceeded its time limit.")), REMOTE_HOST_LIMITS.uploadMs);
    timer.unref();
    const completion = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return action(controller.signal); }).finally(() => {
      clearTimeout(timer); operations.delete(operationId);
      if (!operations.size) this.clients.delete(clientId);
    });
    operations.set(operationId, { controller, completion }); this.clients.set(clientId, operations);
    return completion;
  }

  cancel(clientId: string, operationId: string): boolean {
    const operation = this.clients.get(clientId)?.get(operationId);
    if (!operation) return false;
    operation.controller.abort(new RemoteHostError("canceled", "The management operation was canceled."));
    return true;
  }

  cancelClient(clientId: string): void {
    for (const operationId of this.clients.get(clientId)?.keys() ?? []) this.cancel(clientId, operationId);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const completions = [...this.clients.values()].flatMap((items) => [...items.values()].map((item) => item.completion));
    for (const clientId of this.clients.keys()) this.cancelClient(clientId);
    await Promise.allSettled(completions);
  }
}
