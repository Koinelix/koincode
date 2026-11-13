const INTERNAL_PATH_SEGMENTS = new Set(["harness", "specs", "payment-testkit"]);

export function findWalletInternalPackagePaths(asarList) {
  return asarList
    .split(/\r?\n/)
    .map((entry) => entry.trim().replaceAll("\\", "/"))
    .filter((entry) => entry.split("/").some((segment) => INTERNAL_PATH_SEGMENTS.has(segment)));
}
