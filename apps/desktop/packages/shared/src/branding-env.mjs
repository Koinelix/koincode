export const LEGACY_ENV_PREFIX = "ZCODE_";

/** Preserve primary keys, including empty values, while normalizing explicit legacy aliases. */
export function normalizeLegacyFCodeEnv(env) {
  const normalized = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith(LEGACY_ENV_PREFIX)) continue;
    const primary = `FCODE_${key.slice(LEGACY_ENV_PREFIX.length)}`;
    const primaryKey = Object.keys(env).find(candidate => candidate.toUpperCase() === primary);
    if (!primaryKey) normalized[primary] = value;
    delete normalized[key];
  }
  return normalized;
}
