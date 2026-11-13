import type { RemoteHostRecord, RemoteSecretMaterial } from "./contracts.js";

export interface RemoteFileStat {
  size: number;
  mode: number;
  mtime: number;
  type: "file" | "directory" | "symlink" | "special";
}

export interface RemoteDirectoryEntry extends RemoteFileStat { name: string }
export interface RemoteSftpPort {
  close?(): void;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<RemoteFileStat | null>;
  list(path: string, offset: number, limit: number, signal?: AbortSignal): Promise<{ entries: RemoteDirectoryEntry[]; nextOffset?: number }>;
  mkdir(path: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string, overwrite: boolean): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  availableBytes(path: string): Promise<number | null>;
  sha256?(path: string, expectedBytes: number, signal?: AbortSignal): Promise<string | null>;
  read(path: string, maxBytes: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  write(path: string, content: AsyncIterable<Uint8Array>, options: {
    signal?: AbortSignal; onProgress?: (bytes: number) => void;
  }): Promise<{ bytes: number; sha256: string }>;
}

export interface RemoteShellCommand { command: string; cwd?: string; env?: Record<string, string> }
export interface RemoteShellResult { exitCode: number | null; signal?: string }
export interface RemoteSshConnection {
  isAlive?(): boolean;
  onClose?(listener: () => void): () => void;
  files(): Promise<RemoteSftpPort>;
  exec(command: RemoteShellCommand, options: {
    signal?: AbortSignal; onOutput?: (stream: "stdout" | "stderr", bytes: Uint8Array) => void;
  }): Promise<RemoteShellResult>;
  close(): void;
}

export interface RemoteSshConnectInput {
  host: RemoteHostRecord;
  preferredHostKeyType?: string;
  signal?: AbortSignal;
  verifyHostKey(key: { publicKey: string; keyType: string; fingerprint: string }): void;
  getCredential(): Promise<RemoteSecretMaterial>;
}

export interface RemoteSshTransportPort {
  connect(input: RemoteSshConnectInput): Promise<RemoteSshConnection>;
}
