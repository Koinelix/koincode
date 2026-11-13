import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

/** This builder never touches the legacy wallet process, assets or readiness. */
export class DesktopGeneralWalletDevelopmentRuntime {
  private pending?: Promise<void>;
  private child?: ChildProcess;
  private disposed = false;
  constructor(private readonly options: { packaged: boolean; appRoot: string; environment: string }) {}

  prepare(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("GENERAL_PROCESS_UNAVAILABLE"));
    if (this.options.packaged) return Promise.resolve();
    if (this.pending) return this.pending;
    const work = new Promise<void>((resolveWork, rejectWork) => {
      const child = spawn(process.execPath, [resolve(this.options.appRoot, "scripts/prepare-general-wallet-development.mjs")], {
        cwd: this.options.appRoot, detached: process.platform !== "win32", stdio: "ignore",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FCODE_ENV: this.options.environment },
      });
      this.child = child;
      let expired = false, settled = false;
      const timer = setTimeout(() => { expired = true; this.stopChild(); }, 160_000);
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.child === child) this.child = undefined;
        if (ok && !expired && !this.disposed) resolveWork();
        else rejectWork(new Error("GENERAL_PROCESS_UNAVAILABLE"));
      };
      child.once("error", () => finish(false));
      child.once("close", (code) => finish(code === 0));
    });
    this.pending = work;
    void work.catch(() => { if (this.pending === work) this.pending = undefined; });
    return work;
  }

  dispose(): void { this.disposed = true; this.stopChild(); }

  private stopChild(): void {
    const child = this.child;
    if (!child) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill();
    } catch { /* owned build is already gone */ }
  }
}
