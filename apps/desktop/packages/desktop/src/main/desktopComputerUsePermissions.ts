import { CuaControlError } from "@fcode/cua/control-contract";

type MacPermissions = { accessibility: boolean; screenRecording: boolean };
const RENEW_PERMISSION_GUIDANCE =
  "If the switches are already enabled after an upgrade, quit KoinCode, remove its old entries, add the current KoinCode.app in System Settings, then restart KoinCode and explicitly start a new Computer Use task.";
const PERMISSION_SETTINGS = "System Settings > Privacy & Security";

function missingPermissions(status: MacPermissions) {
  return [!status.accessibility && "Accessibility", !status.screenRecording && "Screen Recording"]
    .filter(Boolean)
    .join(" and ");
}

export function computerUsePermissionError(status?: MacPermissions) {
  const message = status
    ? `macOS has not granted ${missingPermissions(status)} to the current KoinCode application.`
    : "macOS has not granted the required Computer Use permissions to the current KoinCode application.";
  return new CuaControlError(
    "permission_required",
    `${message} Check KoinCode in ${PERMISSION_SETTINGS}. ${RENEW_PERMISSION_GUIDANCE}`,
    {
      stage: "native",
      reason: "permission_required",
      retryable: false,
      requiresUserAction: true,
    },
  );
}

/** An enabled switch can belong to an older ad-hoc build; only Native status proves the current grant. */
export async function requireComputerUsePermissions<T extends MacPermissions>(
  status: T,
  ports: {
    signal: AbortSignal;
    beforePermissions(): void;
    confirm(prompt: { message: string; detail: string }): Promise<boolean>;
    requestPermissions(value: MacPermissions, signal: AbortSignal): Promise<T>;
  },
): Promise<T> {
  ports.signal.throwIfAborted();
  if (status.accessibility && status.screenRecording) return status;
  ports.beforePermissions();
  const confirmed = await ports.confirm({
    message: `Allow ${missingPermissions(status)} for KoinCode.`,
    detail: `macOS may open ${PERMISSION_SETTINGS}. ${RENEW_PERMISSION_GUIDANCE} Only selected windows or an explicitly confirmed desktop will be observed and controlled.`,
  });
  ports.signal.throwIfAborted();
  if (!confirmed) throw new CuaControlError("not_authorized");
  const checked = await ports.requestPermissions(
    { accessibility: true, screenRecording: true },
    ports.signal,
  );
  ports.signal.throwIfAborted();
  if (!checked.accessibility || !checked.screenRecording) throw computerUsePermissionError(checked);
  return checked;
}
