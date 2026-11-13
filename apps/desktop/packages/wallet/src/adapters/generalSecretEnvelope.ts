import { CompactEncrypt, compactDecrypt } from "jose";
import { WalletError, requireWallet } from "../domain/errors.js";
import { generalDerivationIndex } from "../domain/generalDerivation.js";
import { previewGeneralMnemonic } from "./generalKeyPreview.js";

/** Internal primitive only. The caller must enforce secret admission and protect the key. */
export interface GeneralSecretIdentity {
  ownerId: string;
  keySourceId: string;
  sourceType: "mnemonic";
  address: string;
  derivationPath?: string;
}

const MAX_ENVELOPE_BYTES = 8192;
const HEADER_KEYS = ["alg", "enc", "typ", "version", "ownerId", "keySourceId", "family", "sourceType", "address"];

function invalid(): never {
  throw new WalletError("GENERAL_SECRET_INVALID", "The protected wallet material could not be verified.");
}

function validateIdentity(identity: GeneralSecretIdentity): void {
  if (!identity || typeof identity.ownerId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(identity.ownerId) ||
      typeof identity.keySourceId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(identity.keySourceId) ||
      identity.sourceType !== "mnemonic" ||
      typeof identity.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(identity.address)) invalid();
}

function validateKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) invalid();
}

/** Encrypts a mnemonic source only. Private-key sources use a standard V3 keystore. */
export async function sealGeneralSecret(identity: GeneralSecretIdentity, secret: string, key: Uint8Array): Promise<string> {
  validateIdentity(identity);
  validateKey(key);
  const binding = { ...identity };
  const result = previewGeneralMnemonic(secret, generalDerivationIndex(binding.derivationPath));
  requireWallet(result.address.toLowerCase() === binding.address.toLowerCase(),
    "GENERAL_SECRET_INVALID", "The protected wallet material could not be verified.");
  const normalized = secret.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
  const plaintext = new TextEncoder().encode(normalized);
  const password = Uint8Array.from(key);
  try {
    return await new CompactEncrypt(plaintext).setProtectedHeader({
      alg: "dir", enc: "A256GCM", typ: "koincode-general-secret+jwe", version: 1,
      ownerId: binding.ownerId, keySourceId: binding.keySourceId, family: "evm",
      sourceType: binding.sourceType, address: binding.address.toLowerCase(),
    }).encrypt(password);
  } finally {
    plaintext.fill(0);
    password.fill(0);
  }
}

/** The returned secret must remain inside the admitted trusted worker. */
export async function openGeneralSecret(identity: GeneralSecretIdentity, envelope: string, key: Uint8Array): Promise<string> {
  validateIdentity(identity);
  validateKey(key);
  const binding = { ...identity };
  if (typeof envelope !== "string" || Buffer.byteLength(envelope, "utf8") > MAX_ENVELOPE_BYTES) invalid();
  const password = Uint8Array.from(key);
  let plaintext: Uint8Array | undefined;
  try {
    const result = await compactDecrypt(envelope, password, {
      keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"],
    });
    plaintext = result.plaintext;
    const header = result.protectedHeader;
    if (Object.keys(header).sort().join() !== [...HEADER_KEYS].sort().join() ||
        header.alg !== "dir" || header.enc !== "A256GCM" || header.typ !== "koincode-general-secret+jwe" ||
        header.version !== 1 || header.ownerId !== binding.ownerId || header.keySourceId !== binding.keySourceId ||
        header.family !== "evm" || header.sourceType !== binding.sourceType ||
        header.address !== binding.address.toLowerCase() || plaintext.byteLength > 1024) invalid();
    const secret = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (previewGeneralMnemonic(secret, generalDerivationIndex(binding.derivationPath)).address.toLowerCase() !== binding.address.toLowerCase()) invalid();
    return secret;
  } catch {
    return invalid();
  } finally {
    plaintext?.fill(0);
    password.fill(0);
  }
}
