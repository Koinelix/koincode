/**
 * Prevents an automation operation from overlapping a sensitive local window.
 * Callers must include every operation that can observe or control the desktop,
 * including previews, and must not detach native work from the returned promise.
 */
export class DesktopSensitiveUiGate {
  private blocked = false;
  private readonly active = new Set<{
    controller: AbortController;
    done: Promise<void>;
    finish: () => void;
  }>();

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.blocked) throw new Error("Sensitive user interaction is active.");
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry = { controller: new AbortController(), done, finish };
    this.active.add(entry);
    try {
      const result = await operation(entry.controller.signal);
      entry.controller.signal.throwIfAborted();
      return result;
    } finally {
      this.active.delete(entry);
      entry.finish();
    }
  }

  /** The window may be shown only after this resolves; release it after hiding. */
  async enter(interrupt: () => Promise<void>, timeoutMs = 5000): Promise<() => void> {
    if (this.blocked) throw new Error("Sensitive user interaction is already active.");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
      throw new Error("Invalid sensitive interaction timeout.");
    }
    this.blocked = true;
    const pending = [...this.active];
    for (const item of pending) item.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let enterFailed = false;
    let cleanupSettled = false;
    let safeToResume = false;
    const cleanup = (async () => {
      // A pending startup can create a backend after the first interruption.
      // Even a failed first interruption must drain callers and close again.
      const first = await Promise.allSettled([
        Promise.resolve().then(interrupt),
        ...pending.map((item) => item.done),
      ]);
      const second = await Promise.allSettled([Promise.resolve().then(interrupt)]);
      // An unconfirmed final close must not be forgotten, even if the backend
      // has already removed its local handle. A fresh task or UI is unsafe.
      safeToResume = [...first, ...second].every((item) => item.status === "fulfilled");
      const failure = [...first, ...second].find((item) => item.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })().finally(() => {
      cleanupSettled = true;
      if (enterFailed && safeToResume) this.blocked = false;
    });
    try {
      await Promise.race([
        cleanup,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Automation did not stop in time.")),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      // A timed-out cleanup still owns the old backend. Do not admit a new
      // task until all late stops and callers have actually settled.
      enterFailed = true;
      if (cleanupSettled && safeToResume) this.blocked = false;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.blocked = false;
    };
  }
}
