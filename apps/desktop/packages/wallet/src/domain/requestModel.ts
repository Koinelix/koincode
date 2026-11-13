export interface X402RequestInput {
  url?: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  bodyJson?: unknown;
  bodyRef?: string;
  credentialRef?: string;
  idempotency?: { headerName: string };
  paymentMode?: "policy" | "never";
  /** Host delivery preference; omission is treated as opaque by the host. */
  responseMode?: "opaque" | "image";
  requestContextRef?: string;
  requestContextAction?: "recover" | "refresh_quote";
}
export interface RequestView {
  requestId: string;
  operationId: string;
  transportStatus:
    | "prepared"
    | "running"
    | "awaiting_authorization"
    | "waiting_for_unlock"
    | "completed"
    | "unknown"
    | "failed"
    | "canceled";
  paymentStatus: string;
  httpStatus?: number;
  responseHeaders?: Record<string, string>;
  bodyRef?: string;
  byteLength?: number;
  sha256?: string;
  paymentIntentId?: string;
  amountAtomic?: string;
  network?: string;
  transactionHash?: string;
  diagnosticCode?: string;
  relatedRequestId?: string;
  sensitiveRedacted?: boolean;
  reconciliationPending?: boolean;
}
export interface ModelPaymentRecoveryContext {
  invocationDigest?: string;
  idempotencyKey: string;
  contentType: string | null;
}
export interface FrozenRequest {
  httpTimeoutMs?: number;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string | null;
  credentialRef: string | null;
  credentialVersion: number | null;
  businessKey: string | null;
  paymentMode: "policy" | "never";
  hostPayment?: {
    paymentOnly?: true;
    modelRecovery?: ModelPaymentRecoveryContext;
    requestDigest: string;
    bodySha256: string | null;
    bodyByteLength: number;
    credentialTag: string | null;
  };
}
/** Trusted host input. Never accept this as model or MCP tool input. */
export interface HostPaymentInput {
  modelRecovery?: ModelPaymentRecoveryContext;
  url: string;
  method: "GET" | "POST";
  requestDigest: string;
  bodySha256: string | null;
  bodyByteLength: number;
  credentialTag: string | null;
  paymentRequired: string;
}
export interface HostPaymentMaterial {
  intentId: string;
  paymentHeader: string;
}
/** Host-authenticated association; never supplied by the independent client. */
export interface HostPaymentActivityInput {
  version: 1;
  workspaceKey: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  invocationId: string;
  clientOperationId: string;
}
export interface HostPaymentActivityBinding extends HostPaymentActivityInput {
  requestDigest: string;
  quoteDigest: string;
}
export interface HostPaymentPrepared extends RequestView {
  walletFrozenDigest: string;
  walletInputDigest: string;
  walletClient: import("./model.js").ClientContext & { managementEpoch: string };
  walletCreatedBy: { sessionId: string; generation: number };
}
export interface StoredQuote {
  challenge: Record<string, unknown>;
  selected: {
    scheme: "exact" | "upto";
    network: import("./model.js").Network;
    asset: string;
    payTo: string;
    amount: string;
    maxTimeoutSeconds: number;
    extra: { name: "USDC" | "USD Coin"; version: "2"; facilitatorAddress?: string };
  };
  receivedAt: number;
  receivedMonotonic: number;
  clockId: string;
  digest: string;
}
export interface RequestRecord extends RequestView {
  modelPayment?: true;
  recoveryRequested?: boolean;
  hostActivity?: HostPaymentActivityBinding;
  ownerId: string;
  clientId: string;
  sessionId: string;
  generation: number;
  executionSessionId?: string;
  executionGeneration?: number;
  epoch: string;
  inputDigest: string;
  frozenRef: string;
  frozenDigest: string;
  createdAt: number;
  expiresAt: number;
  parentRequestId: string | null;
  action: "request" | "recover" | "refresh_quote";
  quoteRef?: string;
  signedQuoteRef?: string;
  signedChallengeValid?: boolean;
  replayPolicyDigest?: string;
  responseRef?: string;
  responseRetentionId?: string;
  payloadRef?: string;
  intentIds: string[];
  canceled: boolean;
  replacementCount: number;
  internalRefreshId?: string;
  replacementFrom?: string;
  unsignedRetryFrom?: string;
  unsignedRefreshId?: string;
  unsignedRefreshConsumed?: boolean;
  unsignedRefreshConsumedBy?: string;
  autoUntil?: number;
  autoAttempts?: number;
}
export interface CredentialRecord {
  ref: string;
  ownerId: string;
  clientIds: string[];
  origin: string;
  path: string;
  headerName: "authorization" | "x-api-key";
  version: number;
  secretRef: string;
  active: boolean;
  epoch: string;
}
export interface TokenRecord {
  clientId: string;
  generation: number;
  tokenDigest: string;
  active: boolean;
  epoch: string;
}
export interface BodyRecord {
  ref: string;
  ownerId: string;
  clientId: string;
  blobRef: string;
  expiresAt: number;
}
export interface TransportState {
  version: 1;
  epoch: string;
  historyComplete: boolean;
  requests: RequestRecord[];
  credentials: CredentialRecord[];
  tokens: TokenRecord[];
  bodies: BodyRecord[];
  journalAnchors?: import("./operationJournal.js").OperationJournalAnchor[];
  retentions?: import("./responseRetention.js").ResponseRetentionRecord[];
  replayPolicies?: ReplayPolicy[];
}

export interface ReplayPolicy {
  origin: string;
  path: string;
  method: "GET" | "POST";
  expiresAt: number;
  recoveryHeaders?: Record<string, string>;
  safeReplay: boolean;
}
