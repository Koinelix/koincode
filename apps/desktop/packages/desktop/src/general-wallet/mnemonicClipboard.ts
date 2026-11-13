/** Copy only explicitly displayed canonical words from the current private window. Never read the clipboard. */
export function copyGeneralMnemonic(value: unknown, ports: { assertCurrent(): void; writeText(value: string): void }): void {
  ports.assertCurrent();
  if (typeof value !== "string" || value.length > 256 || value !== value.trim() || !/^[a-z]+(?: [a-z]+){11}$/.test(value))
    throw new Error("GENERAL_COPY_INVALID");
  ports.assertCurrent(); ports.writeText(value);
}
