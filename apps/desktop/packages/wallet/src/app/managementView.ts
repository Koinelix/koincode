import { budgetView } from "../domain/budget.js";
import { requireWallet } from "../domain/errors.js";
import type {
  WalletInspection,
  WalletInspectionRecord,
  WalletInspectionSection,
  WalletQuery,
} from "./runtimeTypes.js";
import type { RuntimeContext } from "./runtimeContext.js";
import { walletInfo, walletRecord } from "./runtimeContext.js";
import type { WalletRecord, WalletState } from "./state.js";
import { credentialReferences } from "./credentialMetadata.js";
import { desktopClientId } from "./desktopClient.js";

const MAX_PAGE_ROWS = 50;
const MAX_PAGE_BYTES = 64 * 1024;

export function walletBudgetQuery(
  ctx: RuntimeContext,
  state: WalletState,
  wallet: WalletRecord,
): WalletQuery {
  let now = state.trustedTime;
  try {
    now = ctx.clock.now();
  } catch {
    /* Stale display time cannot age spending out. */
  }
  const subject = state.subjects.find((item) => item.subjectId === wallet.subjectId)!;
  const limits = state.policies[wallet.subjectId]!;
  return {
    wallet: walletInfo(ctx, wallet, undefined, state),
    limits: { ...limits },
    budget: now > 0 ? budgetView(subject, limits, state.events, now) : null,
  };
}

/** Trusted control plane only; no model, SDK or MCP receives this projection. */
export function inspectWallet(
  ctx: RuntimeContext,
  walletId: string,
  section: WalletInspectionSection,
  offset = 0,
): WalletInspection {
  requireWallet(!ctx.fence.signal.aborted, "WALLET_CLOSED", "The wallet service is closing.");
  requireWallet(
    ["clients", "grants", "payments"].includes(section) &&
      Number.isSafeInteger(offset) &&
      offset >= 0,
    "INVALID_REQUEST",
    "A valid management section and nonnegative offset are required.",
  );
  const state = ctx.state.snapshot(),
    wallet = walletRecord(state, walletId);
  const common = walletBudgetQuery(ctx, state, wallet);
  const result: WalletInspection = { ...common, section, offset, nextOffset: null, records: [] };
  const desktop = state.clients.find(item => item.clientId === desktopClientId(state.ownerId, state.managementEpoch) && item.subjectIds.includes(wallet.subjectId));
  if (desktop) result.desktopClient = { clientId: desktop.clientId, generation: desktop.generation,
    active: desktop.active, kind: desktop.kind, credentialReferences: credentialReferences(state, desktop.clientId) };
  // Reserve envelope space even on the final page. Never truncate a displayed financial fact.
  let bytes = Buffer.byteLength(JSON.stringify({ ...result, nextOffset: Number.MAX_SAFE_INTEGER }));
  requireWallet(bytes <= MAX_PAGE_BYTES, "MANAGEMENT_ITEM_TOO_LARGE", "Desktop connection metadata exceeds its display bound.");
  let index = 0;
  for (const row of records(state, wallet, section)) {
    if (index++ < offset) continue;
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (result.records.length === MAX_PAGE_ROWS || bytes + size > MAX_PAGE_BYTES) {
      requireWallet(
        result.records.length > 0,
        "MANAGEMENT_ITEM_TOO_LARGE",
        "A management record exceeds its display bound.",
      );
      result.nextOffset = offset + result.records.length;
      break;
    }
    bytes += size;
    result.records.push(row);
  }
  return result;
}

function* records(
  state: WalletState,
  wallet: WalletRecord,
  section: WalletInspectionSection,
): Generator<WalletInspectionRecord> {
  if (section === "clients") {
    for (const item of state.clients)
      if (item.subjectIds.includes(wallet.subjectId)) {
        const { clientId, generation, active, kind } = item;
        const references = credentialReferences(state, clientId);
        yield { clientId, generation, active, kind, ...(references.length ? { credentialReferences: references } : {}) };
      }
  } else if (section === "grants") {
    for (const item of state.grants)
      if (item.subjectId === wallet.subjectId) {
        const {
          grantId,
          clientIds,
          scope,
          origin,
          path,
          pathPrefix,
          method,
          payTo,
          maxAmountAtomic,
          expiresAt,
          status,
        } = item;
        yield {
          grantId,
          clientIds: [...clientIds],
          scope,
          origin,
          path,
          pathPrefix,
          method,
          payTo,
          maxAmountAtomic,
          expiresAt,
          status,
        };
      }
  } else {
    for (let index = state.intents.length - 1; index >= 0; index--) {
      const item = state.intents[index]!;
      if (item.walletId !== wallet.walletId) continue;
      const {
        intentId,
        requestId,
        clientId,
        origin,
        path,
        method,
        payTo,
        amountAtomic,
        status,
        reserved,
        spent,
        settledAt,
        network,
        asset,
        settlementTx,
        settlementBlock,
        settlementHash,
      } = item;
      yield {
        ...(item.waiverContradicted ? { waiverContradicted: true } : {}),
        scheme: item.scheme ?? "exact",
        ...(item.actualAmountAtomic ? { actualAmountAtomic: item.actualAmountAtomic } : {}),
        intentId,
        requestId,
        clientId,
        origin,
        path,
        method,
        payTo,
        amountAtomic,
        status,
        reserved,
        spent,
        settledAt,
        network,
        asset,
        ...(settlementTx ? { settlementTx } : {}),
        ...(settlementBlock !== undefined ? { settlementBlock } : {}),
        ...(settlementHash ? { settlementHash } : {}),
      };
    }
  }
}
