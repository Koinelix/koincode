import { generalDerivationIndex } from "../domain/generalDerivation.js";
import { openGeneralSecret } from "./generalSecretEnvelope.js";
import { openGeneralPrivateKey } from "./generalPrivateKeyKeystore.js";
import { invalidGeneralBackup, type GeneralBackupPayload } from "./generalBackupPayload.js";
import { generalSourceInputDigest } from "./generalSourceInputDigest.js";

/** Protected worker only. This proves control of selected material, never complete signing continuity. */
export async function verifyGeneralBackupMaterials(payload: GeneralBackupPayload): Promise<void> {
  try {
    const references = new Map(payload.wrappingKeys.map((entry) => [entry.keyRef, entry.key]));
    for (const sourceId of payload.keyCoverage.sourceIds) {
      const source = payload.sourceState.sources.find((entry) => entry.id === sourceId);
      const encoded = source && references.get(source.keyRef);
      if (!source || !encoded) return invalidGeneralBackup();
      const key = Buffer.from(encoded, "base64url");
      try {
        const secret = source.sourceType === "mnemonic" ? await openGeneralSecret({ ownerId: payload.ownerId, keySourceId: source.id,
          sourceType: "mnemonic", address: source.address, derivationPath: source.derivationPath }, source.protectedMaterial, key) : await openGeneralPrivateKey(source.address, source.protectedMaterial, key);
        const operation = payload.sourceState.setups.find((entry) => entry.id === source.setupId);
        if (!operation) return invalidGeneralBackup();
        const input = operation.mode === "create" ? { mode: "create" as const } : operation.mode === "import_mnemonic"
          ? { mode: "import_mnemonic" as const, phrase: secret, accountIndex: generalDerivationIndex(source.derivationPath) } : { mode: "import_private_key" as const, privateKey: secret };
        if (generalSourceInputDigest(input, key) !== source.inputDigest) return invalidGeneralBackup();
      } finally { key.fill(0); }
    }
  } catch { return invalidGeneralBackup(); }
}
