const api = window.walletControl;
let text = {};
let presentationGeneration = 0;
let working = false;
let refreshGeneration = 0;
let serviceLost = false;
let lossGeneration = 0;
let profileCreatedNeedsOpen = false;
let profileWasOpened = false;
let setupObserved = false;
let actionError;
let displayedError;
const error = document.getElementById("error");
const settings = window.createWalletSettingsView?.(api, { message, run, showError }, {
  basic: true, onLimits: (walletId, summary) => window.walletHome?.limits(walletId, summary),
});
window.walletHistory = window.createWalletHistoryView?.(api, { message, showError });
window.walletHome = window.createWalletHomeView?.(api, { message, run, settings, showError });
const payments = window.createWalletPaymentView?.(api, { message, run, showError, isWorking: () => working });

function message(key, fallback) {
  return typeof text[key] === "string" ? text[key] : fallback;
}
function showError(code) {
  displayedError = code;
  const migration = document.getElementById("migrate-storage");
  if (migration) migration.hidden = !["WALLET_STORAGE_MIGRATION_REQUIRED", "WALLET_STORAGE_MIGRATION_PENDING"].includes(code);
  error.hidden = false;
  error.textContent =
    code === "WALLET_PROFILE_CREATED_REOPEN_REQUIRED"
      ? message(
          "profileCreatedReopen",
          "The wallet profile was created. Open the existing wallet to continue.",
        )
      : `${message("error", "Wallet operation failed")}: ${code}`;
}
function showUnknown(code) {
  window.walletHome?.invalidate();
  document.getElementById("wallet-home-empty").hidden = true;
  document.getElementById("wallet-home-disconnected").hidden = false;
  window.updateGeneralWallets?.([], text);
  settings?.invalidate();
  payments?.invalidate();
  document.getElementById("wallets").replaceChildren();
  document.getElementById("wallets-section").hidden = true;
  document.getElementById("setup").hidden = !profileCreatedNeedsOpen && (!setupObserved || profileWasOpened);
  document.getElementById("create-profile").hidden = profileCreatedNeedsOpen;
  if (profileCreatedNeedsOpen && code === "WALLET_STATE_INVALIDATED")
    code = "WALLET_PROFILE_CREATED_REOPEN_REQUIRED";
  document.getElementById("disconnected").hidden = ![
    "WALLET_NOT_OPEN",
    "WALLET_PROCESS_EXITED",
    "WALLET_TIMEOUT",
  ].includes(code);
  showError(code);
}
function button(label, action) {
  const result = document.createElement("button");
  result.type = "button";
  result.textContent = label;
  result.addEventListener("click", (event) => {
    if (event.isTrusted) void run(action);
  });
  return result;
}
function applyText() {
  document.documentElement.lang = message("lang", "en");
  document.querySelectorAll("[data-text]").forEach((element) => {
    const value = text[element.dataset.text];
    if (typeof value === "string") element.textContent = value;
  });
  document.querySelectorAll("[data-aria-text]").forEach((element) => {
    const value = text[element.dataset.ariaText];
    if (typeof value === "string") element.setAttribute("aria-label", value);
  });
}
function render(data) {
  document.getElementById("wallet-home-disconnected").hidden = true;
  setupObserved ||= data.profileOpen === false;
  profileWasOpened ||= data.profileOpen === true;
  text = data.text;
  if (displayedError === "WALLET_STATE_INVALIDATED" && !data.startupError) {
    displayedError = undefined;
    error.hidden = true;
  }
  if (data.setupRequired === true && !data.startupError) {
    displayedError = undefined;
    error.hidden = true;
  }
  applyText();
  document.getElementById("wallet-card").dataset.setup = data.setupRequired === true ? "true" : "false";
  document.getElementById("wallet-setup-guide").hidden = data.setupRequired !== true;
  document.getElementById("setup").hidden = data.profileOpen;
  document.getElementById("create-profile").hidden = profileCreatedNeedsOpen;
  document.getElementById("wallets-section").hidden = !data.profileOpen;
  document.getElementById("disconnected").hidden = true;
  document.getElementById("empty").hidden = data.wallets.length !== 0;
  const container = document.getElementById("wallets");
  container.replaceChildren();
  for (const wallet of data.wallets) {
    const card = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = wallet.isDefault
      ? message("defaultWallet", "Default wallet")
      : message("wallet", "Wallet");
    const address = document.createElement("p");
    address.className = "address";
    address.textContent = wallet.address;
    const network = document.createElement("p");
    network.textContent = `${message("network", "Network")}: ${wallet.network} · ${message("asset", "Asset")}: ${wallet.asset}`;
    const state = document.createElement("p");
    state.textContent = [
      wallet.locked ? message("locked", "Locked") : wallet.unlockRemainingMs === null
        ? message("unlockedSession", "Unlocked for this app session")
        : message("unlocked", "Unlocked for a limited time"),
      wallet.recoveryRequired ? message("recoveryRequired", "Recovery required") : "",
      wallet.signingPaused ? message("signingPaused", "Signing paused") : "",
    ].filter(Boolean).join(" · ");
    state.hidden = !state.textContent;
    const actions = document.createElement("div");
    actions.className = "actions";
    if (!wallet.isDefault)
      actions.append(
        button(message("setDefault", "Make default"), () => api.setDefault(wallet.walletId)),
      );
    if (settings && data.wallets.length > 1) {
      const openSettings = document.createElement("button");
      openSettings.type = "button";
      openSettings.textContent = message("settings", "Settings");
      openSettings.addEventListener("click", (event) => { if (event.isTrusted) void settings.open(wallet.walletId); });
      actions.append(openSettings);
    }
    card.append(title, address, network, state, actions);
    container.append(card);
  }
  window.walletHome?.update(data);
  settings?.update(data);
  window.updateGeneralWallets?.(data.wallets, text);
  void payments?.refresh();
  if (data.startupError) showError(data.startupError);
  else if (data.profileOpen) { const migration = document.getElementById("migrate-storage"); if (migration) migration.hidden = true; }
}
async function refresh() {
  const generation = ++refreshGeneration, presentation = presentationGeneration;
  try {
    const result = await api.status();
    if (generation !== refreshGeneration) return;
    if (!result.ok) {
      showUnknown(result.error);
      return;
    }
    if (presentation !== presentationGeneration) result.value.text = text;
    text = result.value.text;
    profileCreatedNeedsOpen = result.value.profileCreatedNeedsOpen === true;
    if (profileCreatedNeedsOpen && !result.value.profileOpen) {
      showUnknown("WALLET_PROFILE_CREATED_REOPEN_REQUIRED");
      return;
    }
    if (serviceLost && !result.value.profileOpen && result.value.setupRequired !== true) {
      showUnknown("WALLET_PROCESS_EXITED");
      return;
    }
    render(result.value);
  } catch {
    if (generation !== refreshGeneration) return;
    showUnknown("WALLET_UNAVAILABLE");
  }
}
async function run(action, reopens = false) {
  if (working) return;
  working = true;
  window.walletHome?.controls(true);
  ++refreshGeneration;
  const loss = lossGeneration;
  error.hidden = true;
  actionError = undefined;
  document.querySelectorAll("button").forEach((item) => {
    item.disabled = true;
  });
  try {
    const result = await action();
    if (result.ok && reopens && loss === lossGeneration) {
      serviceLost = false;
      profileCreatedNeedsOpen = false;
    }
    if (!result.ok && result.error === "WALLET_PROFILE_CREATED_REOPEN_REQUIRED") {
      profileCreatedNeedsOpen = true;
      showUnknown(result.error);
      return;
    }
    if (!result.ok && result.error !== "WALLET_INTERACTION_CANCELED") actionError = result.error;
    await refresh();
    if (actionError) showError(actionError);
  } catch {
    showUnknown("WALLET_UNAVAILABLE");
  } finally {
    working = false;
    document.querySelectorAll("button").forEach((item) => {
      item.disabled = false;
    });
    window.updateGeneralControls?.();
    window.walletHome?.controls(false);
  }
}
document.getElementById("migrate-storage")?.addEventListener("click", (event) => {
  if (event.isTrusted) void run(async () => {
    const result = await api.migrateStorage();
    return result.ok ? api.openProfile() : result;
  }, true);
});
for (const [id, action] of [
  ["open-profile", () => api.openProfile()],
  ["reopen-profile", () => api.openProfile()],
  ["home-reconnect-profile", () => api.openProfile()],
  ["create-profile", () => api.createProfile()],
  ["create-wallet", () => api.createWallet()],
]) {
  document.getElementById(id).addEventListener("click", (event) => {
    if (event.isTrusted)
      void run(action, ["open-profile", "reopen-profile", "home-reconnect-profile", "create-profile"].includes(id));
  });
}
api.onStateInvalidated((reason) => {
  settings?.invalidate();
  payments?.invalidate();
  if (reason === "profile_created") {
    refreshGeneration++;
    void refresh();
    return;
  }
  if (reason === "setup_required" || reason === "startup_failed" || reason === "maintenance_finished") {
    // First run without a wallet: the retired service is expected, so show the guide instead of an error.
    serviceLost = false;
    displayedError = undefined;
    error.hidden = true;
    refreshGeneration++;
    void refresh();
    return;
  }
  if (reason === "exited") {
    serviceLost = true;
    lossGeneration++;
  }
  refreshGeneration++;
  showUnknown(actionError ?? (serviceLost ? "WALLET_PROCESS_EXITED" : "WALLET_STATE_INVALIDATED"));
  if (working && reason === "changed") error.hidden = true;
});
const disposeLocale = api.onLocaleChanged?.(() => {
  const current = ++presentationGeneration;
  void api.presentation().then(reply => {
    if (current !== presentationGeneration || !reply.ok) return;
    text = reply.value.text; applyText();
    window.walletHome?.localize(); settings?.localize?.();
    window.updateGeneralMessages?.(text); window.walletHistory?.localize?.(); payments?.localize?.();
    if (displayedError) showError(displayedError);
  }).catch(() => {});
});
window.addEventListener?.("beforeunload", () => { presentationGeneration++; disposeLocale?.(); });
api.onReady(() => {
  void refresh();
});
document.getElementById("refresh").addEventListener("click", (event) => {
  if (event.isTrusted) {
    error.hidden = true;
    void refresh();
  }
});
document.getElementById("open-skill-management").addEventListener("click", (event) => {
  if (!event.isTrusted) return;
  const target = document.getElementById("skill-management");
  target.scrollIntoView({ block: "start" });
  target.focus({ preventScroll: true });
});
