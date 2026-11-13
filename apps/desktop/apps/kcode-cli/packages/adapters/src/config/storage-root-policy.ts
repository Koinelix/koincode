import { join } from "node:path";
import type { RuntimeConfigPatch } from "@fcode/contracts";
import { normalizeLegacyFCodeEnv } from "@fcode/shared/branding-compatibility";
import { resolveProductDataRoot } from "@fcode/shared/product-data-paths";

/** A trusted launch profile wins over persisted and project storage preferences. */
export function trustedStorageRoot(env: Record<string, string | undefined>): string | undefined {
  const normalized = normalizeLegacyFCodeEnv(env);
  return normalized.FCODE_DATA_ROOT?.trim() ? resolveProductDataRoot({ env: normalized }) : undefined;
}

export function applyTrustedStorageRoot(
  config: RuntimeConfigPatch, env: Record<string, string | undefined>,
): RuntimeConfigPatch {
  const root = trustedStorageRoot(env);
  return root ? { ...config, storage: { dir: root, sessionDbPath: join(root, "cli", "db", "db.sqlite") } } : config;
}
