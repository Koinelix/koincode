import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
if (process.platform !== "darwin") throw new Error("The native general wallet trust experiment requires macOS.");
const root = fileURLToPath(new URL("../native/general-trust/", import.meta.url));
const output = fileURLToPath(new URL("../../../.tmp/general-native-trust/", import.meta.url));
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(output, "build-"));
const sources = ["path.c", "tree.c", "receipt.c", "assignment.c", "backup-file.c", "session-frame.c", "session-ingress.c", "session-dispatch.c", "enrollment-request.c", "enrollment-message.c", "enrollment-payload.c", "enrollment-client.c", "broker-namespace.c", "host-bootstrap-wire.c", "host-bootstrap.c", "host-launch.c", "window-server.c", "broker-window.c", "resource-commit-send.c", "session-canonical.c", "native-head.c", "initialization.c", "domain-binding.c", "native-binding.m", "native-record.m", "management-record-policy.m", "management-records.m", "resource-record.c", "native-resource-read.m", "native-resource-write.m", "resource-repository-verify.c", "resource-session.c", "profile-view.c", "profile-origin.c", "registration-record.c", "registration-io.c", "native-replay.c", "native-journal-read.c", "native-journal-files.c", "native-journal-vfs.c", "native-journal-connection.c", "native-journal-inspect.c", "native-journal-append.c", "native-anchor.m", "session-request.c", "session-reply.c", "session-guard.c", "session-lock.c", "console-identity.c", "root-namespace.c", "session-code.c", "profile-payload.m", "profile-cms.m", "profile-authorization.m", "bundle-resources.c", "channel-peer.c", "session-installation.c", "peer.c", "code.c", "fuses.c", "launch.c", "identity.c", "preflight.c", "authentication.m", "auth-scope.m", "session-auth.m", "session-authentication.m", "head-initialization.m", "broker-session.m", "control-io.c", "control-protocol.m", "broker-control.m", "native-directory.c", "auth-manual.m", "broker.m"];
const provisioner = ["path.c", "fuses.c", "session-frame.c", "session-canonical.c", "session-installation.c", "session-code.c", "bundle-resources.c", "channel-peer.c",
  "console-identity.c", "session-lock.c", "root-namespace.c", "registration-io.c", "registration-record.c", "assignment.c", "initialization.c", "native-head.c",
  "enrollment-request.c", "enrollment-message.c", "enrollment-payload.c", "enrollment-listener.c", "root-enrollment.c", "provisioner-main.c"];
sources.splice(sources.indexOf("broker.m"), 0, "payment-purpose.c");
const compile = ["-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-O2"];
const options = { timeout: 30000, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } };
try {
  const objects = new Map([...new Set([...sources, ...provisioner])].map((name) => {
    const object = join(staging, `${name}.o`);
    execFileSync("/usr/bin/clang", [...compile, ...(name.endsWith(".m") ? ["-fobjc-arc", "-fblocks"] : []), "-c", join(root, name), "-o", object], options);
    return [name, object];
  }));
  execFileSync("/usr/bin/clang", [...sources.map((name) => objects.get(name)), "-framework", "CoreFoundation", "-framework", "Security", "-framework", "Foundation",
    "-framework", "LocalAuthentication", "-framework", "SystemConfiguration", "-framework", "ApplicationServices", "-lbsm", "-lsqlite3", "-o", join(staging, "GeneralProtectionBroker")], options);
  execFileSync("/usr/bin/clang", [...provisioner.map((name) => objects.get(name)), "-framework", "CoreFoundation", "-framework", "Security", "-framework", "SystemConfiguration",
    "-lbsm", "-o", join(staging, "GeneralWalletProvisioner")], options);
  execFileSync("/usr/bin/ar", ["rcs", join(staging, "libgeneral-protection-runtime.a"), ...sources.filter((name) => name !== "broker.m").map((name) => objects.get(name))], options);
  renameSync(join(staging, "libgeneral-protection-runtime.a"), join(output, "libgeneral-protection-runtime.a"));
  mkdirSync(join(output, "native-auth"), { recursive: true });
  for (const locale of ["en-US", "zh-CN"])
    copyFileSync(join(root, "native-auth", `${locale}.json`), join(output, "native-auth", `${locale}.json`));
  renameSync(join(staging, "GeneralProtectionBroker"), join(output, "GeneralProtectionBroker"));
  renameSync(join(staging, "GeneralWalletProvisioner"), join(output, "GeneralWalletProvisioner"));
} finally { rmSync(staging, { recursive: true, force: true }); }
process.stdout.write("General wallet native broker and public enrollment tool built. No installation or secret admission was performed.\n");
