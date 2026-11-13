import { GeneralPaymentCustody } from "./generalPaymentCustody.js";
import { openLocalGeneralPayment, signLocalAllowance } from "./localGeneralPayment.js";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { requireWallet } from "../domain/errors.js";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { protectedJson } from "../app/commitments.js";
import type { ProtectedProfile } from "./profileRecords.js";
import { recoverWalletProfile } from "./profileRecovery.js";
import { createLocalKeychainStore } from "./userKeychain.js";
import { ProtectedKeyCustody } from "./keyCustody.js";
import { BaseWalletChain } from "./chainRpc.js";
import { withLegacyWalletFence } from "./legacyWalletFence.js";
import { relocateWalletProfile } from "./profileRelocation.js";
import { openWalletProfile } from "./profile.js";
export interface LocalWalletOptions {
  mode: "create" | "open" | "resume_setup" | "import_setup";
  freshGeneralSources?: boolean;
  keychainHelper: string;
  directory?: string;
  namespace?: "m4-testnet" | "mainnet";
  /** Trusted existing utility only; reuses a live management owner instead of opening another writer. */
  generalAllowance?: (wallet: import("../app/ports.js").ManagedKey, tx: import("../domain/allowanceTransaction.js").AllowanceTransaction,
    signal: AbortSignal, open: () => Promise<string>) => Promise<string>;
  generalPayment?: (intent: import("./generalExactPayment.js").GeneralExactPayment, signal: AbortSignal | undefined,
    open: () => Promise<import("./generalPaymentCustody.js").GeneralExactPaymentSession>) => Promise<import("./generalPaymentCustody.js").GeneralExactPaymentSession>;
}
export function walletServiceDirectory(namespace?: "m4-testnet" | "mainnet"): string {
  requireWallet(namespace === undefined || namespace === "m4-testnet" || namespace === "mainnet",
    "INVALID_REQUEST_CONFIGURATION", "Unknown wallet namespace.");
  return join(homedir(), ".koincode", "wallet", namespace ?? "testnet");
}

function namespaceRoot(options: Pick<LocalWalletOptions, "namespace" | "keychainHelper">): string {
  const root = walletServiceDirectory(options.namespace);
  const expectedHelper = options.namespace === "mainnet" ? "keychain-helper-mainnet" : options.namespace === "m4-testnet" ? "keychain-helper-m4-testnet" : "keychain-helper";
  requireWallet(basename(options.keychainHelper) === expectedHelper,
    "INVALID_REQUEST_CONFIGURATION", "The wallet helper does not match the selected namespace.");
  return root;
}

function assertNamespaceDirectory(namespace: LocalWalletOptions["namespace"], root: string, directory?: string): void {
  if (!namespace || directory === undefined) return;
  const path = relative(root, directory);
  requireWallet(path !== "" && !path.startsWith("..") && !isAbsolute(path),
    "UNSAFE_STORAGE_PATH", "The wallet directory is outside its namespace.");
}

