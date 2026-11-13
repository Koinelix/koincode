export declare const PRODUCT_DATA_DIRECTORY: ".koincode";
export declare const PRODUCT_DATA_ROOT_ENV: "FCODE_DATA_ROOT";
export interface ProductDataPathOptions {
  env?: Record<string, string | undefined>;
  homeDirectory?: string;
  baseDirectory?: string;
}
export declare function resolveProductDataRoot(options?: ProductDataPathOptions): string;
export declare function resolveDevelopmentDataRoot(homeDirectory?: string): string;
export declare function resolveRuntimeCacheRoot(homeDirectory?: string): string;
export declare function ensureProductDataRoot(root?: string): string;
