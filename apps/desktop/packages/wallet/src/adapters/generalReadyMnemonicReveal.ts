import { assertGeneralSecretExport } from "./generalReadySecretExport.js";

export function assertGeneralMnemonicReveal(result: unknown, address: string, derivationPath?: string): string {
  const exported = assertGeneralSecretExport(result, address, "mnemonic", derivationPath);
  return (exported as { phrase: string }).phrase;
}

