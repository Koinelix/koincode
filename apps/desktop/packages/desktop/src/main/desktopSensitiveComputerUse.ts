import { CuaControlError } from "@fcode/cua/control-contract";
import type { InvocationScope } from "@fcode/cua/invocation-registry";
import type {
  ComputerUseHostCommand,
  ComputerUseHostResult,
  ComputerUseIntentRequest,
  ComputerUsePanelRequest,
  ComputerUsePanelState,
} from "@fcode/shared";
import { DesktopSensitiveUiGate } from "./desktopSensitiveUiGate.js";

type Context = { sessionId: string; turnId: string; toolCallId: string; runtimeScope: string };
type Control = {
  prepareIntent(ownerId: string, input: ComputerUseIntentRequest, signal?: AbortSignal): Promise<{ token: string }>;
  panelAction(ownerId: string, request: ComputerUsePanelRequest): Promise<ComputerUsePanelState>;
  focusCredentialUi(ownerId: string, sessionId: string): Promise<void>;
  handleHostCommand(scope: Omit<InvocationScope, "workspaceKey">, command: ComputerUseHostCommand): Promise<ComputerUseHostResult>;
  execute(scope: InvocationScope, context: Context, action: unknown, signal?: AbortSignal): Promise<unknown>;
  setEnabled(value: boolean): Promise<void>;
};

/** Backend stop failures are not swallowed, even if cleanup succeeds. */
export async function stopComputerUseForSensitiveUi(options: {
  stops: Array<Promise<void> | undefined>;
  stopAuthority(): Promise<unknown>;
  clear(): void;
  close(): Array<Promise<void> | undefined>;
}): Promise<void> {
  const stopped = await Promise.allSettled(options.stops);
  const authority = await Promise.allSettled([options.stopAuthority()]);
  options.clear();
  const closed = await Promise.allSettled(options.close());
  if ([...stopped, ...authority, ...closed].some((result) => result.status === "rejected")) {
    throw new CuaControlError("backend_cleanup_failed", "Computer Use could not be stopped for the private window.");
  }
}

/** Main-only control. No renderer or model receives the sensitive UI lease. */
export function protectComputerUse<T extends Control>(control: T, interrupt: () => Promise<void>) {
  const gate = new DesktopSensitiveUiGate();
  const canceled = () => new CuaControlError("canceled", "Computer Use was stopped for a private user interaction.");
  const run = <R>(work: (signal: AbortSignal) => Promise<R>) =>
    gate.run(async (signal) => {
      try { return await work(signal); }
      catch (error) { if (signal.aborted) throw canceled(); throw error; }
    }).catch((error: unknown) => {
      if (error instanceof Error && (error.name === "AbortError" || error.message === "Sensitive user interaction is active.")) throw canceled();
      throw error;
    });

  return {
    ...control,
    enterSensitiveUi: (timeoutMs?: number) => gate.enter(interrupt, timeoutMs),
    prepareIntent: (ownerId: string, input: ComputerUseIntentRequest) =>
      run((signal) => control.prepareIntent(ownerId, input, signal)),
    panelAction: (ownerId: string, request: ComputerUsePanelRequest) =>
      run(() => control.panelAction(ownerId, request)),
    focusCredentialUi: (ownerId: string, sessionId: string) =>
      run(() => control.focusCredentialUi(ownerId, sessionId)),
    handleHostCommand: async (scope: Omit<InvocationScope, "workspaceKey">, command: ComputerUseHostCommand): Promise<ComputerUseHostResult> => {
      try { return await run(() => control.handleHostCommand(scope, command)); }
      catch (error) {
        if (!(error instanceof CuaControlError) || error.code !== "canceled") throw error;
        return { ok: false, error: { code: error.code, message: error.message } };
      }
    },
    execute: (scope: InvocationScope, context: Context, action: unknown, signal?: AbortSignal) =>
      run((gateSignal) => control.execute(scope, context, action,
        signal ? AbortSignal.any([signal, gateSignal]) : gateSignal)) as ReturnType<T["execute"]>,
    setEnabled: (value: boolean) => run(() => control.setEnabled(value)),
  };
}
