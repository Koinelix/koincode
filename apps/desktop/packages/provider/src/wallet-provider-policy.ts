import type { ConfigValidationIssue } from "./config-overlay.js";
import {
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ProviderTemplateMap,
} from "./config/index.js";

/** Derive trust from built-in rules only, before any mutable overlay. */
export function resolveBuiltinProviderBaselines(
  providers: ProviderConfigMap,
  templates?: ProviderTemplateMap,
): ProviderConfigMap {
  return providers.mapConfigs((config, _id, rule) => {
    const template = rule.templateId ? templates?.get(rule.templateId)?.config : undefined;
    return template ? template.overlay(config) : config;
  });
}

export function composeEffectiveProviders(
  builtin: ProviderConfigMap,
  personal: ProviderConfigMap,
  templates?: ProviderTemplateMap,
  accounts = ProviderConfigMap.empty(),
) {
  const trusted = resolveBuiltinProviderBaselines(builtin, templates);
  const accountOverlay = new ProviderConfigMap(
    accounts
      .entries()
      .filter(([id]) => builtin.has(id))
      .map(([id, config]) => [id, config.withoutGroup()] as const),
  );
  const effectiveBuiltin = resolveBuiltinProviderBaselines(
    builtin.overlay(accountOverlay),
    templates,
  ).mapConfigs((config, id) => pinWalletConfig(config, trusted.get(id)));
  const personalWithTemplates = personal.mapConfigs((config, id, rule) => {
    if (builtin.has(id)) return config.withoutGroup();
    const template = rule.templateId ? templates?.get(rule.templateId)?.config : undefined;
    return template ? template.overlay(config) : config;
  });
  const effective = effectiveBuiltin
    .overlay(personalWithTemplates)
    .mapConfigs((config, id) => pinWalletConfig(config, trusted.get(id)));
  return { trusted, effectiveBuiltin, effective };
}

function pinWalletConfig(config: ProviderConfig, trusted?: ProviderConfig): ProviderConfig {
  if (trusted?.access?.type !== "x402-wallet") return config;
  return new ProviderConfig({
    ...config,
    access: trusted.access,
    api: new ProviderApiConfig({ ...config.api, baseUrl: trusted.api?.baseUrl }),
  });
}

export function walletProviderIssues(
  id: string,
  config: ProviderConfig,
  trusted?: ProviderConfig,
): ConfigValidationIssue[] {
  if (trusted?.access?.type === "x402-wallet") {
    const address = trusted.api?.baseUrl;
    if (!address || !URL.canParse(address)) {
      return [
        {
          code: "wallet-endpoint-missing",
          path: ["providers", id, "api", "baseUrl"],
          message: "The built-in wallet provider requires a valid endpoint.",
        },
      ];
    }
  } else if (config.access?.type === "x402-wallet") {
    return [
      {
        code: "wallet-access-not-builtin",
        path: ["providers", id, "access"],
        message: "Wallet access requires a concrete built-in wallet provider.",
      },
    ];
  }
  return [];
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = Object.entries(left);
  const b = Object.entries(right);
  return (
    a.length === b.length &&
    a.every(
      ([key, value]) =>
        Object.hasOwn(right, key) &&
        structurallyEqual(value, (right as Record<string, unknown>)[key]),
    )
  );
}

/** Whole-overlay saves may carry old values, but may not introduce or mutate them. */
export function preserveWalletPersonalFields(
  submitted: ProviderConfig,
  stored?: ProviderConfig,
): ProviderConfig {
  const oldAddress = stored?.api?.baseUrl;
  const nextAddress = submitted.api?.baseUrl;
  if (
    (nextAddress !== undefined && nextAddress !== oldAddress) ||
    (submitted.api === null && oldAddress !== undefined) ||
    (submitted.access !== undefined &&
      !structurallyEqual(
        submitted.access?.toJSON() ?? submitted.access,
        stored?.access?.toJSON() ?? stored?.access,
      ))
  ) {
    throw new Error(
      "Wallet provider endpoint and access overrides cannot be introduced or changed.",
    );
  }
  const api =
    oldAddress !== undefined
      ? new ProviderApiConfig({ ...submitted.api, baseUrl: oldAddress })
      : submitted.api;
  return new ProviderConfig({ ...submitted, api, access: stored?.access });
}

export function assertPersonalWalletMutationAllowed(input: {
  trusted?: ProviderConfig;
  current?: ProviderConfig;
  next: ProviderConfig;
  currentTemplateId?: string | null;
  nextTemplateId?: string | null;
  templates?: ProviderTemplateMap;
}): void {
  if (input.trusted?.access?.type === "x402-wallet") return;
  const template = input.nextTemplateId
    ? input.templates?.get(input.nextTemplateId)?.config
    : undefined;
  const introducesTemplate =
    template?.access?.type === "x402-wallet" &&
    (!input.current || input.currentTemplateId !== input.nextTemplateId);
  const currentAccess = input.current?.access;
  const nextAccess = input.next.access;
  const introducesAccess =
    nextAccess?.type === "x402-wallet" && currentAccess?.type !== "x402-wallet";
  const currentTemplate = input.currentTemplateId
    ? input.templates?.get(input.currentTemplateId)?.config
    : undefined;
  // A whole-overlay replacement can expose inherited wallet access by omitting a mask.
  const currentBaseline = input.trusted ?? currentTemplate;
  const nextBaseline = input.trusted ?? template;
  const currentEffectiveAccess = input.current
    ? (currentBaseline?.overlay(input.current) ?? input.current).access
    : currentBaseline?.access;
  const nextEffectiveAccess = (nextBaseline?.overlay(input.next) ?? input.next).access;
  const exposesInheritedWallet =
    nextEffectiveAccess?.type === "x402-wallet" && currentEffectiveAccess?.type !== "x402-wallet";
  const incompleteConversion =
    currentEffectiveAccess?.type === "x402-wallet" &&
    nextEffectiveAccess?.type !== "x402-wallet" &&
    template?.access?.type === "x402-wallet";
  if (introducesTemplate || introducesAccess || exposesInheritedWallet || incompleteConversion) {
    throw new Error("Personal providers cannot introduce wallet access or a wallet template.");
  }
}
