import { app, clipboard, ipcMain, type BrowserWindow } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { isTrustedWalletSender, type DesktopWalletWindowOptions } from "./desktopWalletWindowPolicy.js";
import { generalTokens } from "@koincode/wallet/general";
import { DesktopGeneralWalletPreferences } from "./desktopGeneralWalletPreferences.js";
import { DesktopGeneralWalletAssets, type GeneralCustomAsset } from "./desktopGeneralWalletAssets.js";
import { performance } from "node:perf_hooks";
import { DesktopGeneralWalletRpc } from "./desktopGeneralWalletRpc.js";
import { attachDesktopWalletManagerWindow } from "./desktopWalletManagerWindow.js";

const CHANNEL = "koincode:trusted-general-wallet";
const WALLET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NETWORK = /^eip155:[1-9][0-9]{0,19}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
let sharedPreferences: DesktopGeneralWalletPreferences | undefined;
let sharedAssets: DesktopGeneralWalletAssets | undefined;

function projectTokenInspection(value: unknown, networkId: string, address: string, contractAddress: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GENERAL_TOKEN_INSPECTION_INVALID");
  const row = value as Record<string, unknown>;
  const safeText = (text: unknown, limit: number) => text === null || typeof text === "string" &&
    Array.from(text).length > 0 && Array.from(text).length <= limit && Array.from(text).every((character) => {
      const code = character.codePointAt(0)!;
      return code > 31 && !(code >= 127 && code <= 159) && code !== 0x200e && code !== 0x200f &&
        !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069);
    });
  if (Object.keys(row).sort().join() !== "address,balanceAtomic,blockHash,blockNumber,contractAddress,decimals,name,networkId,symbol" ||
      row.networkId !== networkId || row.address !== address.toLowerCase() || row.contractAddress !== contractAddress ||
      typeof row.balanceAtomic !== "string" || !DECIMAL.test(row.balanceAtomic) || BigInt(row.balanceAtomic) >= 1n << 256n ||
      typeof row.blockNumber !== "string" || !DECIMAL.test(row.blockNumber) ||
      typeof row.blockHash !== "string" || !/^0x[0-9a-f]{64}$/.test(row.blockHash) ||
      !safeText(row.name, 128) || !safeText(row.symbol, 32) ||
      !(row.decimals === null || Number.isInteger(row.decimals) && (row.decimals as number) >= 0 && (row.decimals as number) <= 255))
    throw new Error("GENERAL_TOKEN_INSPECTION_INVALID");
  return { networkId, address: row.address, contractAddress, balanceAtomic: row.balanceAtomic, blockNumber: row.blockNumber,
    blockHash: row.blockHash, name: row.name, symbol: row.symbol, decimals: row.decimals };
}

