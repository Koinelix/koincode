import { win32 } from "node:path";
import { opendir, lstat } from "node:fs/promises";
import { windowsRemoteHostNative, windowsSecurityFailure, WindowsPrivatePathMissing, type WindowsHandle, type WindowsSecurityDescriptor } from "./windowsNative.js";

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const FULL_CONTROL = 0x1f01ff;
const DANGEROUS_PARENT_RIGHTS = 0x10000000 | 0x40000000 | 0x40000 | 0x80000 | 0x10000 | 0x40 | 0x100 | 0x10;

export interface WindowsPrivateStorageApi {
  readonly userSid: string;
  createDirectory(path: string): void;
  openPath(path: string): { handle: WindowsHandle; directory: boolean };
  security(handle: WindowsHandle): WindowsSecurityDescriptor;
  isFixedDrive(root: string): boolean;
  close(handle: WindowsHandle): void;
}

/** Reject device namespaces, UNC paths, ADS, ambiguous components and filesystem aliases. */
export function windowsPrivatePathComponents(path: string): string[] {
  if (!/^[a-zA-Z]:\\/.test(path) || [...path].some((character) => character.charCodeAt(0) < 32 || character === "/") ||
    path.length > 32760 || win32.normalize(path) !== path) throw windowsSecurityFailure();
  const segments = path.slice(3).split("\\");
  if (!segments.length || segments.some((segment) => !segment || segment.length > 255 || /[<>:"|?*]/.test(segment) || /[ .]$/.test(segment) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) throw windowsSecurityFailure();
  const values = [path.slice(0, 3)];
  for (const segment of segments) values.push(win32.join(values.at(-1)!, segment));
  return values;
}

export function assertWindowsPrivateStorageSecurity(actual: WindowsSecurityDescriptor, userSid: string, directory: boolean): void {
  if (actual.owner !== userSid || actual.entries.length !== 2) throw windowsSecurityFailure();
  const identities = new Set<string>();
  for (const entry of actual.entries) {
    if (entry.type !== 0 || entry.mask !== FULL_CONTROL || (entry.sid !== userSid && entry.sid !== SYSTEM_SID) || identities.has(entry.sid)) throw windowsSecurityFailure();
    // Inherited children retain the same private principals; only directory ACEs may propagate.
    const expectedFlags = directory ? 3 : 0;
    if ((entry.flags & ~0x10) !== expectedFlags) throw windowsSecurityFailure();
    identities.add(entry.sid);
  }
}

function assertParentSecurity(actual: WindowsSecurityDescriptor, userSid: string): void {
  const privileged = new Set([userSid, SYSTEM_SID, ADMINISTRATORS_SID, TRUSTED_INSTALLER_SID]);
  if (!privileged.has(actual.owner)) throw windowsSecurityFailure();
  for (const entry of actual.entries) {
    if (entry.type !== 0) throw windowsSecurityFailure();
    if (!(entry.flags & 8) && !privileged.has(entry.sid) && (entry.mask & DANGEROUS_PARENT_RIGHTS)) throw windowsSecurityFailure();
  }
}

/** Retained directory handles deny rename/deletion for the complete broker lifetime. */
export class WindowsRemoteHostStorageGuard {
  private readonly roots = new Map<string, WindowsHandle[]>();
  private disposed = false;
  constructor(private readonly api: WindowsPrivateStorageApi) {}

  private key(path: string): string { return path.toLocaleLowerCase("en-US"); }
  async protect(path: string, directory: boolean): Promise<void> {
    windowsPrivatePathComponents(path);
    const key = this.key(path);
    if (this.disposed || ![...this.roots.keys()].some((root) => key === root || key.startsWith(root + "\\"))) throw windowsSecurityFailure();
    const opened = this.api.openPath(path);
    try {
      if (opened.directory !== directory) throw windowsSecurityFailure();
      const security = this.api.security(opened.handle);
      assertWindowsPrivateStorageSecurity(security, this.api.userSid, directory);
      if (this.roots.has(key) && !security.protected) throw windowsSecurityFailure();
    } finally { this.api.close(opened.handle); }
  }
  async createDirectory(path: string): Promise<void> {
    const parts = windowsPrivatePathComponents(path);
    if (this.disposed) throw windowsSecurityFailure();
    if (!this.api.isFixedDrive(parts[0]!)) throw windowsSecurityFailure();
    const existing = this.roots.get(this.key(path));
    if (existing) { await this.protect(path, true); return; }
    const base = this.roots.keys().next().value;
    const key = this.key(path);
    if (base && !key.startsWith(base + "\\")) throw windowsSecurityFailure();
    const held: WindowsHandle[] = [];
    try {
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        let opened: ReturnType<WindowsPrivateStorageApi["openPath"]>;
        try { opened = this.api.openPath(part); }
        catch (error) {
          if (i === 0 || !(error instanceof WindowsPrivatePathMissing)) throw error;
          this.api.createDirectory(part); opened = this.api.openPath(part);
        }
        held.push(opened.handle);
        if (!opened.directory) throw windowsSecurityFailure();
        const security = this.api.security(opened.handle);
        if (i === parts.length - 1 || (base && (this.key(part) === base || this.key(part).startsWith(base + "\\")))) {
          assertWindowsPrivateStorageSecurity(security, this.api.userSid, true);
          if (i === parts.length - 1 && !security.protected) throw windowsSecurityFailure();
        }
        else assertParentSecurity(security, this.api.userSid);
      }
      if (base) for (const handle of held.splice(0).reverse()) this.api.close(handle);
      else this.roots.set(key, held);
    } catch (error) {
      for (const handle of held.reverse()) this.api.close(handle);
      throw error;
    }
  }
  /** Run only for the broker root, before opening any existing SQLite file or snapshot. */
  async verifyExistingTree(root: string): Promise<void> {
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 64) throw windowsSecurityFailure();
      // Stream metadata so a valid 1 GiB snapshot is not narrowed to an arbitrary file count.
      for await (const entry of await opendir(directory)) {
        const path = win32.join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) throw windowsSecurityFailure();
        await this.protect(path, info.isDirectory());
        if (info.isDirectory()) await visit(path, depth + 1);
      }
    };
    await visit(root, 0);
  }
  dispose(): void {
    this.disposed = true;
    const values = [...this.roots.values()]; this.roots.clear();
    let failure: unknown;
    for (const handles of values.reverse()) for (const handle of handles.reverse()) {
      try { this.api.close(handle); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}

let guard: Promise<WindowsRemoteHostStorageGuard> | undefined;
function storageGuard(): Promise<WindowsRemoteHostStorageGuard> {
  return guard ??= windowsRemoteHostNative().then((api) => new WindowsRemoteHostStorageGuard(api));
}
export async function createWindowsRemoteHostPrivateDirectory(path: string): Promise<void> { await (await storageGuard()).createDirectory(path); }
export async function verifyWindowsRemoteHostPrivatePath(path: string, directory: boolean): Promise<void> { await (await storageGuard()).protect(path, directory); }
export async function prepareWindowsRemoteHostStorage(path: string): Promise<void> {
  const current = await storageGuard();
  try { await current.createDirectory(path); await current.verifyExistingTree(path); }
  catch (error) { current.dispose(); guard = undefined; throw error; }
}
export async function disposeWindowsRemoteHostStorage(): Promise<void> {
  const current = guard; guard = undefined;
  if (current) (await current).dispose();
}
