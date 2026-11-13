import { RemoteHostError } from "@fcode/shared";
import type * as Koffi from "koffi";
import type { WindowsPendingIo, WindowsIoState } from "./windowsIo.js";

export type WindowsHandle = object;
export class WindowsPrivatePathMissing extends Error {
  constructor() { super("The private Windows path does not exist."); }
}
export interface WindowsAclEntry { type: number; flags: number; mask: number; sid: string }
export interface WindowsSecurityDescriptor { owner: string; protected: boolean; entries: WindowsAclEntry[] }
export interface WindowsNativeIo extends WindowsPendingIo { contents(bytes: number): Buffer }

/** Kept as declarations so ABI parsing can be checked without loading Windows DLLs. */
export const WINDOWS_REMOTE_HOST_DECLARATIONS = {
  CreateNamedPipeW: "void * __stdcall CreateNamedPipeW(str16, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, void *)",
  ConnectNamedPipe: "int __stdcall ConnectNamedPipe(void *, void *)",
  ReadFile: "int __stdcall ReadFile(void *, void *, uint32_t, void *, void *)",
  WriteFile: "int __stdcall WriteFile(void *, void *, uint32_t, void *, void *)",
  GetOverlappedResult: "int __stdcall GetOverlappedResult(void *, void *, _Out_ uint32_t *, int)",
  CancelIoEx: "int __stdcall CancelIoEx(void *, void *)",
  CreateEventW: "void * __stdcall CreateEventW(void *, int, int, str16)",
  CloseHandle: "int __stdcall CloseHandle(void *)",
  GetLastError: "uint32_t __stdcall GetLastError()",
  LocalFree: "void * __stdcall LocalFree(void *)",
  GetCurrentProcess: "void * __stdcall GetCurrentProcess()",
  CreateDirectoryW: "int __stdcall CreateDirectoryW(str16, void *)",
  CreateFileW: "void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)",
  GetFileInformationByHandleEx: "int __stdcall GetFileInformationByHandleEx(void *, int, void *, uint32_t)",
  GetDriveTypeW: "uint32_t __stdcall GetDriveTypeW(str16)",
  OpenProcessToken: "int __stdcall OpenProcessToken(void *, uint32_t, _Out_ void **)",
  GetTokenInformation: "int __stdcall GetTokenInformation(void *, int, void *, uint32_t, _Out_ uint32_t *)",
  ConvertSidToStringSidW: "int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)",
  ConvertStringSecurityDescriptorToSecurityDescriptorW: "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32_t, _Out_ void **, void *)",
  GetSecurityInfo: "uint32_t __stdcall GetSecurityInfo(void *, int, uint32_t, _Out_ void **, void *, _Out_ void **, void *, _Out_ void **)",
  GetSecurityDescriptorControl: "int __stdcall GetSecurityDescriptorControl(void *, _Out_ uint16_t *, _Out_ uint32_t *)",
  IsValidAcl: "int __stdcall IsValidAcl(void *)",
  GetAce: "int __stdcall GetAce(void *, uint32_t, _Out_ void **)",
  IsValidSid: "int __stdcall IsValidSid(void *)",
  GetLengthSid: "uint32_t __stdcall GetLengthSid(void *)",
} as const;
type NativeFunctions = { [Name in keyof typeof WINDOWS_REMOTE_HOST_DECLARATIONS]: Koffi.KoffiFunction };
type KoffiApi = Pick<typeof Koffi, "load" | "decode" | "encode" | "alloc" | "free" | "address">;
const ADVAPI_FUNCTIONS = new Set(["OpenProcessToken", "GetTokenInformation", "ConvertSidToStringSidW",
  "ConvertStringSecurityDescriptorToSecurityDescriptorW", "GetSecurityInfo", "GetSecurityDescriptorControl", "IsValidAcl", "GetAce", "IsValidSid", "GetLengthSid"]);
const FULL_CONTROL = 0x1f01ff;
const IO_PENDING = 997;
const IO_INCOMPLETE = 996;
const PIPE_CONNECTED = 535;
const BROKEN_PIPE = 109;
const NOT_FOUND = 1168;
const CHUNK_BYTES = 16 * 1024;

