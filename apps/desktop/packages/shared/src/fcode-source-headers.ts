import { DEFAULT_FCODE_ENDPOINT_ORIGIN } from "./fcodeEndpoint.js";

// Bug fix (2026-11-13): model requests still announced the upstream product (X-Title "Z Code@...",
// User-Agent "FCode/...", Referer of the upstream endpoint) to every provider, including Koinelix.
// Outbound requests identify this product; only calls to a first-party endpoint keep that endpoint's own origin as Referer.
export const KOINCODE_SOURCE_NAME = "KoinCode";
export const KOINCODE_SOURCE_REFERER = "https://koinelix.com";

export const FCODE_SOURCE_HEADERS = {
  "User-Agent": `${KOINCODE_SOURCE_NAME}/unknown`,
  "HTTP-Referer": DEFAULT_FCODE_ENDPOINT_ORIGIN,
  "X-Title": `${KOINCODE_SOURCE_NAME}@electron`,
} as const;

export interface BuildFCodeSourceHeadersFromContextOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  deviceMid?: string;
  endpointOrigin?: string;
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
}

export function normalizeFCodeSourceHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildFCodeSourceHeadersFromContext(
  options: BuildFCodeSourceHeadersFromContextOptions = {},
): Record<string, string> {
  const appVersion = normalizeFCodeSourceHeaderValue(options.appVersion);
  const arch = normalizeFCodeSourceHeaderValue(options.arch);
  const clientLanguage = normalizeFCodeSourceHeaderValue(options.clientLanguage) ?? "unknown";
  const clientTimezone = normalizeFCodeSourceHeaderValue(options.clientTimezone) ?? "unknown";
  const deviceMid = normalizeFCodeSourceHeaderValue(options.deviceMid);
  const endpointOrigin =
    normalizeFCodeSourceHeaderValue(options.endpointOrigin) ?? DEFAULT_FCODE_ENDPOINT_ORIGIN;
  const osVersion = normalizeFCodeSourceHeaderValue(options.osVersion);
  const platform = normalizeFCodeSourceHeaderValue(options.platform);
  const releaseChannel = normalizeFCodeSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeFCodeSourceHeaderValue(options.sourceTitle) ?? "electron";

  return {
    ...FCODE_SOURCE_HEADERS,
    "HTTP-Referer": endpointOrigin,
    "User-Agent": `${KOINCODE_SOURCE_NAME}/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-FCode-App-Version": appVersion } : {}),
    "X-Title": `${KOINCODE_SOURCE_NAME}@${sourceTitle}`,
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": clientLanguage,
    "X-Client-Timezone": clientTimezone,
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platform) } : {}),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
