import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Development probe only: an empty fixture, never a wallet installation or acceptance run.
if (process.platform !== "darwin" || process.getuid?.() === 0 || process.argv.length !== 2)
  throw new Error("The empty protected-host packaging probe requires the current macOS user and no arguments.");
const require = createRequire(import.meta.url);
const asar = require("@electron/asar"), electron = require("electron");
if (require("electron/package.json").version !== "41.0.3") throw new Error("Unsupported Electron build input.");
const staging = realpathSync(mkdtempSync(join(tmpdir(), "general-host-build-experiment-")));
const app = join(staging, "WalletHost.app"), options = {
  timeout: 30000, stdio: "pipe", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
};
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const originalHash = hash(electron);
const originalFramework = realpathSync(resolve(electron, "../../Frameworks/Electron Framework.framework/Electron Framework"));
const frameworkHash = hash(originalFramework);
cpSync(resolve(electron, "../../.."), app, { recursive: true, verbatimSymlinks: true });
renameSync(join(app, "Contents/MacOS/Electron"), join(app, "Contents/MacOS/WalletHost"));
const resources = join(app, "Contents/Resources"), input = join(staging, "test-input");
rmSync(join(resources, "default_app.asar"), { force: true });
mkdirSync(input);
writeFileSync(join(input, "package.json"), JSON.stringify({ name: "protected-host-build-self-verification", main: "index.cjs", version: "0.0.0" }));
writeFileSync(join(input, "index.cjs"), `const {app}=require('electron');app.setPath('userData',${JSON.stringify(join(staging, "test-user-data"))});app.whenReady().then(()=>{process.stdout.write('PROTECTED_HOST_BUILD_SELF_VERIFICATION_ONLY\\n');app.quit();});`);
const archive = join(resources, "app.asar");
await asar.createPackage(input, archive);
const integrity = createHash("sha256").update(asar.getRawHeader(archive).headerString).digest("hex");
const infoPath = join(app, "Contents/Info.plist");
const info = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath], options));
Object.assign(info, { CFBundleExecutable: "WalletHost", CFBundleIdentifier: "dev.koincode.wallet.host", CFBundleName: "WalletHost",
  ElectronAsarIntegrity: { "Resources/app.asar": { algorithm: "SHA256", hash: integrity } } });
const infoJson = join(staging, "Info.json"); writeFileSync(infoJson, JSON.stringify(info));
execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", infoPath, infoJson], options);
const framework = realpathSync(join(app, "Contents/Frameworks/Electron Framework.framework/Electron Framework"));
if (!framework.startsWith(`${app}/`)) throw new Error("The fixture framework escaped its staging bundle.");
const bytes = readFileSync(framework), marker = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
let offset = 0, count = 0;
while ((offset = bytes.indexOf(marker, offset)) !== -1) {
  offset += marker.length;
  if (bytes[offset] !== 1 || bytes[offset + 1] !== 9) throw new Error("Unexpected fuse schema.");
  bytes.write("000011001", offset + 2, "ascii"); offset += 11; count++;
}
if (count !== 1 && count !== 2) throw new Error("Unexpected fuse marker count.");
writeFileSync(framework, bytes);
const entitlements = join(staging, "entitlements.plist");
writeFileSync(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, app], options);
const verification = spawnSync("/usr/bin/codesign", ["--verify", "--strict", "--deep", app], { ...options, encoding: "utf8" });
const result = spawnSync(join(app, "Contents/MacOS/WalletHost"), [], {
  cwd: "/", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME }, encoding: "utf8", timeout: 15000, maxBuffer: 65536,
});
const evidence = { scope: "empty test fixture; no wallet data, Keychain, authentication or network",
  staging, signatureVerificationExitCode: verification.status, exitCode: result.status, signal: result.signal,
  started: result.stdout?.includes("PROTECTED_HOST_BUILD_SELF_VERIFICATION_ONLY") === true,
  output: result.stdout?.slice(0, 2048), diagnostic: result.stderr?.slice(0, 4096),
  originalExecutableUnchanged: originalHash === hash(electron), originalFrameworkUnchanged: frameworkHash === hash(originalFramework) };
writeFileSync(join(staging, "evidence.json"), JSON.stringify(evidence, null, 2));
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
process.exitCode = evidence.started && evidence.originalExecutableUnchanged && evidence.originalFrameworkUnchanged ? 0 : 1;
