import { generalDerivationPath } from "../domain/generalDerivation.js";
import { createHmac } from "node:crypto";
import { requireWallet } from "../domain/errors.js";

type Input = { mode: "create" } | { mode: "import_mnemonic"; phrase: string; confirmedAddress?: string; accountIndex?: number }
  | { mode: "import_private_key"; privateKey: string; confirmedAddress?: string };

/** The original setup input binding, shared with authenticated backup material verification. */
export function generalSourceInputDigest(input: Input, key: Uint8Array): string {
  let normalized = "";
  if (input.mode === "import_mnemonic") {
    requireWallet(typeof input.phrase === "string" && Buffer.byteLength(input.phrase) <= 1024,
      "INVALID_MNEMONIC", "Invalid mnemonic input.");
    normalized = input.phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
  } else if (input.mode === "import_private_key") {
    requireWallet(typeof input.privateKey === "string" && Buffer.byteLength(input.privateKey) <= 256,
      "INVALID_PRIVATE_KEY", "Invalid private key input.");
    normalized = input.privateKey.trim().replace(/^0x/, "").toLowerCase();
  }
  if (input.mode === "import_mnemonic" && (input.accountIndex ?? 0) !== 0) normalized += `\0${generalDerivationPath(input.accountIndex)}`;
  return createHmac("sha256", key).update(input.mode).update("\0").update(normalized).digest("hex");
}
