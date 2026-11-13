/** A frozen manual-transfer risk; it contains no private key or consumable signature. */
export interface GeneralSigningRisk {
  riskId: string;
  transferId: string;
  intentDigest: string;
  accountAddress: string;
  networkId: string;
  nonce: number;
  asset: string;
  amountAtomic: string;
  maxGasAtomic: string;
  approvalExpiresAt: number;
}

export type GeneralSigningEvent = { version: 1; streamId: string; sequence: number; previousDigest: string;
  phase: "SIGNING_POSSIBLE" | "SIGNED"; risk: GeneralSigningRisk; transactionHash?: string | undefined; digest: string };

/** Independent append-only journal, never a legacy payment database. */
export interface GeneralSigningJournalRepository {
  listStreams(): string[];
  read(streamId: string): GeneralSigningEvent[];
  append(event: GeneralSigningEvent, previousSequence: number, previousDigest: string): void;
  byteSize(): number;
  close(): void;
}
