import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { withFileLock } from "@fcode/shared/node";

export interface CredentialProtection {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface ServiceCredentialView {
  ref: string;
  version: number;
  origin: string;
  path: string;
}
type Entry = ServiceCredentialView & { active: boolean; secret: string };
type State = { version: 1; entries: Entry[] };
type Envelope = { version: 1; wrappedKey: string; iv: string; tag: string; ciphertext: string };

const AAD = Buffer.from("koincode.service-credentials.v1");
const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const failure = (code: string) => Object.assign(new Error(code), { code });
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function decode(value: unknown, max: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw failure("SERVICE_CREDENTIALS_CORRUPT");
  const result = Buffer.from(value, "base64");
  if (result.length > max || result.toString("base64") !== value) throw failure("SERVICE_CREDENTIALS_CORRUPT");
  return result;
}

function target(value: string, local: boolean): URL {
  let result: URL;
  try { result = new URL(value); } catch { throw failure("SERVICE_TARGET_INVALID"); }
  const loopback = local && result.origin === "http://127.0.0.1:8080";
  if (result.username || result.password || result.hash || result.href.length > 8192 ||
      !(loopback || (result.protocol === "https:" && (!result.port || result.port === "443"))))
    throw failure("SERVICE_TARGET_INVALID");
  return result;
}

function scope(origin: string, path: string, local: boolean): { origin: string; path: string } {
  const base = target(origin, local);
  if (base.origin !== origin || base.pathname !== "/" || base.search ||
      !path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#"))
    throw failure("SERVICE_TARGET_INVALID");
  const url = target(new URL(path, `${origin}/`).href, local);
  if (url.origin !== origin || url.pathname !== path || url.search) throw failure("SERVICE_TARGET_INVALID");
  return { origin, path };
}

function validSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !/[\r\n]/.test(value) && !value.includes(String.fromCharCode(0));
}

function parseState(value: unknown, local: boolean): State {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES)
    throw failure("SERVICE_CREDENTIALS_CORRUPT");
  const seen = new Set<string>();
  const entries = value.entries.map((entry): Entry => {
    if (!isObject(entry) || typeof entry.ref !== "string" || !UUID.test(entry.ref) || seen.has(entry.ref) ||
        typeof entry.version !== "number" || !Number.isSafeInteger(entry.version) || entry.version < 1 ||
        typeof entry.origin !== "string" || typeof entry.path !== "string" || typeof entry.active !== "boolean" ||
        (entry.active ? !validSecret(entry.secret) : entry.secret !== ""))
      throw failure("SERVICE_CREDENTIALS_CORRUPT");
    seen.add(entry.ref);
    try { scope(entry.origin, entry.path, local); } catch { throw failure("SERVICE_CREDENTIALS_CORRUPT"); }
    return { ref: entry.ref, version: entry.version, origin: entry.origin, path: entry.path,
      active: entry.active, secret: entry.secret as string };
  });
  return { version: 1, entries };
}

/** Main-process-only owner. Never expose resolve() through renderer or agent RPC. */
const activeCredentialLeases = new Map<string, Map<string, Set<AbortController>>>();
const uncertainCredentialLeases = new Set<string>();

export class ServiceCredentialStore {
  private readonly file: string;
  constructor(private readonly directory: string, private readonly protection: CredentialProtection,
    private readonly allowLocalTest = false) {
    this.file = join(directory, "credentials.enc");
  }

  async list(): Promise<ServiceCredentialView[]> {
    return this.locked(async (state) => state.entries.filter((entry) => entry.active).map(view));
  }

  async save(input: { origin: string; path: string; secret: string; ref?: string },
    assertCurrent: () => void = () => {}): Promise<ServiceCredentialView> {
    const normalized = scope(input.origin, input.path, this.allowLocalTest);
    if (!validSecret(input.secret) || (input.ref !== undefined && !UUID.test(input.ref)))
      throw failure("SERVICE_CREDENTIAL_INVALID");
    if (input.ref) this.invalidateLeases(input.ref);
    return this.locked(async (state) => {
      if (uncertainCredentialLeases.has(this.file)) throw failure("SERVICE_CREDENTIAL_DRAIN_UNCERTAIN");
      assertCurrent();
      const prior = input.ref ? state.entries.find((entry) => entry.ref === input.ref) : undefined;
      if (input.ref && (!prior || !prior.active)) throw failure("SERVICE_CREDENTIAL_NOT_FOUND");
      if (prior && (prior.origin !== normalized.origin || prior.path !== normalized.path))
        throw failure("SERVICE_CREDENTIAL_SCOPE_CHANGED");
      if (!prior && state.entries.length >= MAX_ENTRIES) throw failure("SERVICE_CREDENTIAL_CAPACITY");
      const version = prior ? prior.version + 1 : 1;
      if (!Number.isSafeInteger(version)) throw failure("SERVICE_CREDENTIAL_CAPACITY");
      const entry: Entry = { ref: prior?.ref ?? randomUUID(), version, ...normalized, active: true, secret: input.secret };
      if (prior) state.entries[state.entries.indexOf(prior)] = entry; else state.entries.push(entry);
      await this.write(state, assertCurrent);
      return view(entry);
    });
  }

