import { loadEndpointEnv } from "./load-endpoint-env.mjs";
import { loadNetworkProfiles, resolveKoincodeNetwork } from "./koincode-network.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function resolveBuiltinProviderBuildEnvironment({
  root = repositoryRoot,
  env = process.env,
} = {}) {
  let value = env.FCODE_ENV;
  if (!value?.trim()) {
    const files = [
      ".env",
      ...(env.NODE_ENV === "production"
        ? [".env.production"]
        : [".env.development", ".env.development.local"]),
    ];
    for (const file of files) {
      let content;
      try {
        content = await readFile(resolve(root, file), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const parsed = parseEnv(content);
      if (parsed.FCODE_ENV !== undefined) value = parsed.FCODE_ENV;
    }
  }
  const normalized = value?.trim().toLowerCase() || "test";
  if (normalized !== "test" && normalized !== "production") {
    throw new Error(`Invalid FCODE_ENV for Built-in Provider build: ${normalized}`);
  }
  return normalized;
}

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function loadBuiltinProviderConfig({ root = repositoryRoot, env = process.env } = {}) {
  // Build mode comes from the caller only; .env files must not switch the payment network.
  const network = resolveKoincodeNetwork({ root, env: { NODE_ENV: env.NODE_ENV } });
  env = await loadEndpointEnv({ root, env });
  const environment = await resolveBuiltinProviderBuildEnvironment({ root, env });
  const sourcePath = resolve(
    root,
    env.FCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() || "config/provider/fcode-builtin.json",
  );
  try {
    let content = await readFile(sourcePath, "utf8");
    const preset = JSON.parse(content);
    // The Koinelix endpoint is paired with the payment network in config/network.json.
    // Packaging copies the source preset unchanged, so it must already carry the mainnet endpoint.
    const mainnetUrl = loadNetworkProfiles(root).mainnet.llmBaseUrl;
    const rules = preset.config.providerConfigRules;
    let replaced = 0;
    for (const rule of [...rules.templateRules, ...rules.providerRules]) {
      if (rule.templateId === "koinelix" || rule.providerId === "koinelix") {
        if (rule.config.api.baseUrl !== mainnetUrl) throw new Error("The Koinelix preset endpoint differs from the mainnet profile.");
        rule.config.api.baseUrl = network.llmBaseUrl;
        replaced++;
      }
    }
    if (replaced === 0) throw new Error("The built-in preset has no Koinelix entry.");
    content = JSON.stringify(preset, null, 2) + "\n";
    // 构建期复用运行时的完整 Release 校验，避免打包成功后才发现 Schema 不兼容。
    // tsx 仅供构建工具加载仓库 TS，不进入产品 bundle，也不复制一份校验规则。
    // Windows 绝对路径的盘符会被 ESM 当作协议，转为 file URL 后各平台共用同一加载入口。
    const { decodeFCodeBuiltinRelease } = await tsImport(
      pathToFileURL(resolve(repositoryRoot, "packages/provider-node/src/fcode-builtin-release.ts"))
        .href,
      import.meta.url,
    );
    decodeFCodeBuiltinRelease(JSON.parse(content));
    return { environment, sourcePath, content };
  } catch (error) {
    throw new Error(`Invalid Built-in Provider config (${environment}): ${sourcePath}`, {
      cause: error,
    });
  }
}

/** @param {{directory: string, root?: string, env?: Record<string, string | undefined>}} options */
export async function stageBuiltinProviderConfig({ directory, ...options }) {
  const config = await loadBuiltinProviderConfig(options);
  await mkdir(directory, { recursive: true });
  // bootstrap 可以复用 JS，但不能连带复用上一环境／上一版本的独立配置资源。
  await writeFile(resolve(directory, "fcode-builtin.json"), config.content, "utf8");
  return config;
}
