import type { ModelConfigObject } from "@fcode/provider";
import { z } from "zod";
import { resolveModelCatalogUrl, type ProviderModelCatalogApiType } from "./providerModelCatalog.js";

// Limits are read leniently: a malformed limit disables that model instead of rejecting the catalog.
const catalog = z.object({ data: z.array(z.object({ id: z.string().min(1).max(256),
  supported_protocols: z.array(z.object({ name: z.string(), endpoints: z.array(z.string()) })).max(16),
  context_window: z.unknown().optional(), max_output_tokens: z.unknown().optional(),
})).max(4096) });
const MAX_LIMIT = 10_000_000;
const protocols = { "openai-chat-completions": "openai", "openai-responses": "openai_responses", "anthropic-messages": "anthropic" } as const;

/** Published service limits; null when the platform omits them or they are not usable. */
function serviceLimits(context: unknown, output: unknown): { contextWindow: number; maxOutputTokens: number } | null {
  const valid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_LIMIT;
  return valid(context) && valid(output) && output <= context ? { contextWindow: context, maxOutputTokens: output } : null;
}

/** Anonymous discovery is read-only and cannot invoke the wallet or accept a payment challenge. */
export async function fetchKoinelixModels(baseUrl: string, apiType: ProviderModelCatalogApiType,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<{ modelIds: string[]; modelConfigs: Record<string, ModelConfigObject> }> {
  const response = await fetchImpl(resolveModelCatalogUrl(baseUrl, apiType), {
    redirect: "error", signal: AbortSignal.timeout(15000), headers: { accept: "application/json" },
  });
  if (!response.ok || !response.body) throw new Error(`MODEL_CATALOG_HTTP_${response.status}`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 512 * 1024) throw new Error("MODEL_CATALOG_TOO_LARGE");
      chunks.push(item.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const parsed = catalog.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const modelIds: string[] = [], modelConfigs: Record<string, ModelConfigObject> = {};
  for (const entry of parsed.data) {
    if (modelIds.includes(entry.id)) throw new Error("MODEL_CATALOG_DUPLICATE_ID");
    modelIds.push(entry.id);
    const limits = serviceLimits(entry.context_window, entry.max_output_tokens);
    const ready = limits !== null && entry.supported_protocols.some(protocol => protocol.name === protocols[apiType]);
    modelConfigs[entry.id] = ready ? { enabled: true,
      properties: { contextWindow: limits.contextWindow, inputFormat: { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: true },
        supportsJsonSchemaOutput: true }, optionSpecs: { maxOutputTokens: { max: limits.maxOutputTokens } } }
      : { enabled: false, properties: { contextWindow: null }, optionSpecs: { maxOutputTokens: { max: null } } };
  }
  if (!modelIds.length) throw new Error("MODEL_CATALOG_EMPTY");
  return { modelIds, modelConfigs };
}