  async revoke(ref: string, assertCurrent: () => void = () => {}): Promise<void> {
    if (!UUID.test(ref)) throw failure("SERVICE_CREDENTIAL_INVALID");
    this.invalidateLeases(ref);
    await this.locked(async (state) => {
      if (uncertainCredentialLeases.has(this.file)) throw failure("SERVICE_CREDENTIAL_DRAIN_UNCERTAIN");
      assertCurrent();
      const entry = state.entries.find((item) => item.ref === ref);
      if (!entry || !entry.active) throw failure("SERVICE_CREDENTIAL_NOT_FOUND");
      if (!Number.isSafeInteger(entry.version + 1)) throw failure("SERVICE_CREDENTIAL_CAPACITY");
      entry.version++; entry.active = false; entry.secret = "";
      await this.write(state, assertCurrent);
    });
  }

  async resolve(ref: string, url: string, version: number): Promise<string> {
    if (!UUID.test(ref) || !Number.isSafeInteger(version) || version < 1) throw failure("SERVICE_CREDENTIAL_INVALID");
    const requested = target(url, this.allowLocalTest);
    return this.locked(async (state) => matchingEntry(state, ref, requested, version).secret);
  }

  async assertCurrent(ref: string, url: string, version: number): Promise<void> {
    if (!UUID.test(ref) || !Number.isSafeInteger(version) || version < 1) throw failure("SERVICE_CREDENTIAL_INVALID");
    const requested = target(url, this.allowLocalTest);
    await this.locked(async (state) => { matchingEntry(state, ref, requested, version); });
  }

  /** The action must drain before a replacement or revocation can acknowledge. */
  async withCurrent<T>(ref: string, url: string, version: number, action: (secret: string) => Promise<T>): Promise<T> {
    if (!UUID.test(ref) || !Number.isSafeInteger(version) || version < 1 || typeof action !== "function")
      throw failure("SERVICE_CREDENTIAL_INVALID");
    const requested = target(url, this.allowLocalTest);
    return this.locked(async (state) => action(matchingEntry(state, ref, requested, version).secret));
  }

