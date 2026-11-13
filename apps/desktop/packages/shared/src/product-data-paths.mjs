import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";

import { normalizeLegacyFCodeEnv } from "./branding-env.mjs";
import { PRODUCT_DATA_DIRECTORY } from "./product-directory.mjs";
export { PRODUCT_DATA_DIRECTORY };
export const PRODUCT_DATA_ROOT_ENV = "FCODE_DATA_ROOT";
const LEGACY_DIRECTORIES = new Set([".fcode", ".zcode", ".felixcode-local-data", ".fcode-local-data"]);

/**
 * Resolve one trusted runtime data root without changing the operating-system home.
 * Project-relative discovery must use PRODUCT_DATA_DIRECTORY instead of this global root.
 * @param {{ env?: Record<string, string | undefined>, homeDirectory?: string, baseDirectory?: string }} [options]
 */
export function resolveProductDataRoot(options = {}) {
  const env = normalizeLegacyFCodeEnv(options.env ?? process.env);
  const home = options.homeDirectory ?? homedir();
  const explicit = env[PRODUCT_DATA_ROOT_ENV]?.trim() || undefined;
  const base = options.baseDirectory ?? env.FCODE_DATA_BASE_DIR?.trim() ?? home;
  const requested = explicit ?? resolve(base || home, PRODUCT_DATA_DIRECTORY);
  if (!isAbsolute(requested) || requested.includes("\0")) {
    throw new Error("KoinCode requires an absolute data root outside legacy product directories.");
  }
  const root = resolve(requested);
  if (root.split(sep).some(part => LEGACY_DIRECTORIES.has(part))) {
    throw new Error("KoinCode requires an absolute data root outside legacy product directories.");
  }
  return resolve(root);
}

/** @param {string} [homeDirectory] */
export function resolveDevelopmentDataRoot(homeDirectory = homedir()) {
  return join(homeDirectory, PRODUCT_DATA_DIRECTORY, "dev");
}

/** @param {string} [homeDirectory] */
export function resolveRuntimeCacheRoot(homeDirectory = homedir()) {
  return join(homeDirectory, PRODUCT_DATA_DIRECTORY, "cache", "runtime");
}

/** Validate original and canonical ancestor chains before creating product directories. */
function validateDirectoryChain(path, create = false, productRoot = path) {
  const filesystemRoot = parse(path).root;
  let current = filesystemRoot;
  for (const part of path.slice(filesystemRoot.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
      info = lstatSync(current);
    }
    if (typeof process.getuid === "function" && info.isSymbolicLink() &&
        current !== productRoot && info.uid === 0) {
      // An OS alias does not make its canonical target ancestors trusted automatically.
      validateDirectoryChain(realpathSync(current), false, productRoot);
      continue;
    }
    const trustedOwner = typeof process.getuid !== "function" || info.uid === 0 || info.uid === process.getuid();
    const trustedMode = typeof process.getuid !== "function" || (info.mode & 0o022) === 0 ||
      ((info.mode & 0o1000) !== 0 && info.uid === 0);
    if (!info.isDirectory() || info.isSymbolicLink() || !trustedOwner || !trustedMode) {
      throw new Error("The KoinCode data directory has an untrusted parent or permissions.");
    }
  }
}

function existingRealpath(path) {
  try { return realpathSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; return resolve(path); }
}

/** Bind permission changes to a verified directory descriptor; never chmod a HOME alias. */
export function ensureProductDataRoot(root = resolveProductDataRoot()) {
  root = resolveProductDataRoot({ env: { FCODE_DATA_ROOT: root } });
  if (root === resolve(homedir()) || root === parse(root).root) {
    throw new Error("A dedicated KoinCode data directory is required.");
  }
  validateDirectoryChain(root, true);
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("The KoinCode data directory must be owned and cannot be a symbolic link.");
  }
  const canonicalRoot = realpathSync(root), canonicalHome = existingRealpath(homedir());
  const comparable = value => process.platform === "win32" ? value.toLowerCase() : value;
  if (comparable(canonicalRoot) === comparable(canonicalHome) || canonicalRoot === parse(canonicalRoot).root) {
    throw new Error("A dedicated KoinCode data directory is required.");
  }
  validateDirectoryChain(canonicalRoot);
  // Windows keeps inherited ACLs; POSIX mode bits do not establish Windows privacy.
  if (typeof process.getuid !== "function") return canonicalRoot;
  const fd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bound = fstatSync(fd), filesystemRoot = statSync(parse(canonicalRoot).root);
    let home;
    try { home = statSync(homedir()); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const same = other => other && bound.dev === other.dev && bound.ino === other.ino;
    if (!bound.isDirectory() || bound.uid !== process.getuid() ||
        bound.dev !== info.dev || bound.ino !== info.ino || same(home) || same(filesystemRoot)) {
      throw new Error("The KoinCode data directory identity changed or aliases a protected directory.");
    }
    fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
  return canonicalRoot;
}