/** Only the explicit relocation entrypoint may inspect the previous service root. */
export function legacyWalletServiceDirectory(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "KoinCode Wallet Testnet")
    : process.platform === "win32"
      ? join(homedir(), "AppData", "Local", "KoinCode Wallet Testnet")
      : join(homedir(), ".local", "share", "koincode-wallet-testnet");
}
export async function openLocalWallet(options: LocalWalletOptions): Promise<import("../app/runtime.js").WalletRuntime> {
  if (options.mode === "import_setup") {
    try { return await openLocalWallet({ ...options, mode: "open" }); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "WALLET_PROFILE_ABSENT")) throw error;
      return openLocalWallet({ ...options, mode: "create", freshGeneralSources: true });
    }
  }
  const mode = options.mode;
  const root = namespaceRoot(options);
  const namespace = options.namespace;
  const protection = createLocalKeychainStore(options.keychainHelper);
  const current =
    options.mode !== "create" && !options.directory
      ? await protectedJson<ProtectedProfile>(protection, "wallet-profile")
      : null;
  const installationId = options.mode === "create" ? randomUUID() : undefined;
  const directory = options.directory ?? current?.directory ??
    (installationId ? join(root, "profiles", installationId) : undefined);
  assertNamespaceDirectory(namespace, root, directory);
  const generalDirectory = join(dirname(root), "general-local");
  const generalHelper = join(dirname(options.keychainHelper), basename(dirname(options.keychainHelper)) === "user-v2" ? "keychain-helper-general-wallet" : "noninteractive-v1/keychain-helper-general-wallet");
  const open = () => openWalletProfile({
    mode,
    freshGeneralSources: options.mode === "create" && options.freshGeneralSources === true,
    paymentNetwork: namespace === "mainnet" ? "eip155:8453" : "eip155:84532",
    installationId,
    directory,
    leaseDirectory: join(root, "service"),
    protection,
    custody: new GeneralPaymentCustody(new ProtectedKeyCustody(protection), (intent, signal) => {
      const open = () => openLocalGeneralPayment({ directory: generalDirectory, keychainHelper: generalHelper }, intent, signal);
      return options.generalPayment ? options.generalPayment(intent, signal, open) : open();
    }, (wallet, tx, signal) => {
      const open = () => signLocalAllowance(generalDirectory, generalHelper, wallet, tx, signal);
      return options.generalAllowance ? options.generalAllowance(wallet, tx, signal, open) : open();
    }),
    chain: new BaseWalletChain(),
    sources: { wall: Date.now, monotonic: () => performance.now() },
  });
  return namespace !== undefined ? open() : withLegacyWalletFence({
    legacyRoot: legacyWalletServiceDirectory(), targetRoot: root, mode: options.mode, protection,
  }, open);
}
export interface LocalRecoveryOptions {
  mode: "recover" | "resume_recovery";
  keychainHelper: string;
  directory?: string;
  backup: string;
  password: string;
  acceptVerifiedGrossOutflow: boolean;
  signal?: AbortSignal;
  namespace?: "m4-testnet" | "mainnet";
  /** Trusted existing utility only; reuses a live management owner instead of opening another writer. */
  generalPayment?: (intent: import("./generalExactPayment.js").GeneralExactPayment, signal: AbortSignal | undefined,
    open: () => Promise<import("./generalPaymentCustody.js").GeneralExactPaymentSession>) => Promise<import("./generalPaymentCustody.js").GeneralExactPaymentSession>;
}
export async function recoverLocalWallet(options: LocalRecoveryOptions) {
  const root = namespaceRoot(options);
  const namespace = options.namespace;
  const protection = createLocalKeychainStore(options.keychainHelper);
  const current =
    options.mode === "resume_recovery" && !options.directory
      ? await protectedJson<ProtectedProfile>(protection, "wallet-profile")
      : null;
  const installationId = options.mode === "recover" ? randomUUID() : undefined;
  const directory = options.directory ?? current?.directory ?? join(root, "profiles", installationId ?? "pending-recovery");
  assertNamespaceDirectory(namespace, root, directory);
  const recover = () => recoverWalletProfile({
    ...options,
    paymentNetwork: namespace === "mainnet" ? "eip155:8453" : "eip155:84532",
    installationId,
    directory,
    leaseDirectory: join(root, "service"),
    protection,
    custody: new ProtectedKeyCustody(protection),
    chain: new BaseWalletChain(),
    sources: { wall: Date.now, monotonic: () => performance.now() },
  });
  return namespace !== undefined ? recover() : withLegacyWalletFence({
    legacyRoot: legacyWalletServiceDirectory(), targetRoot: root, mode: options.mode, protection,
  }, recover);
}

/** Explicit trusted maintenance, absent from wallet MCP and model-facing contracts. */
export function relocateLocalWallet(keychainHelper: string) {
  return relocateWalletProfile({
    sourceService: join(legacyWalletServiceDirectory(), "service"),
    targetRoot: walletServiceDirectory(),
    protection: createLocalKeychainStore(keychainHelper),
  });
}