export function windowsSecurityFailure(): RemoteHostError {
  return new RemoteHostError("permission_denied", "The private Windows object security could not be verified.", "storage");
}
function pipeFailure(): RemoteHostError {
  return new RemoteHostError("connection_failed", "The private Windows pipe is unavailable.", "connection");
}

export class WindowsRemoteHostNative {
  readonly userSid: string;
  readonly logonSid: string;
  private readonly api: NativeFunctions;
  constructor(private readonly koffi: KoffiApi) {
    if (process.platform !== "win32" || process.arch !== "x64") throw new RemoteHostError("remote_runtime_not_supported", "The private Windows backend requires Windows x64.");
    const kernel = koffi.load("kernel32.dll");
    const security = koffi.load("advapi32.dll");
    this.api = Object.fromEntries(Object.entries(WINDOWS_REMOTE_HOST_DECLARATIONS).map(([name, declaration]) =>
      [name, (ADVAPI_FUNCTIONS.has(name) ? security : kernel).func(declaration)])) as NativeFunctions;
    const token: (WindowsHandle | null)[] = [null];
    if (!this.api.OpenProcessToken(this.api.GetCurrentProcess(), 8, token) || !token[0]) throw windowsSecurityFailure();
    try {
      this.userSid = this.withTokenInformation(token[0], 1, (user) => this.sid(this.koffi.decode(user, "void *")));
      const logons = this.withTokenInformation(token[0], 2, (groups, length) => {
        const count = this.koffi.decode(groups, "uint32_t") as number;
        if (count > 4096 || 8 + count * 16 > length) throw windowsSecurityFailure();
        const values: string[] = [];
        for (let i = 0; i < count; i++) {
          const offset = 8 + i * 16;
          const attributes = this.koffi.decode(groups, offset + 8, "uint32_t") as number;
          if (((attributes & 0xc0000000) >>> 0) === 0xc0000000) values.push(this.sid(this.koffi.decode(groups, offset, "void *")));
        }
        return values;
      });
      if (logons.length !== 1 || !/^S-1-5-5-\d+-\d+$/.test(logons[0]!)) throw windowsSecurityFailure();
      this.logonSid = logons[0]!;
    } finally { this.close(token[0]); }
  }

