import { isMainThread } from "node:worker_threads";
import type { webcrypto } from "node:crypto";
import { aeskw } from "@noble/ciphers/aes";
import { requireWallet } from "../domain/errors.js";

type AlgorithmIdentifier = webcrypto.AlgorithmIdentifier;
type KeyFormat = webcrypto.KeyFormat;
type KeyUsage = webcrypto.KeyUsage;
type JsonWebKey = webcrypto.JsonWebKey;
type BufferSource = ArrayBuffer | NodeJS.ArrayBufferView<ArrayBuffer>;

function valid(condition: unknown): asserts condition {
  requireWallet(condition, "BACKUP_INVALID", "The backup cryptographic operation is invalid.");
}

const name = (algorithm: AlgorithmIdentifier) =>
  typeof algorithm === "string" ? algorithm : algorithm.name;

// This implements only the AES-KW calls made by the pinned jose backup path.
// It is deliberately not a general-purpose WebCrypto implementation.
export function createBackupKeyWrapProvider(native: Crypto): { crypto: Crypto; dispose(): void } {
  const keys = new Map<CryptoKey, { bytes: Uint8Array; usage: KeyUsage }>();
  let disposed = false;
  const readKey = (key: CryptoKey, usage: KeyUsage) => {
    const entry = keys.get(key);
    valid(!disposed && entry && entry.usage === usage);
    return entry.bytes;
  };
  const importKey = async (
    format: KeyFormat,
    data: BufferSource | JsonWebKey,
    algorithm: AlgorithmIdentifier,
    extractable: boolean,
    usages: KeyUsage[],
  ) => {
    valid(!disposed);
    if (name(algorithm) !== "AES-KW")
      return native.subtle.importKey(
        format as "raw",
        data as BufferSource,
        algorithm,
        extractable,
        usages,
      );
    valid(
      format === "raw" &&
        extractable === true &&
        usages.length === 1 &&
        (usages[0] === "wrapKey" || usages[0] === "unwrapKey"),
    );
    valid(data instanceof ArrayBuffer || ArrayBuffer.isView(data));
    const input =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    valid(input.byteLength === 32 && keys.size < 2);
    const algorithmDetails = Object.freeze({ name: "AES-KW", length: 256 });
    const key: CryptoKey = {
      type: "secret",
      extractable: true,
      algorithm: algorithmDetails,
      usages: [...usages],
    };
    Object.freeze(key.usages);
    Object.freeze(key);
    keys.set(key, { bytes: Uint8Array.from(input), usage: usages[0]! });
    return key;
  };
  const wrapKey = async (
    format: KeyFormat,
    key: CryptoKey,
    wrappingKey: CryptoKey,
    algorithm: AlgorithmIdentifier,
  ) => {
    valid(!disposed);
    if (name(algorithm) !== "AES-KW")
      return native.subtle.wrapKey(format, key, wrappingKey, algorithm);
    valid(format === "raw");
    const kek = readKey(wrappingKey, "wrapKey");
    const cek = new Uint8Array(await native.subtle.exportKey("raw", key));
    try {
      valid(!disposed && cek.byteLength === 32);
      return Uint8Array.from(aeskw(kek).encrypt(cek)).buffer;
    } finally {
      cek.fill(0);
    }
  };
  const unwrapKey = async (
    format: KeyFormat,
    wrapped: BufferSource,
    unwrappingKey: CryptoKey,
    algorithm: AlgorithmIdentifier,
    target: AlgorithmIdentifier,
    extractable: boolean,
    usages: KeyUsage[],
  ) => {
    valid(!disposed);
    if (name(algorithm) !== "AES-KW")
      return native.subtle.unwrapKey(
        format,
        wrapped,
        unwrappingKey,
        algorithm,
        target,
        extractable,
        usages,
      );
    valid(
      format === "raw" &&
        name(target) === "HMAC" &&
        extractable === true &&
        usages.length === 1 &&
        usages[0] === "sign",
    );
    const kek = readKey(unwrappingKey, "unwrapKey");
    const input =
      wrapped instanceof ArrayBuffer
        ? new Uint8Array(wrapped)
        : new Uint8Array(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);
    valid(input.byteLength === 40);
    const cek = aeskw(kek).decrypt(input);
    try {
      valid(cek.byteLength === 32);
      return await native.subtle.importKey(
        "raw",
        cek as Uint8Array<ArrayBuffer>,
        target,
        extractable,
        usages,
      );
    } finally {
      cek.fill(0);
    }
  };
  const overrides = { importKey, wrapKey, unwrapKey };
  const subtle = new Proxy(native.subtle, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property as keyof typeof overrides];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const crypto = new Proxy(native, {
    get(target, property) {
      if (property === "subtle") return subtle;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    crypto,
    dispose() {
      disposed = true;
      for (const key of keys.values()) key.bytes.fill(0);
      keys.clear();
    },
  };
}

let installed = false;
export async function withBackupCrypto<T>(work: () => Promise<T>): Promise<T> {
  if (!process.versions.electron) return work();
  valid(!isMainThread && !installed);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  valid(descriptor?.configurable);
  const provider = createBackupKeyWrapProvider(globalThis.crypto);
  installed = true;
  try {
    Object.defineProperty(globalThis, "crypto", { value: provider.crypto, configurable: true });
    return await work();
  } finally {
    provider.dispose();
    Object.defineProperty(globalThis, "crypto", descriptor);
    installed = false;
  }
}