function projectBalance(value: unknown, networkId: string, address: string, choice: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GENERAL_BALANCE_INVALID");
  const row = value as Record<string, unknown>;
  if (row.rpcChoice !== (choice === "default" ? undefined : choice) || row.networkId !== networkId || typeof row.address !== "string" || row.address.toLowerCase() !== address.toLowerCase() ||
      typeof row.blockNumber !== "string" || !DECIMAL.test(row.blockNumber) ||
      typeof row.blockHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(row.blockHash) ||
      typeof row.chainTimestamp !== "string" || !DECIMAL.test(row.chainTimestamp) ||
      row.configVersion !== 1 || typeof row.fetchedAt !== "string" || !Number.isFinite(Date.parse(row.fetchedAt)) ||
      !Array.isArray(row.assets)) throw new Error("GENERAL_BALANCE_INVALID");
  const tokens = generalTokens(networkId);
  if (row.assets.length !== tokens.length + 1) throw new Error("GENERAL_BALANCE_INVALID");
  const assets = row.assets.map((raw, index) => {
    const asset = raw as Record<string, unknown> | undefined;
    if (!asset || !asset.asset || typeof asset.asset !== "object") throw new Error("GENERAL_BALANCE_INVALID");
    const identity = asset.asset as Record<string, unknown>;
    const token = tokens[index - 1];
    if (index === 0 ? identity.kind !== "native" : !token || identity.kind !== "erc20" ||
      identity.contractAddress !== token.address || identity.expectedDecimals !== token.decimals)
      throw new Error("GENERAL_BALANCE_INVALID");
    const previous = asset.previous as Record<string, unknown> | undefined;
    if ((asset.status !== "fresh" && asset.status !== "stale" && asset.status !== "error" && asset.status !== "metadata_conflict") ||
        (index === 0 && asset.status === "metadata_conflict") ||
        (asset.status !== "fresh" && asset.status !== "stale" ? asset.amountAtomic !== null : typeof asset.amountAtomic !== "string" ||
          !DECIMAL.test(asset.amountAtomic) || BigInt(asset.amountAtomic) >= 1n << 256n) ||
        (asset.status !== "stale" ? previous !== undefined : !previous || typeof previous !== "object" || Array.isArray(previous) ||
          typeof previous.blockNumber !== "string" || !DECIMAL.test(previous.blockNumber) ||
          typeof previous.blockHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(previous.blockHash) ||
          typeof previous.chainTimestamp !== "string" || !DECIMAL.test(previous.chainTimestamp) ||
          typeof previous.fetchedAt !== "string" || !Number.isFinite(Date.parse(previous.fetchedAt)))) throw new Error("GENERAL_BALANCE_INVALID");
    return { asset: index === 0 ? { kind: "native" } : { kind: "erc20", contractAddress: token!.address,
      symbol: token!.symbol, decimals: token!.decimals }, status: asset.status, amountAtomic: asset.amountAtomic,
      ...(previous ? { previous: { blockNumber: previous.blockNumber, blockHash: (previous.blockHash as string).toLowerCase(),
        chainTimestamp: previous.chainTimestamp, fetchedAt: previous.fetchedAt } } : {}) };
  });
  return { networkId, address: row.address.toLowerCase(), blockNumber: row.blockNumber, blockHash: row.blockHash.toLowerCase(),
    chainTimestamp: row.chainTimestamp, configVersion: 1, fetchedAt: row.fetchedAt,
    assets };
}

function projectCustomBalance(value: unknown, networkId: string, address: string, selected: GeneralCustomAsset[], choice: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GENERAL_BALANCE_INVALID");
  const row = value as Record<string, unknown>;
  if (row.rpcChoice !== (choice === "default" ? undefined : choice) || row.networkId !== networkId || typeof row.address !== "string" || row.address !== address ||
      typeof row.blockNumber !== "string" || !DECIMAL.test(row.blockNumber) ||
      typeof row.blockHash !== "string" || !/^0x[0-9a-f]{64}$/.test(row.blockHash) ||
      typeof row.chainTimestamp !== "string" || !DECIMAL.test(row.chainTimestamp) || row.configVersion !== 1 ||
      typeof row.fetchedAt !== "string" || !Number.isFinite(Date.parse(row.fetchedAt)) ||
      !Array.isArray(row.assets) || row.assets.length !== selected.length) throw new Error("GENERAL_BALANCE_INVALID");
  const items = row.assets.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("GENERAL_BALANCE_INVALID");
    const item = raw as Record<string, unknown>, expected = selected[index]!;
    if (!item.asset || typeof item.asset !== "object" || Array.isArray(item.asset)) throw new Error("GENERAL_BALANCE_INVALID");
    const identity = item.asset as Record<string, unknown>;
    const decimals = expected.decimalsSource === "chain" ? expected.decimals : undefined;
    if (identity.kind !== "erc20" || identity.contractAddress !== expected.contractAddress || identity.expectedDecimals !== decimals ||
        (item.status !== "fresh" && item.status !== "stale" && item.status !== "error" && item.status !== "metadata_conflict") ||
        (item.status !== "fresh" && item.status !== "stale" ? item.amountAtomic !== null :
          typeof item.amountAtomic !== "string" || !DECIMAL.test(item.amountAtomic) || BigInt(item.amountAtomic) >= 1n << 256n))
      throw new Error("GENERAL_BALANCE_INVALID");
    const prior = item.previous as Record<string, unknown> | undefined;
    if (item.status === "stale" ? !prior || typeof prior !== "object" || Array.isArray(prior) ||
      typeof prior.blockNumber !== "string" || !DECIMAL.test(prior.blockNumber) ||
      typeof prior.blockHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(prior.blockHash) ||
      typeof prior.chainTimestamp !== "string" || !DECIMAL.test(prior.chainTimestamp) ||
      typeof prior.fetchedAt !== "string" || !Number.isFinite(Date.parse(prior.fetchedAt)) : prior !== undefined)
      throw new Error("GENERAL_BALANCE_INVALID");
    return { contractAddress: expected.contractAddress, amountAtomic: item.amountAtomic, status: item.status,
      ...(prior ? { previous: { blockNumber: prior.blockNumber, blockHash: prior.blockHash,
        chainTimestamp: prior.chainTimestamp, fetchedAt: prior.fetchedAt } } : {}) };
  });
  return { networkId, address, blockNumber: row.blockNumber, blockHash: row.blockHash,
    chainTimestamp: row.chainTimestamp, fetchedAt: row.fetchedAt, assets: items };
}

