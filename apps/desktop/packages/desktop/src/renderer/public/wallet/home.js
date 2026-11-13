window.createWalletHomeView = (api, { message, run, settings }) => {
  const byId = (id) => document.getElementById(id);
  const picker = byId("wallet-selector"), limits = byId("wallet-limits-dialog");
  let lastData, network, selected, setupRequired = false, ready = false, count = 0, working = false, loading = false, managerBusy = false, generation = 0;
  const managerButtons = ["general-create", "general-import", "wallet-export"].map(byId);
  const menu = byId("wallet-account-menu"), toggle = byId("wallet-menu-toggle"), actions = byId("wallet-management-actions");
  const closeMenu = () => { menu.hidden = true; toggle.setAttribute?.("aria-expanded", "false"); };
  toggle.addEventListener("click", (event) => { if (event.isTrusted) { menu.hidden = !menu.hidden; toggle.setAttribute?.("aria-expanded", String(!menu.hidden)); } });
  document.addEventListener?.("click", (event) => { if (!menu.contains(event.target) && !toggle.contains(event.target)) closeMenu(); });
  document.addEventListener?.("keydown", (event) => { if (event.key === "Escape" && !menu.hidden) { closeMenu(); toggle.focus(); } });
  let accountNames = {}, namesGeneration = 0, renameTarget, renaming = false;
  const renameDialog = byId("wallet-rename-dialog");
  const nameFor = (address, fallback) => accountNames[address?.toLowerCase()] || fallback;
  function applyNames() {
    if (!lastData) return;
    byId("wallet-single-name").textContent = nameFor(selected?.address, message("defaultWallet", "Default wallet"));
    for (const option of picker.children) {
      const wallet = lastData.wallets.find(item => item.walletId === option.value);
      if (wallet) option.textContent = `${nameFor(wallet.address, message(wallet.isDefault ? "defaultWallet" : "wallet", "Wallet"))} · ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
    }
    for (const option of byId("general-account")?.children ?? []) {
      const wallet = lastData?.wallets.find(item => item.walletId === option.value);
      if (wallet) option.textContent = `${nameFor(wallet.address, message(wallet.isDefault ? "defaultWallet" : "wallet", "Wallet"))} · ${wallet.address}`;
    }
  }
  async function loadNames() {
    if (!api.accountNames) return;
    const current = ++namesGeneration;
    try { const reply = await api.accountNames(); if (current === namesGeneration && reply.ok) { accountNames = reply.value; applyNames();  } } catch { /* Display names do not block wallet status. */ }
  }
  byId("wallet-rename").addEventListener("click", event => {
    if (!event.isTrusted || !selected || working || loading || managerBusy || renaming) return;
    closeMenu(); renameTarget = { address: selected.address }; byId("wallet-name-input").value = nameFor(selected.address, "");
    byId("wallet-name-status").textContent = ""; renameDialog.showModal(); byId("wallet-name-input").focus();
  });
  byId("wallet-rename-cancel").addEventListener("click", () => renameDialog.close());
  byId("wallet-rename-form").addEventListener("submit", async event => {
    event.preventDefault(); if (!event.isTrusted || !renameTarget || renaming || !api.renameAccount) return;
    const target = renameTarget; renaming = true; byId("wallet-name-save").disabled = true;
    try {
      const reply = await api.renameAccount(target.address, byId("wallet-name-input").value);
      if (!reply.ok) throw new Error("Rename unavailable");
      await loadNames(); if (renameTarget === target) renameDialog.close();
    } catch { if (renameTarget === target) byId("wallet-name-status").textContent = message("walletRenameFailed", "Could not save the wallet name."); }
    finally { renaming = false; byId("wallet-name-save").disabled = false; }
  });
  renameDialog.addEventListener("close", () => { renameTarget = undefined; });
  const assets = byId("wallet-assets-dialog");
  byId("wallet-open-assets").addEventListener("click", (event) => { if (event.isTrusted && ready && selected) { closeMenu(); assets.showModal(); } });
  byId("wallet-close-assets").addEventListener("click", () => assets.close());
  let copyGeneration = 0, copyTimer, copyBusy = false, copied = false;
  const copyButton = byId("wallet-copy-address"), copyIcon = byId("wallet-copy-icon"), copyStatus = byId("wallet-copy-status");
  function copyPresentation() {
    copyIcon.textContent = copied ? "✓" : "⧉";
    copyButton.dataset.copied = String(copied);
    copyButton.setAttribute?.("data-aria-text", copied ? "generalAddressCopied" : "generalCopyAddress");
    copyButton.setAttribute?.("aria-label", message(copied ? "generalAddressCopied" : "generalCopyAddress", copied ? "Address copied." : "Copy address"));
    copyStatus.textContent = copied ? message("generalAddressCopied", "Address copied.") : "";
  }
  function clearCopy() {
    copyGeneration++; clearTimeout(copyTimer); copyBusy = false; copied = false; copyPresentation();
  }
  copyButton.addEventListener("click", async (event) => {
    if (!event.isTrusted || !selected || !network || working || loading || managerBusy || copyBusy) return;
    clearCopy();
    const current = copyGeneration, id = selected.walletId, address = selected.address, chain = network;
    const currentCopy = () => current === copyGeneration && id === selected?.walletId && address === selected?.address && chain === network;
    copyBusy = true; controls();
    try {
      const reply = await api.generalCopyReceive(id, chain, "native");
      if (!currentCopy()) return;
      if (!reply.ok) throw new Error("Copy unavailable");
      copied = true; copyPresentation();
      copyTimer = setTimeout(() => { if (currentCopy()) { copied = false; copyPresentation(); } }, 2000);
    } catch {
      if (currentCopy()) copyStatus.textContent = message("generalReceiveUnavailable", "Address copy unavailable.");
    } finally { if (currentCopy()) { copyBusy = false; controls(); } }
  });
  window.addEventListener?.("beforeunload", clearCopy);
  function controls(value) {
    if (typeof value === "boolean") working = value;
    picker.disabled = working || loading || managerBusy || !ready || !count;
    byId("wallet-open-limits").disabled = working || loading || managerBusy || !selected;
    byId("wallet-copy-address").disabled = copyBusy || working || loading || managerBusy || !selected || !network;
    byId("wallet-rename").disabled = working || loading || managerBusy || !selected;
    byId("wallet-open-assets").disabled = working || loading || managerBusy || !selected;
    for (const button of managerButtons) button.disabled = working || loading || managerBusy;
  }
  async function openManager(view = "create") {
    if (working || loading || managerBusy) return;
    closeMenu();
    if (setupRequired && view !== "import") {
      // First run: the user's explicit choice creates the profile (after confirmation) before the manager opens.
      let created = false;
      await run(async () => { const result = await api.createProfile(); created = result.ok === true; return result; }, true);
      if (!created) return;
    }
    const current = generation;
    managerBusy = true; controls();
    const status = byId("general-setup-status"); status.textContent = message("generalSetupChecking", "Opening wallet…");
    try {
      const result = await api.openManager(view);
      if (!result.ok) throw new Error(result.error);
      if (current === generation) status.textContent = message("homeManagerOpened", "Continue in the wallet management window.");
    } catch (error) {
      if (current === generation) status.textContent = message(error?.message === "WALLET_BUSY" ? "homeManagerBusy" : "homeManagerUnavailable", "Wallet management is currently unavailable.");
    } finally { managerBusy = false; controls(); }
  }
  window.openWalletManager = openManager;
  for (const button of managerButtons) button.addEventListener("click", (event) => { if (event.isTrusted) void openManager(button.id === "general-import" ? "import" : button.id === "wallet-export" ? "export" : "create"); });
  const closeLimits = () => { if (limits.open) limits.close(); };
  byId("wallet-close-limits").addEventListener("click", closeLimits);
  byId("wallet-open-limits").addEventListener("click", (event) => {
    if (!event.isTrusted || working || loading || managerBusy || !selected) return;
    limits.showModal(); void settings?.open(selected.walletId);
  });
  picker.addEventListener("change", (event) => {
    if (!event.isTrusted || working || loading || managerBusy || !ready || !picker.value || picker.value === selected?.walletId) return;
    const id = picker.value; picker.disabled = true;
    void run(() => api.setDefault(id));
  });
  byId("home-open-profile").addEventListener("click", (event) => { if (event.isTrusted) void run(() => api.openProfile(), true); });
  byId("wallet-close-receive").addEventListener("click", () => byId("wallet-receive-dialog").close());
  return {
    get network() { return network; },
    localize() {
      if (!lastData) return;
      const status = byId("general-setup-status").textContent;
      const summary = byId("wallet-limit-summary").textContent;
      this.update(lastData); copyPresentation();
      byId("general-setup-status").textContent = status; byId("wallet-limit-summary").textContent = summary;
    },
    balanceRows(rows) {
      const usdc = rows.find(row => row.symbol === "USDC");
      const value = usdc?.value.match(/^(<?[0-9]+(?:\.[0-9]+)?) USDC$/)?.[1];
      byId("wallet-usdc-balance").textContent = value ?? "—";
    },
    update(data) {
      lastData = data;
      const previousNetwork = network;
      network = ["eip155:8453", "eip155:84532"].includes(data.network) ? data.network : undefined;
      byId("wallet-network-label").textContent = network ? (network === "eip155:8453" ? "Base" : "Base Sepolia") : "—";
      byId("wallet-network-badge").hidden = !network;
      byId("wallet-network-badge").textContent = network ? message(network === "eip155:8453" ? "homeMainnet" : "generalTestnet", "Network") : "";
      setupRequired = data.setupRequired === true;
      loading = data.loading === true; ready = data.profileOpen && !loading; count = data.wallets.length;
      const nextSelected = data.wallets.find((wallet) => wallet.isDefault);
      if (selected?.walletId !== nextSelected?.walletId || selected?.address !== nextSelected?.address || previousNetwork !== network) clearCopy();
      if (selected?.walletId !== nextSelected?.walletId) { generation++; byId("wallet-usdc-balance").textContent = "—"; }
      if (selected?.address !== nextSelected?.address && renameDialog.open) renameDialog.close();
      selected = nextSelected;
      picker.hidden = data.wallets.length <= 1;
      byId("wallet-single-name").hidden = data.wallets.length > 1;
      byId("wallet-single-name").textContent = message("defaultWallet", "Default wallet");
      if (actions.parentElement) (setupRequired || !selected ? byId("wallet-card") : byId("wallet-management-slot")).append(actions);
      byId("wallet-export").hidden = !selected;
      byId("wallet-short-address").textContent = selected ? `${selected.address.slice(0, 6)}…${selected.address.slice(-4)}` : "—";
      window.walletHistory?.select(selected?.walletId);
      picker.replaceChildren();
      if (!selected) {
        const empty = document.createElement("option"); empty.value = "";
        empty.textContent = message("homeChooseWallet", "Choose a wallet"); picker.append(empty);
      }
      data.wallets.forEach((wallet, index) => {
        const option = document.createElement("option"); option.value = wallet.walletId;
        option.textContent = `${message(wallet.isDefault ? "defaultWallet" : "wallet", "Wallet")}${wallet.isDefault ? "" : ` ${index + 1}`} · ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
        picker.append(option);
      });
      applyNames(); void loadNames();
      picker.value = selected?.walletId ?? ""; picker.disabled = !data.profileOpen || !data.wallets.length;
      byId("wallet-address").textContent = selected?.address ?? "—";
      byId("wallet-open-limits").disabled = !selected;
      byId("wallet-home-empty").hidden = Boolean(selected) || data.loading;
      byId("wallet-home-disconnected").hidden = true;
      byId("general-setup-status").textContent = data.loading ? message("homeLoading", "Opening your wallet…") : "";
      byId("wallet-limit-summary").textContent = message("homeLimitsPending", "View and set limits");
      if (!selected) closeLimits();
      controls();
    },
    nameFor,
    limits(walletId, summary) {
      if (selected?.walletId === walletId) byId("wallet-limit-summary").textContent = summary;
    },
    balanceShown(visible) { byId("wallet-balance-placeholder").hidden = visible; },
    controls,
    invalidate() {
      namesGeneration++; if (renameDialog.open) renameDialog.close();
      clearCopy(); lastData = undefined; closeMenu(); byId("wallet-usdc-balance").textContent = "—"; byId("wallet-short-address").textContent = "—";
      if (assets.open) assets.close();
      selected = undefined; window.walletHistory?.select(undefined); picker.replaceChildren(); picker.disabled = true;
      generation++; ready = false; loading = false; count = 0;
      byId("general-setup-status").textContent = "";
      byId("wallet-address").textContent = "—";
      byId("wallet-open-limits").disabled = true;
      byId("wallet-limit-summary").textContent = message("homeLimitsPending", "View and set limits");
      // An unavailable connection cannot establish that the existing wallet is empty.
      byId("wallet-home-empty").hidden = true; closeLimits();
      if (byId("wallet-receive-dialog").open) byId("wallet-receive-dialog").close();
    },
  };
};
