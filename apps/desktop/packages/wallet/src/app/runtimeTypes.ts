import type {
  BudgetView,
  Network,
  PaymentGrant,
  PaymentScope,
  WalletLimits,
  PaymentIntent,
} from "../domain/model.js";
import type { RegisteredClient } from "./state.js";
import type { ClientHandle } from "./sessions.js";
import type { CredentialReferenceView } from "./credentialMetadata.js";

export interface WalletInfo {
  walletId: string;
  subjectId: string;
  address: string;
  network: Network;
  asset: string;
  isDefault: boolean;
  locked: boolean;
  recoveryRequired: boolean;
  signingPaused: boolean;
}
/** Trusted host display only; the duration is not an authorization or lock guarantee. */
export interface WalletDisplayInfo extends WalletInfo {
  unlockRemainingMs: number | null;
}
export type LimitInput = Omit<WalletLimits, "version">;
export type GrantInput = Pick<
  PaymentGrant,
  "scope" | "origin" | "path" | "pathPrefix" | "method" | "payTo" | "maxAmountAtomic" | "expiresAt"
> & {
  walletId: string;
  clientIds: string[];
  connection?: ClientHandle;
  purchase?: Pick<PaymentScope, "requestId" | "requestDigest" | "quoteDigest">;
};
export type ManagementCommand =
  | { action: "ensure_desktop_client" }
  | { action: "create"; network: Network }
  | { action: "import_test"; path: string }
  | { action: "default"; walletId: string }
  | { action: "resume_signing"; walletId: string }
  | { action: "limits"; walletId: string; limits: LimitInput }
  | { action: "register_client"; kind: "internal" | "external"; subjectIds: string[] }
  | { action: "revoke_client"; clientId: string }
  | { action: "grant"; grant: GrantInput }
  | { action: "revoke_grant"; grantId: string }
  | { action: "unlock"; walletId: string; scope?: "application"; durationMs?: number; idleMs?: number }
  | { action: "lock"; walletId?: string };
export type ManagementResult = { wallet?: WalletInfo; clientId?: string; grantId?: string; freshHistory?: boolean };
export interface WalletQuery {
  wallet: WalletInfo;
  limits: WalletLimits;
  budget: BudgetView | null;
}
export type WalletInspectionSection = "clients" | "grants" | "payments";
export type WalletInspectionRecord =
  | (Pick<RegisteredClient, "clientId" | "generation" | "active" | "kind"> & { credentialReferences?: CredentialReferenceView[] })
  | Pick<PaymentGrant, "grantId" | "clientIds" | "scope" | "origin" | "path" | "pathPrefix" | "method" | "payTo" | "maxAmountAtomic" | "expiresAt" | "status">
  | Pick<PaymentIntent, "scheme" | "actualAmountAtomic" | "intentId" | "requestId" | "clientId" | "origin" | "path" | "method" | "payTo" | "amountAtomic" | "status" | "reserved" | "spent" | "settledAt" | "settlementTx" | "settlementBlock" | "settlementHash" | "network" | "asset">;
export interface WalletInspection extends WalletQuery {
  desktopClient?: Pick<RegisteredClient, "clientId" | "generation" | "active" | "kind"> & { credentialReferences?: CredentialReferenceView[] };
  section: WalletInspectionSection;
  offset: number;
  nextOffset: number | null;
  records: WalletInspectionRecord[];
}
