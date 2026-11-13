import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { requireWallet } from "../domain/errors.js";
import { generalDerivationPath } from "../domain/generalDerivation.js";
import { generalSourceInputDigest } from "./generalSourceInputDigest.js";

type Selection = { accountIndex: number; address: string };
type Result = { accountIndex: number; address: string; status: "imported" | "already_exists" | "recovery_required" | "legacy_account" | "failed" };
interface Ports {
  current(): void;
  preview(setupId: string, phrase: string, index: number): Promise<{ address: string }>;
  exists(address: string): boolean | Promise<boolean>;
  begin(): Promise<{ setupId: string }>;
  stage(setupId: string, phrase: string, index: number, address: string): Promise<{ status: "staged" | "already_exists" | "recovery_required" | "legacy_account" }>;
  confirm(setupId: string): Promise<void>;
}
/** Coordinator-owned preview correlation only. Each source still uses the original setup state machine. */
export class GeneralMnemonicImport {
  private value?: { setupId: string; token: string; key: Uint8Array; fingerprint: string; deadline: number; rows: Map<number, string> };
  constructor(private readonly ports: Ports) {}
  clear(setupId?: string): boolean {
    if (!this.value || setupId !== undefined && this.value.setupId !== setupId) return false;
    this.value.key.fill(0); this.value = undefined; return true;
  }
  private current(setupId: string, phrase: string, token?: string) {
    this.ports.current(); const value = this.value;
    requireWallet(value && value.setupId === setupId && performance.now() < value.deadline && (!token || value.token === token),
      "SETUP_CONFLICT", "The account selection expired. Preview it again.");
    const supplied = Buffer.from(generalSourceInputDigest({ mode: "import_mnemonic", phrase }, value.key), "hex");
    requireWallet(timingSafeEqual(supplied, Buffer.from(value.fingerprint, "hex")), "SETUP_CONFLICT", "The mnemonic preview changed.");
    return value;
  }
  async preview(setupId: string, phrase: string, offset: number, token?: string) {
    generalDerivationPath(offset);
    const end = Math.min(offset + 10, 2147483648);
    if (!token) {
      this.clear(); const key = randomBytes(32);
      this.value = { setupId, token: randomUUID(), key, fingerprint: generalSourceInputDigest({ mode: "import_mnemonic", phrase }, key),
        deadline: performance.now() + 300000, rows: new Map() };
    }
    const value = this.current(setupId, phrase, token);
    requireWallet(value.rows.size + Array.from({ length: end - offset }, (_, i) => offset + i).filter(index => !value.rows.has(index)).length <= 1000, "INVALID_REQUEST", "Preview capacity reached. Start a new selection.");
    const accounts = [];
    for (let index = offset; index < end; index++) {
      this.current(setupId, phrase, value.token);
      const result = await this.ports.preview(setupId, phrase, index);
      this.current(setupId, phrase, value.token);
      const alreadyImported = await this.ports.exists(result.address);
      this.current(setupId, phrase, value.token);
      accounts.push({ accountIndex: index, address: result.address, derivationPath: generalDerivationPath(index), alreadyImported });
    }
    this.current(setupId, phrase, value.token);
    for (const account of accounts) value.rows.set(account.accountIndex, account.address);
    return { previewId: value.token, accounts, nextOffset: end <= 2147483647 ? end : null };
  }
  async import(setupId: string, phrase: string, previewId: string, accounts: Selection[]) {
    const original = this.current(setupId, phrase, previewId);
    requireWallet(accounts.length >= 1 && accounts.length <= 20 && new Set(accounts.map(item => item.accountIndex)).size === accounts.length &&
      accounts.every(item => original.rows.get(item.accountIndex) === item.address), "SETUP_CONFLICT", "The selected accounts do not match the preview.");
    const results: Result[] = [];
    let nextSetup = setupId, usedSetup = false;
    try {
      for (const selected of accounts) {
        try {
          this.current(setupId, phrase, previewId);
          const exists = await this.ports.exists(selected.address); this.current(setupId, phrase, previewId);
          if (exists) { results.push({ ...selected, status: "already_exists" }); continue; }
          if (usedSetup) {
            nextSetup = (await this.ports.begin()).setupId;
            this.current(setupId, phrase, previewId);
          }
          await this.ports.preview(nextSetup, phrase, selected.accountIndex);
          this.current(setupId, phrase, previewId);
          const result = await this.ports.stage(nextSetup, phrase, selected.accountIndex, selected.address);
          this.current(setupId, phrase, previewId);
          usedSetup = true;
          if (result.status === "staged") await this.ports.confirm(nextSetup);
          results.push({ ...selected, status: result.status === "staged" ? "imported" : result.status });
          this.current(setupId, phrase, previewId);
        } catch {
          if (!results.some(item => item.accountIndex === selected.accountIndex)) results.push({ ...selected, status: "failed" });
          break;
        }
      }
      return { results };
    } finally { this.clear(setupId); }
  }
}
