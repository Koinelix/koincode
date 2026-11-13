import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProtectedSqlite } from "./build-general-protected-sqlite.mjs";

export const PROTECTED_HOST_SDK = Object.freeze({ electron: "41.0.3", napi: 10,
  archiveSha256: "048c2db9c02fc37ec1f14a617a33a354088947cfb9198068189447c799e87287",
  files: Object.freeze({
    "node_api.h": "2d4560831e525b47b060ec8a0864ab73993df9e20215ce9f0fe7b24cd31af32a",
    "js_native_api.h": "eb03b6c850a1cfb593fd03e9e4251db8c82e9a6d9705bca91ac8d1a01fd7037c",
    "js_native_api_types.h": "7dd3663630849ada3a30d39abf42a192c9b6e7de63017cd32c41f5371a475b34",
    "node_api_types.h": "088766b3cf1f0cd9b292c361ad30f7a04e7cc6db35a20ca52c572c1adf9635e7",
    "node_version.h": "2fd13b3acd0972a7746d9628b9859bc4f3ba49e08ca909b89a13c94ed88f6f06",
  }) });
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export function verifyProtectedHostSdk(directory) {
  for (const [name, expected] of Object.entries(PROTECTED_HOST_SDK.files)) if (hash(join(directory, name)) !== expected)
    throw new Error("GENERAL_PROTECTED_HOST_SDK_INVALID");
}
export function buildProtectedHostBridge(headers = join(homedir(), ".electron-gyp", "41.0.3", "include", "node")) {
  if (process.platform !== "darwin") throw new Error("The protected Host native bridge currently requires macOS.");
  const source = fileURLToPath(new URL("../native/", import.meta.url));
  const workspace = fileURLToPath(new URL("../../../", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(workspace, "packages/desktop/package.json"), "utf8"));
  if (manifest.devDependencies?.electron !== PROTECTED_HOST_SDK.electron) throw new Error("GENERAL_PROTECTED_HOST_ELECTRON_INVALID");
  verifyProtectedHostSdk(headers); buildProtectedSqlite();
  const output = join(workspace, ".tmp/general-protected-bridge"); mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(output, "build-"));
  const options = { timeout: 30000, stdio: "pipe", env: { PATH: "/usr/bin:/bin" } };
  try {
    const sources = ["general-protection/host-bridge.m", ...["host-resources.c", "repository-files.c", "repository-vfs.c", "repository-pair.c", "repository-sql.c"].map((name) => `general-protection/${name}`), ...["path.c", "host-bootstrap.c", "host-bootstrap-wire.c", "host-window.m", "window-server.c", "channel-peer.c",
      "console-identity.c", "session-code.c", "session-installation.c", "session-canonical.c", "bundle-resources.c", "fuses.c", "session-frame.c", "session-request.c", "session-reply.c", "native-directory.c", "native-head.c", "initialization.c", "resource-commit-send.c"]
      .map((name) => `general-trust/${name}`)];
    const objects = sources.map((name, index) => {
      const object = join(staging, `${index}.o`);
      execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-O2", "-fvisibility=hidden", "-DNAPI_VERSION=10", "-I", headers,
        ...(name.endsWith(".m") ? ["-fobjc-arc", "-fblocks"] : []), "-c", join(source, name), "-o", object], options); return object;
    });
    const addon = join(staging, "general-protection-bridge.node");
    execFileSync("/usr/bin/clang", ["-bundle", "-undefined", "dynamic_lookup", ...objects, join(workspace, ".tmp/general-protected-sqlite/libgeneral-protected-sqlite.a"),
      "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "CoreFoundation", "-framework", "Security", "-framework", "SystemConfiguration", "-lbsm",
      "-Wl,-exported_symbol,_napi_register_module_v1", "-Wl,-exported_symbol,_node_api_module_get_api_version_v1", "-o", addon], options);
    const exports = execFileSync("/usr/bin/nm", ["-gjU", addon], { ...options, encoding: "utf8" }).trim().split(/\s+/).sort();
    if (exports.join(",") !== "_napi_register_module_v1,_node_api_module_get_api_version_v1") throw new Error("GENERAL_PROTECTED_HOST_SYMBOLS_INVALID");
    const unresolved = execFileSync("/usr/bin/nm", ["-u", addon], { ...options, encoding: "utf8" });
    if (/_sqlite3_|_general_/.test(unresolved)) throw new Error("GENERAL_PROTECTED_HOST_NATIVE_SYMBOLS_UNRESOLVED");
    const metadata = { format: "koincode-general-protected-host-build", version: 1, electron: PROTECTED_HOST_SDK.electron, napi: 10,
      sourceHashes: Object.fromEntries(sources.map((name) => [name, hash(join(source, name))])), addonSha256: hash(addon), sdk: PROTECTED_HOST_SDK };
    renameSync(addon, join(output, "general-protection-bridge.node"));
    writeFileSync(join(output, "build.json"), JSON.stringify(metadata, null, 2) + "\n");
    const ownerSources = ["general-protection/payment-owner-bridge.m", ...["path.c", "control-io.c", "host-bootstrap.c", "host-bootstrap-wire.c", "channel-peer.c",
      "console-identity.c", "session-code.c", "session-installation.c", "session-canonical.c", "bundle-resources.c", "fuses.c"].map((name) => `general-trust/${name}`)];
    const ownerObjects = ownerSources.map((name, index) => {
      const object = join(staging, `owner-${index}.o`);
      execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-O2", "-fvisibility=hidden", "-DNAPI_VERSION=10",
        "-DGENERAL_CONTROL_INPUT_MAX=4194304U", "-I", headers, ...(name.endsWith(".m") ? ["-fobjc-arc", "-fblocks"] : []), "-c", join(source, name), "-o", object], options);
      return object;
    });
    const ownerAddon = join(staging, "general-payment-owner-bridge.node");
    execFileSync("/usr/bin/clang", ["-bundle", "-undefined", "dynamic_lookup", ...ownerObjects, "-framework", "Foundation", "-framework", "CoreFoundation",
      "-framework", "Security", "-framework", "SystemConfiguration", "-lbsm", "-Wl,-exported_symbol,_napi_register_module_v1", "-Wl,-exported_symbol,_node_api_module_get_api_version_v1", "-o", ownerAddon], options);
    const ownerExports = execFileSync("/usr/bin/nm", ["-gjU", ownerAddon], { ...options, encoding: "utf8" }).trim().split(/\s+/).sort();
    const ownerUndefined = execFileSync("/usr/bin/nm", ["-u", ownerAddon], { ...options, encoding: "utf8" });
    if (ownerExports.join(",") !== "_napi_register_module_v1,_node_api_module_get_api_version_v1" || /_general_/.test(ownerUndefined))
      throw new Error(`GENERAL_PAYMENT_OWNER_SYMBOLS_INVALID: ${ownerExports.join(",")}; ${ownerUndefined.split("\n").filter((line) => /_general_/.test(line)).join(",")}`);
    writeFileSync(join(output, "payment-owner-build.json"), JSON.stringify({ format: "koincode-general-payment-owner-build", version: 1,
      sourceHashes: Object.fromEntries(ownerSources.map((name) => [name, hash(join(source, name))])), addonSha256: hash(ownerAddon), sdk: PROTECTED_HOST_SDK }, null, 2) + "\n");
    renameSync(ownerAddon, join(output, "general-payment-owner-bridge.node"));
  } finally { rmSync(staging, { recursive: true, force: true }); }
  process.stdout.write("Protected Host native bridge built with pinned Electron 41.0.3/NAPI 10 and private SQLite. No installation, signature or secret admission performed.\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error("Unexpected protected bridge build arguments.");
  buildProtectedHostBridge(process.argv[2]);
}
