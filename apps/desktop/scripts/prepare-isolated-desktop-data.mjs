import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveProductDataRoot, ensureProductDataRoot } from "../packages/shared/src/product-data-paths.mjs";

// Preparation creates only this product's private root. It never imports another product.
export async function prepareIsolatedDesktopData({ dataRoot, baseDir, userHome }) {
  const root = resolveProductDataRoot({
    env: dataRoot ? { FCODE_DATA_ROOT: dataRoot } : {},
    ...(baseDir ? { baseDirectory: baseDir } : {}),
    ...(userHome ? { homeDirectory: userHome } : {}),
  });
  ensureProductDataRoot(root);
  return root;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await prepareIsolatedDesktopData({ dataRoot: resolveProductDataRoot(), userHome: undefined });
  } catch {
    console.error("[ERROR] KoinCode data preparation failed.");
    process.exitCode = 1;
  }
}
