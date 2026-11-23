import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export function buildWindowsWalletNative({ packaged = false, arch = process.arch } = {}) {
  if (process.platform !== "win32" || arch !== "x64") throw new Error("The Windows wallet requires a Windows x64 build host.");
  const root = resolve(import.meta.dirname, "../../..");
  const programFiles = process.env["ProgramFiles(x86)"] ?? process.env.ProgramFiles;
  if (!programFiles) throw new Error("The MSVC installation location is unavailable.");
  const vswhere = join(programFiles, "Microsoft Visual Studio/Installer/vswhere.exe");
  const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim();
  const cmake = join(installation, "Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe");
  if (!installation || !existsSync(cmake)) throw new Error("MSVC with CMake and the Windows SDK is required to build the wallet.");
  const build = join(root, ".tmp/windows-wallet/x64");
  const output = packaged ? join(root, ".tmp/wallet-native-package/x64/user-v2") : join(homedir(), ".koincode/wallet/native-resources/user-v2");
  const env = { ...process.env, VSLANG: "1033", DOTNET_CLI_UI_LANGUAGE: "en-US" };
  mkdirSync(build, { recursive: true });
  const log = join(build, "build.log");
  writeFileSync(log, "");
  const compile = (args) => {
    try { appendFileSync(log, execFileSync(cmake, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 120000, env })); }
    catch (error) {
      appendFileSync(log, `${error.stdout ?? ""}\n${error.stderr ?? ""}`);
      throw new Error(`[wallet-native] Windows native compilation failed. See ${log}`);
    }
  };
  console.log("[wallet-native] Building Windows x64 native resources.");
  compile(["-S", resolve(import.meta.dirname, "../native/windows"), "-B", build, "-G", "Visual Studio 17 2022", "-A", "x64"]);
  compile(["--build", build, "--config", "Release", "--parallel", "2", "--", "/p:PreferredUILang=en-US"]);
  if (packaged) {
    mkdirSync(output, { recursive: true });
    for (const name of ["keychain-helper", "keychain-helper-mainnet", "keychain-helper-m4-testnet", "keychain-helper-general-wallet"]) {
      copyFileSync(join(build, "Release/koincode-wallet-native.exe"), join(output, `${name}.exe`));
    }
  } else {
    execFileSync(join(build, "Release/koincode-wallet-native.exe"), ["stage-resources", "development"], { windowsHide: true, timeout: 15000, stdio: "ignore" });
  }
  process.stdout.write("Windows wallet native resources built for x64.\n");
}
