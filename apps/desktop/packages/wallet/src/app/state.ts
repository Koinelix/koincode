import type {
  BudgetSubject,
  ClientContext,
  LedgerEvent,
  Network,
  PaymentGrant,
  PaymentIntent,
  WalletLimits,
} from "../domain/model.js";
interface WalletIdentity {
  walletId: string;
  subjectId: string;
  address: string;
  network: Network;
  asset: string;
  baselineBlock: number;
  baselineHash: string;
}
export type LegacyWalletRecord = WalletIdentity & import("./ports.js").LegacyManagedKey;
export type GeneralWalletRecord = WalletIdentity & import("./ports.js").GeneralManagedKey;
export type WalletRecord = LegacyWalletRecord | GeneralWalletRecord;
export interface RegisteredClient {
  registrationEpoch?: string;
  peerIdentityKey?: string;
  clientId: string;
  ownerId: string;
  generation: number;
  active: boolean;
  kind: "internal" | "external";
  subjectIds: string[];
}
export interface PermitRecord {
  permitId: string;
  intentId: string;
  requestId: string;
  expiresAt: number;
  status: "prepared" | "consumed" | "invalidated";
}
export interface WalletAuditEvent {
  eventId: string;
  action: string;
  subjectId: string | null;
  recordedAt: number;
  details: Record<string, string | number | boolean | null>;
}
export interface SettlementObservation {
  observationId: string;
  intentId: string;
  network: Network;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  settledAt: number;
  canonical: boolean;
  safe: boolean;
}
export interface RecoveryRecord {
  recoveryId: string;
  subjectId: string;
  sourceInstallationId: string;
  sourceOwnerId: string;
  sourceHistory: string;
  baselineBlock: number;
  baselineHash: string;
  startedAt: number;
  riskExpiresAfter: number;
  targetBlock: number | null;
  targetHash: string | null;
  targetTime: number | null;
  nextBlock: number;
  lastVerifiedBlock: number;
  lastVerifiedHash: string;
  verifiedOutflowAtomic: string;
  sourceCumulativeAtomic: string;
  accountingAccepted: boolean;
  status: "blocked" | "waiting_safe" | "scanning" | "complete";
  errorCode: string | null;
  pendingPage?: {
    fromBlock: number;
    toBlock: number;
    logsDigest: string;
    nextIndex: number;
    outflows: import("./ports.js").VerifiedOutflow[];
  };
}
export interface WalletState {
  transport?: import("../domain/requestModel.js").TransportState;
  installationId: string;
  ownerId: string;
  managementEpoch: string;
  initializationAttempt: string;
  revision: number;
  trustedTime: number;
  defaultWalletId: string | null;
  auditEvents: WalletAuditEvent[];
  observations: SettlementObservation[];
  recoveries: RecoveryRecord[];
  wallets: WalletRecord[];
  subjects: BudgetSubject[];
  policies: Record<string, WalletLimits>;
  clients: RegisteredClient[];
  sessions: ClientContext[];
  grants: PaymentGrant[];
  permits: PermitRecord[];
  intents: PaymentIntent[];
  events: LedgerEvent[];
}
export interface StateCommitment {
  version: 1;
  installationId: string;
  ownerId: string;
  managementEpoch: string;
  initializationAttempt: string;
  revision: number;
  storageBinding: string;
  controlDigest: string;
  historyDigest: string;
  ledgerHead: string;
}
export interface StateRepository {
  issueInitialization(mode: "fresh" | "resume"): InitializationTicket;
  beginInitialization(ticket: InitializationTicket): {
    attempt: InitializationAttempt;
    attemptId: string;
    mode: "fresh" | "resume";
  };
  finishInitialization(
    previous: WalletState,
    next: WalletState,
    commitment: StateCommitment,
    attempt: InitializationAttempt,
  ): void;
  isReady(): boolean;
  read(): WalletState;
  readCommitment(): StateCommitment | null;
  commitment(state: WalletState, storageBinding?: string): StateCommitment;
  validate(previous: WalletState, next: WalletState): void;
  commit(previous: WalletState, next: WalletState, commitment: StateCommitment): void;
  close(): void;
}

declare const initializationTicketBrand: unique symbol;
declare const initializationAttemptBrand: unique symbol;
export type InitializationTicket = { readonly [initializationTicketBrand]: true };
export type InitializationAttempt = { readonly [initializationAttemptBrand]: true };
