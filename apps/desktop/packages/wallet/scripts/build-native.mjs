import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const packaged = process.argv.includes("--packaged");
const userStore = process.argv.includes("--user-store-v2");
const archIndex = process.argv.indexOf("--arch");
const arch = archIndex < 0 ? process.arch : process.argv[archIndex + 1];
if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported wallet helper architecture.");
const outputRoot = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
const output = packaged
  ? join(outputRoot, "wallet-native-package", arch)
  : join(outputRoot, "wallet-native");
if (process.platform !== "darwin") throw new Error("The native Keychain adapter requires macOS.");
mkdirSync(output, { recursive: true, mode: 0o700 });
const selected = [
  ["--keychain-only", "keychain"],
  ["--mainnet", "keychain-mainnet"],
  ["--m4-testnet", "keychain-m4-testnet"],
  ["--general-wallet", "keychain-general-wallet"],
  ["--peer-only", "peer"],
].filter(([flag]) => process.argv.includes(flag));
if (selected.length > 1) throw new Error("Choose one wallet helper to build.");
for (const name of selected.length ? [selected[0][1]] : ["keychain", "keychain-mainnet", "keychain-m4-testnet", "keychain-general-wallet", "peer"]) {
  const mainnet = name === "keychain-mainnet";
  const m4 = name === "keychain-m4-testnet";
  const general = name === "keychain-general-wallet";
  const binary = mainnet ? "keychain-helper-mainnet" : general ? "keychain-helper-general-wallet" : m4 ? "keychain-helper-m4-testnet" : name === "peer" ? "peer-identity-helper" : "keychain-helper";
  const helperOutput = userStore && name !== "peer" ? join(output, "user-v2") : general ? join(output, "noninteractive-v1") : output;
  mkdirSync(helperOutput, { recursive: true, mode: 0o700 });
  if (userStore && name !== "peer") {
    const script = join(helperOutput, "keychain-user-store.js");
    copyFileSync(fileURLToPath(new URL("../native/keychain-user-store.js", import.meta.url)), script);
    chmodSync(script, 0o644);
    execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-O2", "-dynamiclib",
      "-arch", arch === "x64" ? "x86_64" : arch,
      fileURLToPath(new URL("../native/legacy-noninteractive.c", import.meta.url)),
      "-framework", "Foundation", "-framework", "Security", "-o", join(helperOutput, "legacy-noninteractive.dylib")],
    { timeout: 30000, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  }
  const source = fileURLToPath(new URL("../native/" + (m4 || general || mainnet ? "keychain" : name) + ".c", import.meta.url));
  execFileSync(
    "/usr/bin/clang",
    [
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Wno-deprecated-declarations",
      "-O2",
      ...(mainnet ? ["-DKOINCODE_MAINNET_NAMESPACE=1"] : []),
      ...(m4 ? ["-DKOINCODE_M4_TESTNET_NAMESPACE=1"] : []),
      ...(general ? ["-DKOINCODE_GENERAL_WALLET_NAMESPACE=1"] : []),
      "-arch",
      arch === "x64" ? "x86_64" : arch,
      source,
      "-framework",
      "Security",
      "-framework",
      "CoreFoundation",
      ...(name === "peer" ? ["-lbsm"] : []),
      "-o",
      join(helperOutput, binary),
    ],
    { timeout: 30000, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } },
  );
  if (packaged) {
    const helper = join(helperOutput, binary);
    const release = process.env.FCODE_ENABLE_MAC_SIGN === "1";
    const identity = release ? process.env.APPLE_SIGNING_IDENTITY || process.env.CSC_NAME : "-";
    if (!identity) throw new Error("Signed wallet helpers require the macOS signing identity.");
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        identity,
        "--identifier",
        binary,
        ...(release ? ["--options", "runtime", "--timestamp"] : []),
        helper,
      ],
      { timeout: 60000, stdio: "inherit" },
    );
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", helper], {
      timeout: 30000,
      stdio: "inherit",
    });
  }
}
if (packaged && userStore) {
  const identity = process.env.FCODE_ENABLE_MAC_SIGN === "1" ? process.env.APPLE_SIGNING_IDENTITY || process.env.CSC_NAME : "-";
  if (!identity) throw new Error("Signed wallet resources require the macOS signing identity.");
  const library = join(output, "user-v2", "legacy-noninteractive.dylib");
  execFileSync("/usr/bin/codesign", ["--force", "--sign", identity, library], { timeout: 30000, stdio: "inherit" });
}
process.stdout.write(`Native wallet helpers built for ${arch}.\n`);
