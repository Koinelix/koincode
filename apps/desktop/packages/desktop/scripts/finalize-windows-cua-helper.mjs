import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getCurrentFuseWire, FuseV1Options } from "@electron/fuses";
import { FuseState } from "@electron/fuses/dist/constants.js";

/** Run after Windows executable resources/signing; Native pins must cover final bytes. */
export async function finalizeWindowsPackagedComputerUseHelper(context) {
  if (context.electronPlatformName !== "win32" || context.arch !== 1) {
    throw new Error("[windows-cua-helper] Local packaged Computer Use requires Windows x64");
  }
  const root = resolve(context.appOutDir);
  const executable = join(root, `${context.packager.appInfo.productFilename}.exe`);
  const archive = join(root, "resources/app.asar");
  const runtime = join(root, "fcode-agent-runtime.exe");
  const [guiFuses, runtimeFuses] = await Promise.all([getCurrentFuseWire(executable), getCurrentFuseWire(runtime)]);
  if (guiFuses[FuseV1Options.RunAsNode] !== FuseState.DISABLE ||
    guiFuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable] !== FuseState.DISABLE ||
    guiFuses[FuseV1Options.EnableNodeCliInspectArguments] !== FuseState.DISABLE ||
    guiFuses[FuseV1Options.OnlyLoadAppFromAsar] !== FuseState.ENABLE ||
    runtimeFuses[FuseV1Options.RunAsNode] !== FuseState.ENABLE) {
    throw new Error("[windows-cua-helper] Packaged GUI and Agent runtime roles are not isolated");
  }
  const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const parentHash = hash(executable);
  const archiveHash = hash(archive);
  execFileSync(process.execPath, [resolve(import.meta.dirname, "build-windows-cua-helper.mjs"),
    "--packaged-host-root", root, "--host-executable", executable], {
    cwd: resolve(import.meta.dirname, ".."), windowsHide: true, stdio: "inherit",
  });
  const resources = join(root, "resources/cua-helper/windows-x64");
  const manifest = JSON.parse(readFileSync(join(resources, "capability.json"), "utf8"));
  if (manifest.available !== true || manifest.hostRole !== "electron-packaged" ||
    manifest.signing !== "packaged-hash" || manifest.reason !== "packaged_local" || manifest.leaseTestScope ||
    manifest.parentImageSha256 !== parentHash || manifest.hostEntrySha256 !== archiveHash ||
    manifest.helperSha256 !== hash(join(resources, "fcode-cua-helper.exe")) ||
    hash(executable) !== parentHash || hash(archive) !== archiveHash) {
    throw new Error("[windows-cua-helper] Final packaged native identity does not match the application");
  }
  console.log("[windows-cua-helper] Final packaged native identity verified");
}
