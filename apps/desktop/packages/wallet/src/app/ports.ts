export interface ProtectedStore {
  get(account: string): Promise<Uint8Array | null>;
  put(account: string, value: Uint8Array): Promise<void>;
}

/** Internal retention capability; never expose it to model or client tools. */
export interface ResponseSecretStore extends ProtectedStore {
  removeResponseSecret(account: string): Promise<void>;
}

export interface LegacyManagedKey {
  kind?: "legacy";
  address: string;
  network: import("../domain/model.js").Network;
  keyRef: string;
  keystore: string;
}
export interface GeneralPaymentSource {
  protection?: "local_system";
  installationId: string;
  enrollmentId: string;
  profileId: string;
  sourceId: string;
  sourceCommitment: string;
}
export interface GeneralManagedKey {
  kind: "general_source";
  address: string;
  network: import("../domain/model.js").Network;
  source: Readonly<GeneralPaymentSource>;
}
export type ManagedKey = LegacyManagedKey | GeneralManagedKey;
export interface PaymentSigningContext {
  walletId: string;
  subjectId: string;
  intentId: string;
  requestId: string;
  requestDigest: string;
  quoteDigest: string;
}
export interface BackupMetadata {
  address: string;
  network: import("../domain/model.js").Network;
  asset: string;
  baselineBlock: number;
  baselineHash: string;
  history: string;
}
export interface KeyCustody {
  /** A local worker / writer slot, acquired before creating the signing intent. */
  acquireSigningSlot?(signal: AbortSignal): Promise<() => void>;
  signAllowance?(key: ManagedKey, tx: import("../domain/allowanceTransaction.js").AllowanceTransaction, signal: AbortSignal): Promise<string>;
  create(network: import("../domain/model.js").Network, signal?: AbortSignal): Promise<ManagedKey>;
  importTestWallet(path: string, signal?: AbortSignal): Promise<ManagedKey>;
  exportBackup(
    key: ManagedKey,
    metadata: BackupMetadata,
    password: string,
    signal?: AbortSignal,
  ): Promise<string>;
  restoreBackup(
    backup: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<{ key: ManagedKey; metadata: BackupMetadata }>;
  signAuthorization(
    key: ManagedKey,
    authorization: import("../domain/model.js").ExactAuthorization,
    finalCheck: (authorization: Readonly<import("../domain/model.js").ExactAuthorization>) => void,
    signal?: AbortSignal,
    context?: Readonly<PaymentSigningContext>,
  ): Promise<string>;
  signPermitAuthorization?(
    key: ManagedKey,
    authorization: import("../domain/uptoAuthorization.js").UptoAuthorization,
    finalCheck: (authorization: Readonly<import("../domain/model.js").ExactAuthorization>) => void,
    signal?: AbortSignal,
    context?: Readonly<PaymentSigningContext>,
  ): Promise<string>;
  /** Private trusted management only; never an SDK or MCP operation. */
  revealPrivateKey?(key: ManagedKey, signal?: AbortSignal): Promise<string>;
  protectSignature(intentId: string, signature: string): Promise<string>;
}

export interface ChainBlock {
  number: number;
  hash: string;
  timestamp: number;
}
export interface ChainSnapshot {
  network: import("../domain/model.js").Network;
  asset: string;
  payer: string;
  latest: ChainBlock;
  safe: ChainBlock;
  finalized: ChainBlock;
  balanceAtomic: string;
}
export interface UptoChainSnapshot extends ChainSnapshot {
  allowanceAtomic: string;
  permitNonce: string;
  usedNonces: string[];
  /** Complete observed Permit2 words keyed by decimal word position at the snapshot block. */
  nonceBitmaps?: ReadonlyMap<string, bigint>;
}
export interface WalletChain {
  allowanceTransactions?: {
    quote(network: import("../domain/model.js").Network, payer: string, amount: string, signal: AbortSignal): Promise<{
      tx: import("../domain/allowanceTransaction.js").AllowanceTransaction; feeWei: string; hasGas: boolean }>;
    finalizedNonce(network: import("../domain/model.js").Network, payer: string, signal: AbortSignal): Promise<number>;
    broadcast(network: import("../domain/model.js").Network, raw: string, signal: AbortSignal): Promise<string>;
  };
  uptoSnapshot?(network: import("../domain/model.js").Network, payer: string,
    nonces: readonly string[], signal?: AbortSignal, at?: "latest" | "finalized"): Promise<UptoChainSnapshot>;
  canonicalSettlementAnchors?(
    snapshot: ChainSnapshot,
    anchors: ReadonlyArray<{ number: number; hash: string }>,
    signal?: AbortSignal,
  ): Promise<Array<{ number: number; hash: string }>>;
  resolveAuthorization?(
    intent: import("../domain/model.js").PaymentIntent,
    payer: string,
    signal?: AbortSignal,
  ): Promise<AuthorizationResolution>;
  snapshot(
    network: import("../domain/model.js").Network,
    payer: string,
    signal?: AbortSignal,
  ): Promise<ChainSnapshot>;
  settlement?(
    intent: import("../domain/model.js").PaymentIntent,
    payer: string,
    txHash: string,
    signal?: AbortSignal,
  ): Promise<SettlementResult>;
  historyPage?(input: HistoryPageInput, signal?: AbortSignal): Promise<HistoryPageResult>;
}
export interface HistoryPageInput {
  network: import("../domain/model.js").Network;
  payer: string;
  asset: string;
  baselineBlock: number;
  baselineHash: string;
  checkpointBlock: number;
  checkpointHash: string;
  targetBlock: number;
  targetHash: string;
  fromBlock: number;
  toBlock: number;
  cursor?: { logsDigest: string; nextIndex: number; outflows: VerifiedOutflow[] };
}
export interface VerifiedOutflow {
  evidenceKey: string;
  amountAtomic: string;
  settledAt: number;
  txHash: string;
  logIndex: number;
  block: ChainBlock;
}
export interface HistoryPageResult {
  fromBlock: number;
  toBlock: number;
  endHash: string;
  outflows: VerifiedOutflow[];
  complete: boolean;
  logsDigest: string;
  nextIndex: number;
}
export type SettlementResult =
  | { kind: "pending"; trustedTime: number }
  | { kind: "orphaned"; trustedTime: number }
  | {
      kind: "used";
      actualAmountAtomic?: string;
      trustedTime: number;
      txHash: string;
      logIndex: number;
      block: ChainBlock;
      evidenceKey: string;
      safe: boolean;
    };

export type AuthorizationResolution =
  | { kind: "pending" | "proof_reorg"; trustedTime: number; uptoNonceUsed?: true }
  | { kind: "used"; trustedTime: number; txHash: string }
  | { kind: "progress"; trustedTime: number; cursor: import("../domain/model.js").ResolutionCursor }
  | { kind: "expired" | "canceled"; trustedTime: number; proof: ChainBlock };
