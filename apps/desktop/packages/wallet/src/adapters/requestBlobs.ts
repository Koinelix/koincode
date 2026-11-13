import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, open, lstat, realpath, opendir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import type { BlobStore, ResponseReservation } from "../app/requestPorts.js";
import type { ProtectedStore, ResponseSecretStore } from "../app/ports.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { RESPONSE_LIMIT } from "../domain/requestValidation.js";
import {
  ResponseBudget,
  RESPONSE_STORAGE_LIMIT,
  RESPONSE_BLOB_ENTRY_LIMIT,
  storedBlobCharge,
  BLOB_ENVELOPE_BYTES,
  RESPONSE_RESERVATION_BYTES,
} from "../app/responseBudget.js";
interface ResponseRemovalStore extends ResponseSecretStore {
  removeResponseFile(ref: string, directoryFd: number): Promise<void>;
}
export class EncryptedRequestBlobs implements BlobStore {
  private readonly reservations = new WeakMap<ResponseReservation, ReturnType<ResponseBudget["reserve"]>>();
  private readonly writes = new Map<string, Promise<string>>();
  private readonly removals = new Map<string, Promise<void>>();
  private readonly retired = new Set<string>();
  private constructor(
    private readonly directory: string,
    private readonly protection: ProtectedStore,
    private readonly budget: ResponseBudget,
    private readonly charges: Map<string, number>,
    private readonly identity: { dev: number; ino: number },
  ) {}
  static async open(directory: string, protection: ProtectedStore): Promise<EncryptedRequestBlobs> {
    requireWallet(
      resolve(directory) === directory,
      "UNSAFE_STORAGE_PATH",
      "An absolute blob root is required.",
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    requireWallet(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        (info.mode & 0o077) === 0 &&
        (await realpath(directory)) === directory,
      "UNSAFE_STORAGE_PATH",
      "A private canonical blob directory is required.",
    );
    let used = 0,
      entries = 0;
    const charges = new Map<string, number>();
    const inventory = await opendir(directory);
    for await (const entry of inventory) {
      // An over-limit legacy inventory remains readable, but cannot admit new writes.
      // entries is an over-limit sentinel here, not a claim to have counted the full directory.
      if (++entries > RESPONSE_BLOB_ENTRY_LIMIT) break;
      const file = await lstat(join(directory, entry.name));
      requireWallet(
        file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0,
        "RESPONSE_STORAGE_UNAVAILABLE",
        "The protected blob inventory contains an unsafe entry.",
      );
      used += storedBlobCharge(file.size);
      charges.set(entry.name, storedBlobCharge(file.size));
      requireWallet(
        Number.isSafeInteger(used),
        "RESPONSE_STORAGE_UNAVAILABLE",
        "The protected blob inventory is too large.",
      );
    }
    return new EncryptedRequestBlobs(
      directory,
      protection,
      new ResponseBudget(used, RESPONSE_STORAGE_LIMIT, entries),
      charges,
      { dev: info.dev, ino: info.ino },
    );
  }
  reserveResponse(purpose?: "payment-material"): ResponseReservation {
    const metadataOnly = purpose === "payment-material";
    const reservation = metadataOnly ? this.budget.reservePaymentMaterial() : this.budget.reserve(RESPONSE_RESERVATION_BYTES, true);
    const handle: ResponseReservation = {
      put: (value) => this.write(value, reservation),
      release: reservation.release,
    };
    if (!metadataOnly) this.reservations.set(handle, reservation);
    return handle;
  }
  /** Internal: the lifecycle owner must first commit this reference in its retention journal. */
  async putRetained(ref: string, value: Uint8Array, handle: ResponseReservation): Promise<void> {
    this.validateReference(ref);
    const reservation = this.reservations.get(handle);
    requireWallet(reservation, "RESPONSE_RESERVATION_INVALID", "The reservation belongs to another blob store.");
    await this.write(value, reservation, ref);
  }
  /** Internal: caller must durably prohibit reads and recreation before invoking cleanup. */
  removeRetained(ref: string): Promise<void> {
    this.validateReference(ref);
    const protection = this.protection as Partial<ResponseRemovalStore>;
    requireWallet(typeof protection.removeResponseSecret === "function" &&
      typeof protection.removeResponseFile === "function", "RESPONSE_STORAGE_UNAVAILABLE",
      "Protected response deletion is unavailable.");
    this.retired.add(ref);
    const pending = this.removals.get(ref);
    if (pending) return pending;
    const removal = this.remove(ref, protection as ResponseRemovalStore);
    this.removals.set(ref, removal);
    void removal.finally(() => this.removals.delete(ref)).catch(() => {});
    return removal;
  }
  private async remove(ref: string, protection: ResponseRemovalStore): Promise<void> {
    await this.writes.get(ref)?.catch(() => {});
    await this.checkDirectory();
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      const info = await directory.stat();
      requireWallet(info.isDirectory() && info.dev === this.identity.dev && info.ino === this.identity.ino &&
        (info.mode & 0o077) === 0, "UNSAFE_STORAGE_PATH", "The protected blob directory changed.");
      await protection.removeResponseSecret("http-blob:" + ref);
      await protection.removeResponseFile(ref, directory.fd);
    } finally { await directory.close(); }
    const charge = this.charges.get(ref);
    if (charge !== undefined) {
      this.budget.reclaim(charge);
      this.charges.delete(ref);
    }
  }
  private validateReference(ref: string): void {
    requireWallet(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref),
      "REQUEST_CONTEXT_UNAVAILABLE", "The protected blob reference is invalid.");
  }
  private async checkDirectory(): Promise<void> {
    const info = await lstat(this.directory);
    requireWallet(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 &&
      info.dev === this.identity.dev && info.ino === this.identity.ino &&
      await realpath(this.directory) === this.directory,
    "UNSAFE_STORAGE_PATH", "The protected blob directory changed.");
  }
  async put(value: Uint8Array): Promise<string> {
    this.validateSize(value);
    const reservation = this.budget.reserve(
      storedBlobCharge(value.byteLength + BLOB_ENVELOPE_BYTES),
    );
    try {
      return await this.write(value, reservation);
    } finally {
      reservation.release();
    }
  }
  private validateSize(value: Uint8Array): void {
    requireWallet(
      value.byteLength <= RESPONSE_LIMIT,
      "REQUEST_TOO_LARGE",
      "The protected blob exceeds its limit.",
    );
  }
  private write(
    value: Uint8Array,
    reservation: ReturnType<ResponseBudget["reserve"]>,
    assignedRef?: string,
  ): Promise<string> {
    const ref = assignedRef ?? randomUUID();
    requireWallet(!this.retired.has(ref) && !this.writes.has(ref), "RESPONSE_RETENTION_UNAVAILABLE",
      "The protected reference is retired or already writing.");
    const operation = this.writeFile(value, reservation, ref, assignedRef !== undefined);
    this.writes.set(ref, operation);
    void operation.finally(() => this.writes.delete(ref)).catch(() => {});
    return operation;
  }
  private async writeFile(value: Uint8Array, reservation: ReturnType<ResponseBudget["reserve"]>,
    ref: string, assigned: boolean): Promise<string> {
    this.validateSize(value);
    const charge = storedBlobCharge(value.byteLength + BLOB_ENVELOPE_BYTES);
    reservation.spend(charge);
    const key = randomBytes(32),
      iv = randomBytes(12);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(ref));
      const bytes = Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
      await this.checkDirectory();
      const file = await open(
        join(this.directory, ref),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      this.charges.set(ref, charge);
      try {
        // Durably name the orphan before a protected key can be created.
        await file.sync();
        await this.syncDirectory();
        if (assigned) {
          const existing = await this.protection.get("http-blob:" + ref);
          const absent = existing === null;
          existing?.fill(0);
          requireWallet(absent, "RESPONSE_RETENTION_UNAVAILABLE", "The protected reference already has a key.");
        }
        await this.protection.put("http-blob:" + ref, key);
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.syncDirectory();
      return ref;
    } finally {
      key.fill(0);
    }
  }
  private async syncDirectory(): Promise<void> {
    const dir = await open(this.directory, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  async get(ref: string): Promise<Uint8Array> {
    requireWallet(
      /^[0-9a-f-]{36}$/.test(ref),
      "REQUEST_CONTEXT_UNAVAILABLE",
      "The protected blob reference is invalid.",
    );
    requireWallet(!this.retired.has(ref), "RESPONSE_RETENTION_UNAVAILABLE", "The response is being removed.");
    const key = await this.protection.get("http-blob:" + ref);
    requireWallet(
      key?.length === 32,
      "REQUEST_CONTEXT_UNAVAILABLE",
      "The protected blob key is unavailable.",
    );
    try {
      const file = await open(
        join(this.directory, ref),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let bytes: Buffer;
      try {
        const info = await file.stat();
        requireWallet(
          info.isFile() &&
            info.size >= 28 &&
            info.size <= RESPONSE_LIMIT + 28 &&
            (info.mode & 0o077) === 0,
          "REQUEST_CONTEXT_UNAVAILABLE",
          "The protected blob file is invalid.",
        );
        bytes = await file.readFile();
      } finally {
        await file.close();
      }
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(ref));
      decipher.setAuthTag(bytes.subarray(-16));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
      if (this.retired.has(ref)) {
        plaintext.fill(0);
        throw new Error("The response was removed while reading.");
      }
      return plaintext;
    } catch {
      throw new WalletError(
        "REQUEST_CONTEXT_UNAVAILABLE",
        "The protected blob is missing or damaged.",
      );
    } finally {
      key.fill(0);
    }
  }
}
