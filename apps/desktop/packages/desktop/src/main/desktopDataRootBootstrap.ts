import { ensureProductDataRoot } from "@fcode/shared/product-data-paths";

/** This dependency must finish before importing any product filesystem writer. */
function prepareDesktopDataRoot(): string {
  try {
    return ensureProductDataRoot();
  } catch (error) {
    // Logging to the product directory is unsafe until validation succeeds.
    console.error("[startup] KoinCode data root validation failed.", error);
    process.exit(1);
  }
}

export const desktopDataRoot = prepareDesktopDataRoot();
