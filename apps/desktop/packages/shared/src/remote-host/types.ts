import type {
  RemoteHostRecord, RemoteTrustRecord, RemoteSelection, RemoteOperation,
  RemoteExecutionState, RemoteUploadStage,
} from "./contracts.js";
import type { RemoteHostFailure } from "./errors.js";

export interface RemoteHostSummary extends RemoteHostRecord {
  credentialState: "available" | "session_only" | "missing" | "locked";
  trustState: "unknown" | "trusted" | "changed";
  trustRevision: number;
}

export interface RemoteHostChallenge {
  challengeId: string;
  hostId: string;
  securityRevision: number;
  endpoint: string;
  fingerprint: string;
  keyType: string;
  expiresAt: number;
}

export interface RemoteCallContext {
  ownerId: string;
  clientInstanceId: string;
  workspaceKey: string;
  agentGeneration: string;
  brokerGeneration: string;
  traceId: string;
  sessionId: string;
  messageId: string;
  turnId: string;
  toolCallId: string;
  runtimeScope: "main" | "subagent";
  selectionId?: string;
}

export interface RemoteManifestEntry {
  type: "file" | "directory";
  relativePath: string;
  size: number;
  mode: number;
  sha256?: string;
}

export interface RemoteUploadSource {
  sourceId: string;
  origin: "picker" | "attachment" | "workspace_path";
  kind: "file" | "directory";
  displayName: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  skippedCount: number;
  manifestHash: string;
  frozenAt: number;
  availability: "ready" | "requires_confirmation" | "expired";
}

export interface RemoteSourceRecord extends RemoteUploadSource {
  ownerId: string;
  workspaceKey: string;
  binding: RemoteSelection["binding"];
  originalPath: string;
  snapshotId: string;
  entries: RemoteManifestEntry[];
  skipped: Array<{ relativePath: string; reason: string }>;
  callId?: string;
}

export interface RemoteExecutionRecord {
  executionId: string;
  attempt: number;
  retryOf?: { executionId: string; attempt: number };
  context: RemoteCallContext;
  hostId: string;
  securityRevision: number;
  trustRevision: number;
  display: { name: string; endpoint: string; username: string };
  operation: RemoteOperation;
  requestId: string;
  approvalId: string;
  operationDigest: string;
  state: RemoteExecutionState;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  deadlineAt?: number;
  dispatchExpiresAt: number;
  exitCode?: number;
  signal?: string;
  verification?: "not_requested" | "verified" | "failed" | "unverified";
  cancelReason?: string;
  error?: RemoteHostFailure;
  uploadedBytes?: number;
  uploadedFiles?: number;
  sourceId?: string;
  snapshotId?: string;
  manifestHash?: string;
  remotePath?: string;
  stagingPath?: string;
  backupPath?: string;
  receiptPath?: string;
  uploadStage?: RemoteUploadStage;
  residualPaths?: string[];
  reconciliation?: { checkedAt: number; reason: string; checks: Array<{ path: string; exists: boolean; type?: string; size?: number }> };
  outputBytes: number;
  outputTruncated: boolean;
  outputArtifactId?: string;
  outputExpiredAt?: number;
  outputPurgedAt?: number;
  eventsPurgedAt?: number;
  result?: Record<string, unknown>;
}

export interface RemoteExecutionEvent {
  eventVersion: 1;
  executionId: string;
  hostId: string;
  attempt: number;
  sequence: number;
  timestamp: number;
  traceId: string;
  state: RemoteExecutionState;
  uploadedBytes?: number;
  uploadedFiles?: number;
  message?: string;
}

export interface RemoteTestResult {
  hostId: string;
  success: boolean;
  checkedAt: number;
  home?: string;
  platform?: string;
  arch?: string;
  challenge?: RemoteHostChallenge;
  error?: RemoteHostFailure;
}

export interface RemoteHostPage {
  items: RemoteHostSummary[];
  total: number;
  catalogRevision: number;
  nextCursor?: string;
}

export interface RemoteTrustSnapshot {
  host: RemoteHostRecord;
  trust: RemoteTrustRecord | null;
}
