import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { resolveProductDataRoot } from "./product-data-paths.mjs";
import { PRODUCT_DIRECTORY } from "./branding-compatibility.js";

/** Product data never falls back to another application's directory. */
export function resolveFCodeDirectory(
  baseDirectory: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const primary = resolve(baseDirectory) === resolve(homedir())
    ? resolveProductDataRoot({ baseDirectory })
    : join(baseDirectory, PRODUCT_DIRECTORY);
  void exists;
  return primary;
}

export function resolveFCodePath(baseDirectory: string, ...segments: string[]): string {
  return join(resolveFCodeDirectory(baseDirectory), ...segments);
}

export function resolveFCodePluginManifest(root: string): string {
  const primary = join(root, ".fcode-plugin", "plugin.json");
  const legacy = join(root, ".zcode-plugin", "plugin.json");
  return !existsSync(primary) && existsSync(legacy) ? legacy : primary;
}
