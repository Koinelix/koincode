import type { WalletQuery } from "./runtimeTypes.js";

/** Trusted control-plane display. Never returned by model tools or the client SDK. */
export interface PaymentApprovalView extends WalletQuery {
  approvalId: string;
  requestId: string;
  operationId: string;
  origin: string;
  path: string;
  method: "GET" | "POST";
  payTo: string;
  amountAtomic: string;
  paymentScheme?: "exact" | "upto";
  network: string;
  asset: string;
  maxTimeoutSeconds: number;
  bodyByteLength: number;
  bodySha256: string | null;
  expiresInMs: number;
  diagnosticCode: string | null;
  allowPersistent?: boolean;
}
export type PaymentApprovalChoice = "deny" | "once" | "session" | "persistent" | "continue";
export interface PaymentApprovalDecision {
  requestId: string;
  denied: boolean;
  grantId?: string;
}
