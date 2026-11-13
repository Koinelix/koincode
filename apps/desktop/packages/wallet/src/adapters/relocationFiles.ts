import { createHash } from "node:crypto";
import {
  closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireWallet } from "../domain/errors.js";
import { RESPONSE_LIMIT } from "../domain/requestValidation.js";
import { canonical, digest } from "./canonical.js";

export function privateRelocationDirectory(path: string, create = false): string {
  requireWallet(resolve(path) === path && !path.includes("\0"), "UNSAFE_STORAGE_PATH",
    "Canonical absolute relocation paths are required.");
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create && !existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const info = lstatSync(current);
    requireWallet(info.isDirectory() && !info.isSymbolicLink() &&
      (typeof process.getuid !== "function" || info.uid === 0 || info.uid === process.getuid()) &&
      ((info.mode & 0o022) === 0 || ((info.mode & 0o1000) !== 0 && info.uid === 0)), "UNSAFE_STORAGE_PATH",
      "Relocation directories cannot contain symbolic links.");
  }
  const info = lstatSync(path);
  requireWallet(info.isDirectory() && !info.isSymbolicLink() &&
    realpathSync(path) === path && (info.mode & 0o077) === 0 &&
    (typeof process.getuid !== "function" || info.uid === process.getuid()),
  "UNSAFE_STORAGE_PATH", "The relocation directory must be private and owned by this user.");
  return path;
}

export function ensureRelocationTarget(directory: string, migrationId: string): void {
  privateRelocationDirectory(directory, true);
  const marker = join(directory, "directory-relocation.json");
  const expected = JSON.stringify({ version: 1, migrationId });
  if (existsSync(marker)) {
    const info = lstatSync(marker);
    requireWallet(info.isFile() && !info.isSymbolicLink() && info.size < 1024 &&
      (info.mode & 0o077) === 0 && readFileSync(marker, "utf8") === expected,
    "WALLET_RELOCATION_REQUIRED", "The target belongs to another relocation.");
    return;
  }
  requireWallet(readdirSync(directory).length === 0, "WALLET_RELOCATION_REQUIRED",
    "Relocation cannot merge into an existing directory.");
  const fd = openSync(marker, "wx", 0o600);
  try { writeFileSync(fd, expected); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(directory);
}

export function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Compare every table and its schema, including transport tombstones, without a path anchor. */
export function relocationDatabaseDigest(database: DatabaseSync): string {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const hash = createHash("sha256").update(canonical(schema));
  for (const row of tables) {
    const name = String(row.name);
    if (name === "control_anchors") continue;
    requireWallet(/^[a-z_]+$/.test(name), "SCHEMA_INCOMPATIBLE", "Unknown relocation table.");
    hash.update(name + "\0");
    const query = database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`);
    for (const value of query.iterate()) hash.update(canonical(value) + "\0");
  }
  return hash.digest("hex");
}

function blobDigest(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const hash = createHash("sha256");
  try {
    const bytes = Buffer.alloc(65536);
    let n: number;
    while ((n = readSync(fd, bytes, 0, bytes.length, null)) > 0) hash.update(bytes.subarray(0, n));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

export function relocationBlobDigest(directory: string): string {
  if (!existsSync(directory)) return digest([]);
  privateRelocationDirectory(directory);
  const names = readdirSync(directory).sort();
  requireWallet(names.length <= 100000, "WALLET_RELOCATION_REQUIRED", "Too many relocation blobs.");
  return digest(names.map(name => {
    const file = join(directory, name), info = lstatSync(file);
    requireWallet(/^[0-9a-f-]{36}$/.test(name) && info.isFile() && !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 && info.size <= RESPONSE_LIMIT + 28,
    "UNSAFE_STORAGE_PATH", "The relocation blob is invalid.");
    return { name, size: info.size, digest: blobDigest(file) };
  }));
}

export function copyRelocationBlobs(source: string, target: string, expected: string): void {
  requireWallet(relocationBlobDigest(source) === expected, "WALLET_RELOCATION_REQUIRED",
    "Source blobs changed after relocation preparation.");
  if (!existsSync(source)) {
    requireWallet(!existsSync(target) || relocationBlobDigest(target) === expected,
      "WALLET_RELOCATION_REQUIRED", "Unexpected target blobs.");
    return;
  }
  privateRelocationDirectory(target, true);
  const names = readdirSync(source);
  requireWallet(readdirSync(target).every(name => names.includes(name) || (name.endsWith(".pending") && names.includes(name.slice(0, -8)))),
    "WALLET_RELOCATION_REQUIRED", "Relocation cannot merge unknown blobs.");
  for (const name of names) {
    const destination = join(target, name);
    if (existsSync(destination)) {
      const info = lstatSync(destination);
      requireWallet(info.isFile() && !info.isSymbolicLink() &&
        blobDigest(destination) === blobDigest(join(source, name)),
      "WALLET_RELOCATION_REQUIRED", "A target blob differs from its source.");
    } else {
      const pending = destination + ".pending";
      if (existsSync(pending)) {
        const info = lstatSync(pending);
        requireWallet(info.isFile() && !info.isSymbolicLink(), "UNSAFE_STORAGE_PATH",
          "Pending blob copies must be regular files.");
        unlinkSync(pending);
      }
      copyFileSync(join(source, name), pending, constants.COPYFILE_EXCL);
      const fd = openSync(pending, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(pending, destination);
    }
    const fd = openSync(destination, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  syncDirectory(dirname(target));
  syncDirectory(target);
  requireWallet(relocationBlobDigest(target) === expected, "WALLET_RELOCATION_REQUIRED",
    "The copied blobs differ from their authenticated source inventory.");
}