/** A separate read-only IPC domain. It never invokes legacy management or payment commands. */
export function attachDesktopGeneralWalletWindow(input: {
  host: DesktopWalletWindowOptions;
  current: () => BrowserWindow | undefined;
  expectedUrl: string;
  epoch: () => number;
  isCurrent: (window: BrowserWindow, generation: number) => boolean; isBusy?: (window: BrowserWindow) => boolean;
  legacyAccounts: (window: BrowserWindow, generation: number, stateGeneration: number) =>
    readonly { walletId: string; address: string }[] | null;
}): () => void {
  const general = input.host.generalWallet;
  if (!general) return attachDesktopWalletManagerWindow(input);
  const instance = randomUUID();
  const preferences = sharedPreferences ??= new DesktopGeneralWalletPreferences(app.getPath("userData"));
  const assets = sharedAssets ??= new DesktopGeneralWalletAssets(app.getPath("userData"));
  const inspections = new Map<string, { walletId: string; networkId: string; generation: number; stateGeneration: number;
    createdAt: number; asset: GeneralCustomAsset }>();
  const balanceReads = new Set<AbortController>();
  const inspectionReads = new Map<AbortController, Promise<void>>();
  const rpc = new DesktopGeneralWalletRpc({
    current: ({ window, generation }) => input.isCurrent(window, generation),
    confirm: ({ window }, networkId, candidate, signal) => input.host.confirmGeneralRpc?.(window, networkId, candidate, signal) ??
      Promise.reject(new Error("GENERAL_PROCESS_UNAVAILABLE")),
    prepare: () => general.prepare(),
    probe: (networkId, choice, signal) => general.probeRpc?.(networkId, choice, signal) ?? Promise.reject(new Error("GENERAL_PROCESS_UNAVAILABLE")),
    changed: (networkId) => { for (const [id, preview] of inspections) if (preview.networkId === networkId) inspections.delete(id); },
  });
  let receiveBusy = false;
  ipcMain.handle(CHANNEL, async (event, raw: unknown) => {
    const window = input.current();
    let balanceController: AbortController | undefined;
    let inspectionController: AbortController | undefined;
    let inspectionFinished: (() => void) | undefined;
    let releaseRpcRead: (() => void) | undefined;
    try {
      if (!window || window.isDestroyed() || !isTrustedWalletSender({
        sender: event.sender, expectedSender: window.webContents,
        frame: event.senderFrame, mainFrame: window.webContents.mainFrame,
        frameUrl: event.senderFrame?.url, expectedUrl: input.expectedUrl,
        visible: window.isVisible() && !window.isMinimized(),
      })) throw new Error("GENERAL_UNTRUSTED_SOURCE");
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("GENERAL_INVALID_REQUEST");
      const command = raw as Record<string, unknown>;
      const keys = Object.keys(command).sort().join();
      const generation = input.epoch();
      if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
      if (keys === "action" && command.action === "cancel_balances") {
        for (const controller of balanceReads) controller.abort();
        return { ok: true, value: null };
      }
      if (keys === "action" && command.action === "cancel_inspections") {
        const active = [...inspectionReads.entries()];
        for (const [controller] of active) controller.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all(active.map(([, done]) => done)),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("GENERAL_CANCELLATION_TIMEOUT")), 5000); }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
        if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
        return { ok: true, value: null };
      }
      if (keys === "action" && command.action === "read_display_preferences") {
        const value = await preferences.read();
        if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
        return { ok: true, value };
      }
      if (keys === "action,mainnets" && command.action === "save_display_preferences") {
        await preferences.save(command.mainnets);
        if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
        return { ok: true, value: null };
      }
      if (keys === "action" && command.action === "read_network_visibility") {
        const value = await preferences.readVisibility();
        if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
        return { ok: true, value };
      }
      if (keys === "action,visibility" && command.action === "save_network_visibility") {
        await preferences.saveVisibility(command.visibility);
        if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
        return { ok: true, value: null };
      }
      if (keys === "action" && command.action === "status") {
        await general.prepare();
        if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
        const value = await general.status();
        if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GENERAL_STATUS_INVALID");
        const status = value as Record<string, unknown>;
        if (Object.keys(status).sort().join() !== "reason,secretAdmission,state" || status.state !== "unavailable" ||
            status.secretAdmission !== "unverified" || status.reason !== "GENERAL_IMPLEMENTATION_INCOMPLETE")
          throw new Error("GENERAL_STATUS_INVALID");
        return { ok: true, value: { secretAdmission: "unverified", available: false } };
      }
      if (keys === "action" && command.action === "networks") {
        await general.prepare();
        if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
        const value = await general.networks();
        if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
        return { ok: true, value };
      }
      if (keys === "action,networkId" && command.action === "rpc_choices" && typeof command.networkId === "string" && NETWORK.test(command.networkId))
        return { ok: true, value: rpc.choices({ window, generation }, command.networkId) };
      if (keys === "action,networkId,rpcChoice" && command.action === "change_rpc" && typeof command.networkId === "string" &&
          NETWORK.test(command.networkId) && typeof command.rpcChoice === "string" && /^[a-z0-9-]{1,64}$/.test(command.rpcChoice)) {
        await rpc.select({ window, generation }, command.networkId, command.rpcChoice);
        return { ok: true, value: null };
      }
      const isBalance = keys === "action,networkId,walletId" && command.action === "balances";
      const isReceiveAssets = keys === "action,networkId,walletId" && command.action === "receive_assets";
      const isListAssets = keys === "action,networkId,offset,walletId" && command.action === "list_assets" &&
        Number.isInteger(command.offset) && (command.offset as number) >= 0 && (command.offset as number) <= 100;
      const isCustomBalances = keys === "action,networkId,offset,walletId" && command.action === "custom_balances" &&
        Number.isInteger(command.offset) && (command.offset as number) >= 0 && (command.offset as number) <= 100;
      const isAddAsset = (keys === "action,inspectionId,networkId,walletId" || keys === "action,inspectionId,networkId,unverifiedDecimals,walletId") &&
        command.action === "add_asset" && typeof command.inspectionId === "string" && WALLET_ID.test(command.inspectionId) &&
        (command.unverifiedDecimals === undefined || Number.isInteger(command.unverifiedDecimals) &&
          (command.unverifiedDecimals as number) >= 0 && (command.unverifiedDecimals as number) <= 255);
      const isVisibility = keys === "action,contractAddress,networkId,visible,walletId" && command.action === "set_asset_visibility" &&
        typeof command.contractAddress === "string" && /^0x[0-9a-f]{40}$/.test(command.contractAddress) && typeof command.visible === "boolean";
      const isInspection = keys === "action,contractAddress,networkId,walletId" && command.action === "inspect_token" &&
        typeof command.contractAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(command.contractAddress) &&
        !/^0x0{40}$/i.test(command.contractAddress);
      const isReceive = keys === "action,assetId,networkId,walletId" && (command.action === "receive" || command.action === "copy_receive") &&
        typeof command.assetId === "string" && /^(?:native|erc20:0x[0-9a-f]{40})$/.test(command.assetId);
      if ((!isBalance && !isReceive && !isReceiveAssets && !isInspection && !isListAssets && !isAddAsset && !isVisibility && !isCustomBalances) ||
          typeof command.walletId !== "string" || !WALLET_ID.test(command.walletId) ||
          typeof command.networkId !== "string" || !NETWORK.test(command.networkId)) throw new Error("GENERAL_INVALID_REQUEST");
      if (isBalance || isCustomBalances || isInspection || isAddAsset) releaseRpcRead = rpc.acquireRead();
      const rpcChoice = rpc.choice({ window, generation }, command.networkId);
      if (isBalance || isCustomBalances) {
        if (balanceReads.size >= 32) throw new Error("GENERAL_OPERATION_BUSY");
        balanceController = new AbortController();
        balanceReads.add(balanceController);
      }
      if (isInspection) {
        if (inspectionReads.size >= 32) throw new Error("GENERAL_OPERATION_BUSY");
        inspectionController = new AbortController();
        inspectionReads.set(inspectionController, new Promise<void>((resolve) => { inspectionFinished = resolve; }));
      }
      const checkBalance = () => { if (balanceController?.signal.aborted) throw new Error("GENERAL_BALANCE_READ_CANCELED"); };
      const checkInspection = () => { if (inspectionController?.signal.aborted) throw new Error("GENERAL_BALANCE_READ_CANCELED"); };
      const stateGeneration = input.host.wallet.stateGeneration();
      const wallets = input.legacyAccounts(window, generation, stateGeneration);
      checkBalance();
      if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
      if (stateGeneration !== input.host.wallet.stateGeneration()) throw new Error("GENERAL_STATE_CHANGED");
      if (!wallets) throw new Error("GENERAL_ACCOUNT_UNAVAILABLE");
      const wallet = wallets.find((item) => item.walletId === command.walletId);
      if (!wallet) throw new Error("GENERAL_ACCOUNT_UNAVAILABLE");
      const assetOwner = { walletId: wallet.walletId.toLowerCase(), address: wallet.address.toLowerCase(), networkId: command.networkId };
      if (isReceiveAssets) {
        const selected = await assets.visible(assetOwner);
        if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration() || selected.generation !== assets.generation())
          throw new Error("GENERAL_STATE_CHANGED");
        return { ok: true, value: selected.assets.map((item) => ({ assetId: `erc20:${item.contractAddress}`,
          symbol: item.symbol || `${item.contractAddress.slice(0, 8)}…${item.contractAddress.slice(-4)}`, contractAddress: item.contractAddress })) };
      }
      if (isListAssets) {
        const value = await assets.list({ ...assetOwner, offset: command.offset as number });
        if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration() || value.generation !== assets.generation())
          throw new Error("GENERAL_STATE_CHANGED");
        return { ok: true, value: { assets: value.assets, total: value.total } };
      }
      if (isCustomBalances) {
        const page = await assets.list({ ...assetOwner, offset: command.offset as number });
        checkBalance();
        const assetGeneration = page.generation;
        const selected = page.assets.filter((item) => item.visible);
        if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration() || assetGeneration !== assets.generation())
          throw new Error("GENERAL_STATE_CHANGED");
        if (!selected.length) return { ok: true, value: { assets: page.assets, total: page.total, snapshot: null } };
        await general.prepare();
        checkBalance();
        if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration() || assetGeneration !== assets.generation())
          throw new Error("GENERAL_STATE_CHANGED");
        const requested = selected.map((item) => ({ contractAddress: item.contractAddress,
          ...(item.decimalsSource === "chain" && item.decimals !== null ? { expectedDecimals: item.decimals } : {}) }));
        const cacheScope = createHash("sha256").update(JSON.stringify([instance, generation, stateGeneration,
          wallet.walletId, "custom", command.offset])).digest("hex");
        const value = await general.customBalances(command.networkId, wallet.address, cacheScope, requested, balanceController?.signal, rpcChoice === "default" ? undefined : rpcChoice);
        checkBalance();
        if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration() || assetGeneration !== assets.generation())
          throw new Error("GENERAL_STATE_CHANGED");
        return { ok: true, value: { assets: page.assets, total: page.total,
          snapshot: projectCustomBalance(value, command.networkId, assetOwner.address, selected, rpcChoice) } };
      }
      if (isAddAsset) {
        const id = command.inspectionId as string, preview = inspections.get(id), now = performance.now();
        inspections.delete(id);
        if (!preview || preview.walletId !== wallet.walletId || preview.networkId !== command.networkId ||
            preview.generation !== generation || preview.stateGeneration !== stateGeneration || preview.asset.address !== assetOwner.address ||
            !Number.isFinite(now) || now < preview.createdAt || now - preview.createdAt >= 120000)
          throw new Error("GENERAL_ASSET_INSPECTION_EXPIRED");
        if (command.unverifiedDecimals !== undefined && preview.asset.decimalsSource !== "unknown") throw new Error("GENERAL_ASSET_INVALID");
        const candidate = command.unverifiedDecimals === undefined ? preview.asset : { ...preview.asset,
          decimals: command.unverifiedDecimals as number, decimalsSource: "user" as const };
        await assets.add(candidate);
        if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration())
          throw new Error("GENERAL_STATE_CHANGED");
        return { ok: true, value: null };
      }
      if (isVisibility) {
        await assets.setVisibility({ ...assetOwner, contractAddress: command.contractAddress as string, visible: command.visible as boolean });
        if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration())
          throw new Error("GENERAL_STATE_CHANGED");
        return { ok: true, value: null };
      }
      if (isInspection) {
        const contractAddress = (command.contractAddress as string).toLowerCase();
        checkInspection();
        await general.prepare();
        checkInspection();
        if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration())
          throw new Error("GENERAL_STATE_CHANGED");
        const value = await general.inspectToken(command.networkId, wallet.address, contractAddress, inspectionController?.signal, rpcChoice === "default" ? undefined : rpcChoice);
        checkInspection();
        if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration())
          throw new Error("GENERAL_STATE_CHANGED");
        const projected = projectTokenInspection(value, command.networkId, wallet.address, contractAddress) as {
          name: string | null; symbol: string | null; decimals: number | null;
        };
        const createdAt = performance.now();
        if (!Number.isFinite(createdAt) || createdAt < 0) throw new Error("GENERAL_TOKEN_INSPECTION_INVALID");
        while (inspections.size >= 32) inspections.delete(inspections.keys().next().value!);
        const inspectionId = randomUUID();
        inspections.set(inspectionId, { walletId: wallet.walletId, networkId: command.networkId, generation, stateGeneration, createdAt,
          asset: { ...assetOwner, contractAddress, name: projected.name, symbol: projected.symbol, decimals: projected.decimals,
            decimalsSource: projected.decimals === null ? "unknown" : "chain", visible: true } });
        return { ok: true, value: { ...projected, inspectionId } };
      }
      if (isReceive) {
        if (receiveBusy) throw new Error("GENERAL_OPERATION_BUSY");
        receiveBusy = true;
        try {
          const { createGeneralReceiveView } = await import("@koincode/wallet/general-receive");
          if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration())
            throw new Error("GENERAL_STATE_CHANGED");
          const assetId = command.assetId as string;
          const builtIn = assetId === "native" || generalTokens(command.networkId).some((item) => `erc20:${item.address}` === assetId);
          const custom = builtIn ? undefined : await assets.find({ ...assetOwner, contractAddress: assetId.slice(6) });
          if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration() ||
              custom && (custom.generation !== assets.generation() || !custom.asset?.visible)) throw new Error("GENERAL_STATE_CHANGED");
          const originalAssetId = builtIn ? assetId : "native";
          const nativeOrBuiltIn = createGeneralReceiveView({ networkId: command.networkId, address: wallet.address, assetId: originalAssetId });
          const expected = custom?.asset ? { ...nativeOrBuiltIn, assetId,
            asset: { symbol: custom.asset.symbol || `${custom.asset.contractAddress.slice(0, 8)}…${custom.asset.contractAddress.slice(-4)}`,
              contractAddress: custom.asset.contractAddress, decimals: custom.asset.decimals } } : nativeOrBuiltIn;
          if (command.action === "copy_receive") {
            clipboard.writeText(expected.address);
            return { ok: true, value: null };
          }
          await general.prepare();
          if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration())
            throw new Error("GENERAL_STATE_CHANGED");
          const value = await general.receive(command.networkId, wallet.address, originalAssetId);
          if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration() ||
              custom && custom.generation !== assets.generation())
            throw new Error("GENERAL_STATE_CHANGED");
          if (JSON.stringify(value) !== JSON.stringify(nativeOrBuiltIn)) throw new Error("GENERAL_RECEIVE_INVALID");
          return { ok: true, value: expected };
        } finally { receiveBusy = false; }
      }
      await general.prepare();
      checkBalance();
      if (!input.isCurrent(window, generation) || stateGeneration !== input.host.wallet.stateGeneration())
        throw new Error("GENERAL_STATE_CHANGED");
      const cacheScope = createHash("sha256").update(JSON.stringify([instance, generation, stateGeneration, wallet.walletId])).digest("hex");
      const value = await general.balances(command.networkId, wallet.address, cacheScope, balanceController?.signal, rpcChoice === "default" ? undefined : rpcChoice);
      checkBalance();
      if (!input.isCurrent(window, generation)) throw new Error("GENERAL_STATE_CHANGED");
      if (stateGeneration !== input.host.wallet.stateGeneration()) throw new Error("GENERAL_STATE_CHANGED");
      return { ok: true, value: projectBalance(value, command.networkId, wallet.address, rpcChoice) };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code
        : error instanceof Error ? error.message : "";
      return { ok: false, error: typeof code === "string" && /^GENERAL_[A-Z0-9_]{1,70}$/.test(code)
        ? code : "GENERAL_PROCESS_UNAVAILABLE" };
    } finally {
      releaseRpcRead?.();
      if (balanceController) balanceReads.delete(balanceController);
      if (inspectionController) { inspectionReads.delete(inspectionController); inspectionFinished?.(); }
    }
  });
  let disposeManager: () => void; try { disposeManager = attachDesktopWalletManagerWindow(input); }
  catch { rpc.dispose(); ipcMain.removeHandler(CHANNEL); throw new Error("GENERAL_PROCESS_UNAVAILABLE"); }
  return () => {
    disposeManager(); rpc.dispose();
    for (const controller of balanceReads) controller.abort();
    for (const controller of inspectionReads.keys()) controller.abort();
    balanceReads.clear(); inspectionReads.clear(); inspections.clear(); ipcMain.removeHandler(CHANNEL);
  };
}
