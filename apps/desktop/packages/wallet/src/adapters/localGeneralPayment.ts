import { runGeneralCryptoTask } from "./generalCryptoTask.js";
import { GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION } from "../domain/generalSigningPolicy.js";
import type { ProtectedStore } from "../app/ports.js";
import { generalSourceCommitment } from "../app/generalState.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { GeneralGuardedState } from "./generalGuardedState.js";
import { SqliteGeneralStateRepository } from "./generalStateRepository.js";
import { createLocalGeneralProtection } from "./generalKeychain.js";
import { prepareGeneralExactWorker } from "./generalExactWorker.js";
import type { GeneralExactPayment } from "./generalExactPayment.js";
import type { GeneralExactPaymentSession } from "./generalPaymentCustody.js";

/** Called only by original ledger custody after its grant, unlock, budget and frozen-intent checks. */
export async function openLocalGeneralPayment(input: { directory: string; keychainHelper: string; protection?: ProtectedStore },
  intent: GeneralExactPayment, signal?: AbortSignal): Promise<GeneralExactPaymentSession> {
  requireWallet(intent.source.protection === "local_system" && !signal?.aborted,
    "GENERAL_ACCOUNT_UNAVAILABLE", "This payment requires its original local source.");
  const protection = createLocalGeneralProtection(input.keychainHelper, input.protection);
  const owner = await GeneralGuardedState.open(SqliteGeneralStateRepository.open(input.directory, "open"), protection);
  return prepareLocalGeneralPayment(owner, protection, intent, signal, () => owner.close());
}

/** The same actual source owner can serve a visible management window and a payment without a second writer. */
export async function prepareLocalGeneralPayment(owner: GeneralGuardedState, protection: ProtectedStore, intent: GeneralExactPayment,
  signal?: AbortSignal, release: () => Promise<void> = async () => {}): Promise<GeneralExactPaymentSession> {
  let worker: Awaited<ReturnType<typeof prepareGeneralExactWorker>> | undefined, closed = false, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { closed = true; try { await worker?.close(); } finally { await release(); } })();
  const initial = owner.snapshot(), source = initial.sources.find((item) => item.id === intent.source.sourceId);
  const current = () => {
    requireWallet(initial.signingPolicyVersion === GENERAL_SIGNING_POLICY_VERSION && initial.signingPolicyDigest === GENERAL_SIGNING_POLICY_DIGEST,
      "PAYMENT_SOURCE_REGISTRATION_REQUIRED", "The source requires trusted registration under the current signing policy.");
    requireWallet(!closed && !signal?.aborted && owner.isLive(initial.ownerId, initial.installationId) &&
      intent.source.installationId === initial.installationId && intent.source.enrollmentId === initial.ownerId &&
      intent.source.profileId === initial.ownerId && source?.status === "ready" && source.address === intent.authorization.payer &&
      intent.source.protection === "local_system" && generalSourceCommitment(source) === intent.source.sourceCommitment &&
      initial.setups.some((setup) => setup.id === source.setupId && setup.phase === "ready"),
    "GENERAL_ACCOUNT_UNAVAILABLE", "The frozen local payment source is unavailable.");
  };
  try {
    current(); const key = await protection.get(source!.keyRef);
    if (!key || key.byteLength !== 32) { key?.fill(0); throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The original local source key is unavailable."); }
    try { current(); worker = await prepareGeneralExactWorker({ ownerId: initial.ownerId, source: source!, key, intent }, signal); }
    finally { key.fill(0); }
    current();
    return { digest: worker.digest, assertCurrent: current, commit: (digest) => { current(); return worker!.commit(digest); }, close };
  } catch (error) { await close(); throw error; }
}

/** Wallet-management-only fixed USDC approval. No secret leaves the signing worker. */
export async function signLocalAllowance(directory: string, helper: string, wallet: import("../app/ports.js").ManagedKey,
  tx: import("../domain/allowanceTransaction.js").AllowanceTransaction, signal: AbortSignal) {
  const protection = createLocalGeneralProtection(helper);
  const owner = await GeneralGuardedState.open(SqliteGeneralStateRepository.open(directory, "open"), protection);
  try { return await signOwnedAllowance(owner, protection, wallet, tx, signal); }
  finally { await owner.close(); }
}
export async function signOwnedAllowance(owner: GeneralGuardedState, protection: ProtectedStore, wallet: import("../app/ports.js").ManagedKey,
  tx: import("../domain/allowanceTransaction.js").AllowanceTransaction, signal: AbortSignal) {
  requireWallet(wallet.kind === "general_source" && wallet.source.protection === "local_system" && wallet.network === tx.network &&
    wallet.address.toLowerCase() === tx.payer, "GENERAL_ACCOUNT_UNAVAILABLE", "The approval source is unavailable.");
  const current = () => {
    signal.throwIfAborted();
    const state = owner.snapshot(), source = state.sources.find(s => s.id === wallet.source.sourceId);
    requireWallet(state.signingPolicyVersion === GENERAL_SIGNING_POLICY_VERSION && state.signingPolicyDigest === GENERAL_SIGNING_POLICY_DIGEST &&
      state.ownerId === wallet.source.profileId && state.ownerId === wallet.source.enrollmentId && state.installationId === wallet.source.installationId &&
      source?.status === "ready" && source.address === tx.payer && generalSourceCommitment(source) === wallet.source.sourceCommitment &&
      state.setups.some(setup => setup.id === source.setupId && setup.phase === "ready"), "GENERAL_ACCOUNT_UNAVAILABLE", "The payment registration changed.");
    requireWallet(owner.isLive(state.ownerId, state.installationId), "GENERAL_ACCOUNT_UNAVAILABLE", "The signer is unavailable.");
    return { state, source };
  };
  const { source, state } = current();
  const key = await protection.get(source.keyRef);
  try {
    requireWallet(key?.length === 32, "GENERAL_STORE_UNAVAILABLE", "The protected signing key is unavailable.");
    current();
    const raw = await runGeneralCryptoTask<string>({ operation: "sign_allowance", ownerId: state.ownerId, keySourceId: source.id,
      key, derivationPath: source.derivationPath, sourceType: source.sourceType, address: source.address, protectedMaterial: source.protectedMaterial, tx }, signal);
    current();
    return raw;
  } finally { key?.fill(0); }
}
