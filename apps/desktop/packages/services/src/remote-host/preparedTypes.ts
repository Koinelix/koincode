import type { RemoteHostRecord, RemoteManifestEntry, RemoteOperation, RemoteSourceRecord } from "@fcode/shared";
import type { RegisteredRemoteCall } from "./invocationRegistry.js";
import type { RemotePathEvidence } from "./remoteFileEvidence.js";

export interface RemotePreparedTarget {
  host: RemoteHostRecord;
  trustRevision: number;
  retryOf?: { executionId: string; attempt: number };
  error?: import("@fcode/shared").RemoteHostFailure;
  path?: string;
  condition?: RemotePathEvidence;
  availableBytes?: number | null;
  overwriteCount?: number;
  overwriteExamples?: string[];
  command?: { command: string; cwd?: string; env?: Record<string, string> };
  verify?: { command: string; cwd?: string; env?: Record<string, string> };
  ifExists?: "fail" | "overwrite" | "merge" | "replace";
  expectedHash?: string | null;
}

export interface RemotePreparedCall {
  preparedCallId: string;
  call: RegisteredRemoteCall;
  operation: RemoteOperation;
  input: Record<string, unknown>;
  operationDigest: string;
  preflightDigest: string;
  targets: RemotePreparedTarget[];
  source?: RemoteSourceRecord;
  entries?: RemoteManifestEntry[];
  effectiveManifestHash?: string;
  timeoutMs: number;
  stopOnFailure: boolean;
  preparedAt: number;
  releaseSource?: () => void;
}

export interface RemoteApprovalBinding {
  approvalId: string;
  toolCallId: string;
  preparedCallId: string;
  brokerGeneration: string;
  operationDigest: string;
  preflightDigest: string;
  decisionSource: "human" | "scoped_read_grant" | "session_grant";
  approvedAt: number;
  dispatchExpiresAt: number;
  permissionResponseId: string;
  sessionAuthorizationIds?: string[];
  acceptedUnknownExecutionIds: string[];
}

export interface RemoteReadScope {
  hostId: string;
  securityRevision: number;
  trustRevision: number;
  path: string;
  category: "preflight" | "list_directory" | "read_file";
}
