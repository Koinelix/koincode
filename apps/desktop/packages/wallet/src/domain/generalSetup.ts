import { requireWallet } from "./errors.js";

export type GeneralSetupPhase = "started" | "secret_staged" | "backup_pending" | "ready" | "canceled";
export type SecretAdmission = "unverified" | "verified" | "local_system" | "unavailable";
export type GeneralSetupMode = "create" | "import_mnemonic" | "import_private_key";
export interface GeneralSetupOperation {
  id: string;
  mode: GeneralSetupMode;
  createdAt: number;
  inputBinding: string;
  phase: GeneralSetupPhase;
  stagedCommitment?: string;
  resumePhase?: "secret_staged" | "backup_pending";
  pendingKeyRef?: string;
  backupPositions?: number[];
}

export type GeneralSetupEvent =
  | { type: "begin"; id: string; mode: GeneralSetupMode; inputBinding: string; createdAt: number }
  | { type: "stageCommitted"; id: string; stagedCommitment: string }
  | { type: "reveal" | "confirm" | "confirmImported" | "cancel" | "resume"; id: string };

const active = (item: GeneralSetupOperation) =>
  item.phase === "started" || item.phase === "secret_staged" || item.phase === "backup_pending";
const pendingMaterial = (item: GeneralSetupOperation) => item.phase !== "ready" && !!item.stagedCommitment;

/**
 * Pure transition logic; the owner must authenticate admission, durable receipts and backup confirmation.
 * Bindings are protected-domain identifiers, never the secret or a plain mnemonic hash.
 */
export function transitionGeneralSetup(
  operations: readonly GeneralSetupOperation[],
  event: GeneralSetupEvent,
  admission: SecretAdmission,
): readonly GeneralSetupOperation[] {
  requireWallet(/^[a-zA-Z0-9-]{1,80}$/.test(event.id), "INVALID_REQUEST", "Invalid setup identity.");
  const current = operations.find((item) => item.id === event.id);
  if (event.type === "begin") {
    requireWallet((admission === "verified" || admission === "local_system"), "SECRET_ADMISSION_UNAVAILABLE", "Secret admission is unavailable.");
    requireWallet(["create", "import_mnemonic", "import_private_key"].includes(event.mode), "INVALID_REQUEST", "Invalid setup mode.");
    requireWallet(Number.isSafeInteger(event.createdAt) && event.createdAt >= 0, "INVALID_REQUEST", "Invalid setup time.");
    requireWallet(/^[a-f0-9]{64}$/.test(event.inputBinding), "INVALID_REQUEST", "Invalid protected setup binding.");
    if (current) {
      requireWallet(current.inputBinding === event.inputBinding && current.mode === event.mode && current.createdAt === event.createdAt,
        "SETUP_CONFLICT", "Setup identity is already bound.");
      return operations;
    }
    requireWallet(!operations.some(active) && operations.filter(pendingMaterial).length < 5,
      "SETUP_CAPACITY_REACHED", "The setup capacity has been reached.");
    return [...operations, { id: event.id, mode: event.mode, createdAt: event.createdAt, inputBinding: event.inputBinding, phase: "started" }];
  }
  requireWallet(current, "SETUP_NOT_FOUND", "The setup operation was not found.");
  let next: GeneralSetupOperation;
  if (event.type === "stageCommitted") {
    requireWallet((admission === "verified" || admission === "local_system"), "SECRET_ADMISSION_UNAVAILABLE", "Secret admission is unavailable.");
    requireWallet(/^[a-f0-9]{64}$/.test(event.stagedCommitment), "INVALID_REQUEST", "Invalid staged commitment.");
    if (current.stagedCommitment === event.stagedCommitment && current.phase !== "started") return operations;
    requireWallet(current.phase === "started", "SETUP_CONFLICT", "The setup cannot accept new material.");
    next = { ...current, phase: "secret_staged", stagedCommitment: event.stagedCommitment };
  } else if (event.type === "reveal") {
    requireWallet((admission === "verified" || admission === "local_system"), "SECRET_ADMISSION_UNAVAILABLE", "Secret admission is unavailable.");
    requireWallet(current.mode === "create" && current.phase === "secret_staged" && current.stagedCommitment,
      "SETUP_NOT_STAGED", "Durably staged material is required before display.");
    next = { ...current, phase: "backup_pending" };
  } else if (event.type === "confirm") {
    requireWallet((admission === "verified" || admission === "local_system"), "SECRET_ADMISSION_UNAVAILABLE", "Secret admission is unavailable.");
    requireWallet(current.mode === "create" && current.phase === "backup_pending" && current.stagedCommitment,
      "SETUP_CONFLICT", "The backup confirmation is not ready.");
    next = { ...current, phase: "ready", resumePhase: undefined };
  } else if (event.type === "confirmImported") {
    requireWallet((admission === "verified" || admission === "local_system"), "SECRET_ADMISSION_UNAVAILABLE", "Secret admission is unavailable.");
    requireWallet(current.mode !== "create" && current.phase === "secret_staged" && current.stagedCommitment,
      "SETUP_CONFLICT", "The imported account is not ready.");
    next = { ...current, phase: "ready", resumePhase: undefined };
  } else if (event.type === "cancel") {
    if (current.phase === "canceled") return operations;
    requireWallet(active(current), "SETUP_CONFLICT", "A completed setup cannot be canceled.");
    next = {
      ...current,
      phase: "canceled",
      ...(current.phase === "secret_staged" || current.phase === "backup_pending"
        ? { resumePhase: current.phase }
        : {}),
    };
  } else {
    requireWallet((admission === "verified" || admission === "local_system"), "SECRET_ADMISSION_UNAVAILABLE", "Secret admission is unavailable.");
    requireWallet(current.phase === "canceled" && current.stagedCommitment && current.resumePhase &&
      !operations.some((item) => item.id !== current.id && active(item)),
    "SETUP_CONFLICT", "The staged setup cannot be resumed.");
    next = { ...current, phase: current.resumePhase, resumePhase: undefined };
  }
  return operations.map((item) => item.id === current.id ? next : item);
}