  /** All referenced versions remain current until the protected action has drained. */
  async withCurrentMany<T>(entries: ReadonlyArray<{ ref: string; url: string; version: number }>,
    action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!Array.isArray(entries) || entries.length > 128 || typeof action !== "function")
      throw failure("SERVICE_CREDENTIAL_INVALID");
    const targets = entries.map(entry => {
      if (!UUID.test(entry.ref) || !Number.isSafeInteger(entry.version) || entry.version < 1)
        throw failure("SERVICE_CREDENTIAL_INVALID");
      return { ...entry, requested: target(entry.url, this.allowLocalTest) };
    });
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let activeLeases = activeCredentialLeases.get(this.file);
    if (!activeLeases) { activeLeases = new Map(); activeCredentialLeases.set(this.file, activeLeases); }
    for (const { ref } of targets) {
      let leases = activeLeases.get(ref);
      if (!leases) { leases = new Set(); activeLeases.set(ref, leases); }
      leases.add(controller);
    }
    const work = this.locked(async state => {
      combined.throwIfAborted();
      for (const entry of targets) matchingEntry(state, entry.ref, entry.requested, entry.version);
      combined.throwIfAborted();
      try { return await action(combined); }
      catch (error) {
        if (isObject(error) && error.code === "WALLET_DRAIN_UNCERTAIN") uncertainCredentialLeases.add(this.file);
        throw error;
      }
    });
    let abort!: () => void;
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(failure("SERVICE_INTERACTION_CANCELED"));
      if (combined.aborted) abort(); else combined.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([work, canceled]); }
    finally {
      combined.removeEventListener("abort", abort);
      for (const { ref } of targets) {
        const leases = activeLeases!.get(ref); leases?.delete(controller);
        if (!leases?.size) activeLeases!.delete(ref);
      }
      if (!activeLeases!.size) activeCredentialLeases.delete(this.file);
    }
  }

  private invalidateLeases(ref: string): void {
    for (const lease of activeCredentialLeases.get(this.file)?.get(ref) ?? []) lease.abort();
  }

  /** Used only by an explicit trusted first-configuration action. */
  async withFreshStore<T>(action: () => Promise<T>): Promise<T> {
    if (typeof action !== "function") throw failure("SERVICE_CREDENTIAL_INVALID");
    return this.locked(async (state) => {
      if (state.entries.length) throw failure("SERVICE_HISTORY_INITIALIZATION_DENIED");
      return action();
    });
  }

  private async locked<T>(action: (state: State) => Promise<T>): Promise<T> {
    if (!this.protection.isEncryptionAvailable()) throw failure("SERVICE_PROTECTION_UNAVAILABLE");
    if (process.platform === "linux" && !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]
      .includes(this.protection.getSelectedStorageBackend?.() ?? "")) throw failure("SERVICE_PROTECTION_UNAVAILABLE");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
      throw failure("SERVICE_CREDENTIAL_DIRECTORY_UNSAFE");
    try {
      const directory = await open(this.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { throw failure("SERVICE_CREDENTIALS_UNAVAILABLE"); }
    return withFileLock(this.file, async () => action(await this.read()));
  }

  private async read(): Promise<State> {
    let file;
    try { file = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if (isObject(error) && error.code === "ENOENT") return { version: 1, entries: [] };
      throw failure("SERVICE_CREDENTIALS_UNAVAILABLE");
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
        throw failure("SERVICE_CREDENTIALS_CORRUPT");
      const envelope: unknown = JSON.parse(await file.readFile({ encoding: "utf8" }));
      if (!isObject(envelope) || envelope.version !== 1) throw failure("SERVICE_CREDENTIALS_CORRUPT");
      const wrapped = decode(envelope.wrappedKey, 4096), iv = decode(envelope.iv, 12),
        tag = decode(envelope.tag, 16), ciphertext = decode(envelope.ciphertext, MAX_BYTES);
      if (iv.length !== 12 || tag.length !== 16) throw failure("SERVICE_CREDENTIALS_CORRUPT");
      const key = decode(this.protection.decryptString(wrapped), 32);
      try {
        if (key.length !== 32) throw failure("SERVICE_CREDENTIALS_CORRUPT");
        const cipher = createDecipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(AAD); cipher.setAuthTag(tag);
        const plain = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
        try { return parseState(JSON.parse(plain.toString("utf8")), this.allowLocalTest); }
        finally { plain.fill(0); }
      } finally { key.fill(0); }
    } catch { throw failure("SERVICE_CREDENTIALS_CORRUPT"); }
    finally { await file.close(); }
  }

  private async write(state: State, assertCurrent: () => void): Promise<void> {
    const key = randomBytes(32), iv = randomBytes(12), plain = Buffer.from(JSON.stringify(state));
    const temp = `${this.file}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const wrappedKey = this.protection.encryptString(key.toString("base64"));
      const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      const envelope: Envelope = { version: 1, wrappedKey: wrappedKey.toString("base64"), iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
      const serialized = JSON.stringify(envelope);
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw failure("SERVICE_CREDENTIAL_CAPACITY");
      const output = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await output.writeFile(serialized, "utf8"); await output.sync(); }
      finally { await output.close(); }
      assertCurrent();
      await rename(temp, this.file);
      const directory = await open(this.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { key.fill(0); plain.fill(0); await rm(temp, { force: true }).catch(() => {}); }
  }
}

function view(entry: Entry): ServiceCredentialView {
  return { ref: entry.ref, version: entry.version, origin: entry.origin, path: entry.path };
}

function matchingEntry(state: State, ref: string, requested: URL, version: number): Entry {
  const entry = state.entries.find((item) => item.ref === ref);
  if (!entry || !entry.active || entry.version !== version ||
      entry.origin !== requested.origin || entry.path !== requested.pathname)
    throw failure("SERVICE_CREDENTIAL_SCOPE_DENIED");
  return entry;
}
