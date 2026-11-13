import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface SeedFile {
  path: string;
  sha256: string;
}

/** Compare every file and directory without following symbolic links. */
export function verifyRemoteHostSeedTree(root: string, files: readonly SeedFile[], marker: string): boolean {
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return false;
    const expectedFiles = new Map(files.map((file) => [file.path, file.sha256]));
    const expectedDirs = new Set<string>();
    for (const { path } of files) {
      let parent = dirname(path);
      while (parent !== ".") {
        expectedDirs.add(parent.replaceAll("\\", "/"));
        parent = dirname(parent);
      }
    }
    const seen = new Set<string>();
    const visit = (directory: string, prefix: string): boolean => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = join(directory, entry.name);
        if (entry.isSymbolicLink()) return false;
        if (entry.isDirectory()) {
          if (!expectedDirs.has(relativePath) || !visit(fullPath, relativePath)) return false;
        } else if (entry.isFile()) {
          if (relativePath === marker) continue;
          const expected = expectedFiles.get(relativePath);
          if (!expected || createHash("sha256").update(readFileSync(fullPath)).digest("hex") !== expected) return false;
          seen.add(relativePath);
        } else {
          return false;
        }
      }
      return true;
    };
    return visit(root, "") && seen.size === expectedFiles.size;
  } catch {
    return false;
  }
}