  private withTokenInformation<T>(token: WindowsHandle, kind: number, use: (data: unknown, length: number) => T): T {
    const length = [0];
    this.api.GetTokenInformation(token, kind, null, 0, length);
    if (!length[0] || length[0] > 64 * 1024) throw windowsSecurityFailure();
    const allocated = length[0];
    const bytes = this.koffi.alloc("uint8_t", allocated);
    try {
      if (!this.api.GetTokenInformation(token, kind, bytes, allocated, length) || length[0]! > allocated) throw windowsSecurityFailure();
      return use(bytes, length[0]!);
    } finally { this.koffi.free(bytes); }
  }
  private sid(pointer: unknown): string {
    if (!pointer || !this.api.IsValidSid(pointer)) throw windowsSecurityFailure();
    const result: unknown[] = [null];
    if (!this.api.ConvertSidToStringSidW(pointer, result) || !result[0]) throw windowsSecurityFailure();
    try {
      const value: unknown = this.koffi.decode(result[0], "char16_t", -1);
      if (typeof value !== "string" || !/^S-1-(?:\d+-)*\d+$/.test(value) || value.length > 184) throw windowsSecurityFailure();
      return value;
    } finally { this.api.LocalFree(result[0]); }
  }
  private withSecurity<T>(sddl: string, use: (attributes: Buffer) => T): T {
    const result: unknown[] = [null];
    if (!this.api.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, result, null) || !result[0]) throw windowsSecurityFailure();
    try {
      const attributes = Buffer.alloc(24);
      attributes.writeUInt32LE(24);
      this.koffi.encode(attributes, 8, "void *", result[0]);
      return use(attributes);
    } finally { this.api.LocalFree(result[0]); }
  }
  private valid(handle: unknown): handle is WindowsHandle {
    return handle != null && this.koffi.address(handle) !== 0xffffffffffffffffn;
  }
  close(handle: WindowsHandle): void { if (!this.api.CloseHandle(handle)) throw pipeFailure(); }

  security(handle: WindowsHandle): WindowsSecurityDescriptor {
    const owner: unknown[] = [null], dacl: unknown[] = [null], descriptor: unknown[] = [null];
    if (this.api.GetSecurityInfo(handle, 1, 5, owner, null, dacl, null, descriptor) !== 0) throw windowsSecurityFailure();
    try {
      if (!owner[0] || !dacl[0] || !descriptor[0] || !this.api.IsValidAcl(dacl[0])) throw windowsSecurityFailure();
      const flags = [0], revision = [0];
      if (!this.api.GetSecurityDescriptorControl(descriptor[0], flags, revision)) throw windowsSecurityFailure();
      const count: number = this.koffi.decode(dacl[0], 4, "uint16_t");
      if (count < 1 || count > 256) throw windowsSecurityFailure();
      const entries: WindowsAclEntry[] = [];
      for (let i = 0; i < count; i++) {
        const out: unknown[] = [null];
        if (!this.api.GetAce(dacl[0], i, out) || !out[0]) throw windowsSecurityFailure();
        const header = Buffer.from(this.koffi.decode(out[0], "uint8_t", 8) as number[]);
        const size = header.readUInt16LE(2);
        if (size < 16 || size > 76 || header[0] !== 0) throw windowsSecurityFailure();
        const sid = Buffer.from(this.koffi.decode(out[0], 8, "uint8_t", size - 8) as number[]);
        if (!this.api.IsValidSid(sid) || this.api.GetLengthSid(sid) !== sid.length) throw windowsSecurityFailure();
        entries.push({ type: header[0], flags: header[1]!, mask: header.readUInt32LE(4), sid: this.sid(sid) });
      }
      return { owner: this.sid(owner[0]), protected: Boolean(flags[0]! & 0x1000), entries };
    } finally { if (descriptor[0]) this.api.LocalFree(descriptor[0]); }
  }

  createPipe(path: string, first: boolean): WindowsHandle {
    const handle = this.withSecurity(`O:${this.userSid}D:P(A;;GA;;;${this.logonSid})`, (attributes) =>
      this.api.CreateNamedPipeW(path, 3 | 0x40000000 | (first ? 0x80000 : 0), 8, 65, CHUNK_BYTES, CHUNK_BYTES, 0, attributes) as unknown);
    if (!this.valid(handle)) throw pipeFailure();
    try {
      assertWindowsPipeSecurity(this.security(handle), this.userSid, this.logonSid);
      return handle;
    } catch (error) { this.close(handle); throw error; }
  }

  beginIo(handle: WindowsHandle, kind: "connect" | "read" | "write", input?: Buffer): WindowsNativeIo {
    const size = kind === "connect" ? 0 : kind === "read" ? CHUNK_BYTES : input?.length ?? 0;
    if (size > CHUNK_BYTES || (kind === "write" && size < 1)) throw pipeFailure();
    const event = this.api.CreateEventW(null, 1, 0, null) as WindowsHandle | null;
    if (!event) throw pipeFailure();
    let overlapped: unknown, data: unknown;
    try {
      overlapped = this.koffi.alloc("uint64_t", 4);
      this.koffi.encode(overlapped, "uint64_t", [0n, 0n, 0n, 0n], 4);
      this.koffi.encode(overlapped, 24, "void *", event);
      data = this.koffi.alloc("uint8_t", Math.max(1, size));
      if (input) this.koffi.encode(data, "uint8_t", input, size);
    } catch (error) {
      if (overlapped) this.koffi.free(overlapped);
      if (data) this.koffi.free(data);
      this.close(event); throw error;
    }
    let initial: WindowsIoState = { done: false };
    const accepted = kind === "connect" ? this.api.ConnectNamedPipe(handle, overlapped) :
      kind === "read" ? this.api.ReadFile(handle, data, size, null, overlapped) : this.api.WriteFile(handle, data, size, null, overlapped);
    if (!accepted) {
      const code = this.api.GetLastError() as number;
      if (kind === "connect" && code === PIPE_CONNECTED) initial = { done: true, bytes: 0 };
      else if (kind === "read" && code === BROKEN_PIPE) initial = { done: true, bytes: 0 };
      else if (code !== IO_PENDING) initial = { done: true, bytes: 0, error: pipeFailure() };
    }
    let disposed = false;
    let output: Buffer | undefined;
    return {
      poll: () => {
        if (initial.done) return initial;
        const bytes = [0];
        if (this.api.GetOverlappedResult(handle, overlapped, bytes, 0)) {
          initial = bytes[0]! <= size ? { done: true, bytes: bytes[0]! } : { done: true, bytes: 0, error: pipeFailure() };
        } else {
          const code = this.api.GetLastError() as number;
          if (code === IO_INCOMPLETE) return { done: false };
          initial = kind === "read" && code === BROKEN_PIPE ? { done: true, bytes: 0 } : { done: true, bytes: 0, error: pipeFailure() };
        }
        return initial;
      },
      cancel: () => {
        if (initial.done) return;
        if (!this.api.CancelIoEx(handle, overlapped)) {
          const code = this.api.GetLastError() as number;
          if (code !== NOT_FOUND) { /* Completion must still be observed before freeing memory. */ }
        }
      },
      contents: (bytes) => {
        if (!initial.done || bytes < 0 || bytes > size) throw pipeFailure();
        if (disposed) { if (output && output.length === bytes) return output; throw pipeFailure(); }
        return Buffer.from(this.koffi.decode(data, "uint8_t", bytes) as number[]);
      },
      dispose: () => {
        if (disposed) return;
        if (!initial.done) throw new Error("Cannot release pending Windows I/O");
        try {
          if (kind === "read" && !initial.error) output = initial.bytes === 0 ? Buffer.alloc(0) : Buffer.from(this.koffi.decode(data, "uint8_t", initial.bytes) as number[]);
        } finally {
          disposed = true; this.koffi.free(data); this.koffi.free(overlapped); this.close(event);
        }
      },
    };
  }

  createDirectory(path: string): void {
    this.withSecurity(`O:${this.userSid}D:P(A;OICI;FA;;;${this.userSid})(A;OICI;FA;;;SY)`, (attributes) => {
      if (!this.api.CreateDirectoryW(`\\\\?\\${path}`, attributes) && this.api.GetLastError() !== 183) throw windowsSecurityFailure();
    });
  }
  openPath(path: string): { handle: WindowsHandle; directory: boolean } {
    // Data/list access makes the retained handle participate in delete/rename sharing checks.
    const handle = this.api.CreateFileW(`\\\\?\\${path}`, 0x20000 | 0x80 | 0x1, 3, null, 3, 0x02000000 | 0x00200000, null) as unknown;
    if (!this.valid(handle)) {
      const code = this.api.GetLastError() as number;
      if (code === 2 || code === 3) throw new WindowsPrivatePathMissing();
      throw windowsSecurityFailure();
    }
    try {
      const attributes = Buffer.alloc(8);
      if (!this.api.GetFileInformationByHandleEx(handle, 9, attributes, 8) || attributes.readUInt32LE(0) & 0x400) throw windowsSecurityFailure();
      return { handle, directory: Boolean(attributes.readUInt32LE(0) & 0x10) };
    } catch (error) { this.close(handle); throw error; }
  }
  isFixedDrive(root: string): boolean { return this.api.GetDriveTypeW(root) === 3; }
}

export function assertWindowsPipeSecurity(actual: WindowsSecurityDescriptor, userSid: string, logonSid: string): void {
  const entry = actual.entries[0];
  if (actual.owner !== userSid || !actual.protected || actual.entries.length !== 1 || !entry ||
    entry.type !== 0 || entry.flags !== 0 || entry.sid !== logonSid || entry.mask !== FULL_CONTROL) throw windowsSecurityFailure();
}

let native: Promise<WindowsRemoteHostNative> | undefined;
export function windowsRemoteHostNative(): Promise<WindowsRemoteHostNative> {
  return native ??= import("koffi").then((module) => new WindowsRemoteHostNative(module.default));
}
