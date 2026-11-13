export type Network = "eip155:84532" | "eip155:8453";
export type PaymentStatus =
  | "RESERVED"
  | "SIGNING"
  | "SIGNED"
  | "SUBMITTED"
  | "UNKNOWN"
  | "OBSERVED"
  | "CONFIRMED"
  | "FAILED_UNSIGNED"
  | "EXPIRED_UNSETTLED"
  | "CANCELED_UNSETTLED";
export interface BudgetSubject {
  subjectId: string;
  ownerId: string;
  address: string;
  network: Network;
  asset: string;
  recoveryRequired: boolean;
  signingPaused: boolean;
}
export interface WalletLimits {
  maxPerPaymentAtomic: string;
  maxRolling24hAtomic: string;
  maxCumulativeAtomic: string;
  enabled: boolean;
  version: number;
}
export interface LedgerEvent {
  eventId: string;
  subjectId: string;
  intentId: string | null;
  kind:
    | "RESERVE"
    | "SPEND"
    | "REORG"
    | "RELEASE"
    | "RESTORE_RESERVATION"
    | "REFUND"
    | "POLICY"
    | "RECOVERY_BASELINE";
  reservedDelta: string;
  spentDelta: string;
  settledAt: number | null;
  recordedAt: number;
  evidenceKey: string | null;
}
export interface BudgetView {
  reservedAtomic: string;
  rolling24hSpentAtomic: string;
  cumulativeSpentAtomic: string;
  rolling24hRemainingAtomic: string;
  cumulativeRemainingAtomic: string;
  blocked: boolean;
}
export interface ClientContext {
  ownerId: string;
  clientId: string;
  sessionId: string;
  generation: number;
  identityLevel: "verified" | "token_only";
}
export interface PaymentScope {
  scheme?: "exact" | "upto";
  subjectId: string;
  requestId: string;
  requestDigest: string;
  quoteDigest: string;
  credentialVersion: string | null;
  origin: string;
  path: string;
  method: string;
  network: Network;
  asset: string;
  payTo: string;
  amountAtomic: string;
}
export interface PaymentGrant {
  grantId: string;
  subjectId: string;
  ownerId: string;
  clientIds: string[];
  scope: "once" | "session" | "persistent";
  sessionId: string | null;
  generation: number | null;
  requestId: string | null;
  requestDigest: string | null;
  quoteDigest: string | null;
  /** Optional host credential binding on independent-client session grants. */
  sessionCredentialVersion?: string;
  /** Host-owned, process-lifetime scope for an independent-client session grant. */
  sessionHostScope?: string;
  origin: string;
  path: string;
  pathPrefix: boolean;
  method: string;
  network: Network;
  asset: string;
  payTo: string;
  maxAmountAtomic: string;
  expiresAt: number | null;
  managementEpoch: string;
  version: number;
  status: "active" | "revoked" | "paused" | "consumed";
}
export interface PaymentIntent extends PaymentScope {
  upto?: import("./uptoAuthorization.js").UptoDetails;
  permitSignatureRef?: string;
  billAmountAtomic?: string;
  billRequestId?: string;
  actualAmountAtomic?: string | null;
  waiverContradicted?: true;
  schedulingRelease?: { kind: "settled" | "failed" | "expired" | "waived"; block?: { number: number; hash: string } };
  permitConsumedAt?: { number: number; hash: string };
  replacesIntentId?: string;
  authorizedTimeoutSeconds?: number;
  proofBlock?: number;
  proofHash?: string;
  resolution?: ResolutionCursor;
  intentId: string;
  walletId: string;
  clientId: string;
  sessionId: string;
  generation: number;
  grantId: string;
  grantVersion: number;
  policyVersion: number;
  managementEpoch: string;
  nonce: string;
  validAfter: number;
  validBefore: number;
  anchorBlock: number;
  anchorHash: string;
  status: PaymentStatus;
  reserved: boolean;
  spent: boolean;
  settledAt: number | null;
  evidenceKey: string | null;
  signatureRef?: string;
  settlementBlock?: number;
  settlementHash?: string;
  settlementTx?: string;
}

export interface ExactAuthorization {
  upto?: import("./uptoAuthorization.js").UptoDetails;
  network: Network;
  asset: string;
  payer: string;
  payTo: string;
  amountAtomic: string;
  nonce: string;
  validAfter: number;
  validBefore: number;
}

export interface ResolutionCursor {
  usedTxHash?: string;
  nextBlock: number;
  target: { number: number; hash: string; timestamp: number };
  cancellation?: {
    txHash: string;
    block: { number: number; hash: string; timestamp: number };
    logIndex: number;
  };
}
