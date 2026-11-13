import type { RemoteHostConfig } from "./contracts.js";

export interface RemoteSessionAuthorizationTarget {
  hostId: string; securityRevision: number; credentialVersion: number; trustRevision: number;
  name: string; endpoint: string; username: string; environment: RemoteHostConfig["environment"];
}
export interface RemoteSessionAuthorizationOffer {
  sessionOfferId: string; workspaceRoot: string; targets: RemoteSessionAuthorizationTarget[];
}
export interface RemoteSessionAuthorizationStatus {
  active: boolean; targets: Array<RemoteSessionAuthorizationTarget & { approvedAt: number }>;
}
