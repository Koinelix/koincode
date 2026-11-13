export interface ResponseRetentionRecord {
  version: 1;
  retentionId: string;
  requestId: string;
  ownerId: string;
  clientId: string;
  epoch: string;
  phase: "initial" | "paid";
  rawRef: string;
  contextRef: string;
  createdAt: number;
  expiresAt: number;
  state: "writing" | "ready" | "deleting" | "deleted";
  rawByteLength?: number;
  rawSha256?: string;
  contextByteLength?: number;
  contextSha256?: string;
}

export type ResponseRetentionEvidence = Required<Pick<ResponseRetentionRecord,
  "rawByteLength" | "rawSha256" | "contextByteLength" | "contextSha256">>;
