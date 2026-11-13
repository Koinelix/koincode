(() => {
  const account = document.getElementById("general-account");
  const network = document.getElementById("general-network");
  const result = document.getElementById("general-result");
  const assetsList = document.getElementById("general-assets-list");
  const assetsListWrap = document.getElementById("general-assets-list-wrap");
  const load = document.getElementById("general-load-networks");
  const read = document.getElementById("general-read-balance");
  const allChoices = document.getElementById("general-all-choices");
  const allRead = document.getElementById("general-all-read");
  const allResult = document.getElementById("general-all-result");
  const preferencesStatus = document.getElementById("general-preferences-status");
  const receive = document.getElementById("general-open-receive");
  const receivePanel = document.getElementById("general-receive-panel");
  const receiveAsset = document.getElementById("general-receive-asset");
  const receiveAssetsStatus = document.getElementById("general-receive-assets-status");
  const receiveAccount = document.getElementById("general-receive-account");
  const receiveNetwork = document.getElementById("general-receive-network");
  const receiveContract = document.getElementById("general-receive-contract");
  const receiveAddress = document.getElementById("general-receive-address");
  const receiveQr = document.getElementById("general-receive-qr");
  const receiveCopy = document.getElementById("general-copy-receive");
  const receiveStatus = document.getElementById("general-receive-status");
  let messages = {}, currentWallets = [], networks = [], generation = 0, loading = false, initialNetworkLoadStarted = false;
  let receiveGeneration = 0, receiving = false, displayedReceive;
  let balanceTimer, displayedBalance, allTimer, preferencesLoaded = false, preferenceRevision = 0;
  let balancePending = false, initialBalanceReadStarted = false;
  let refreshTimer;
  function scheduleBalanceRefresh() {
    window.clearTimeout(refreshTimer);
    if (document.hidden || !account.value || !network.value) return;
    refreshTimer = window.setTimeout(() => {
      if (!document.hidden && !loading && !balancePending && !receiving) void readBalance(true);
      else scheduleBalanceRefresh();
    }, 60000);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) window.clearTimeout(refreshTimer);
    else if (account.value && network.value && !balancePending && !loading && !receiving) void readBalance(true);
    else scheduleBalanceRefresh();
  });
  function readInitialBalance() {
    if (document.hidden || initialBalanceReadStarted || loading || receiving || !account.value || !networks.some((item) => item.id === network.value)) return;
    initialBalanceReadStarted = true;
    void readBalance(true);
  }
  const cancellation = window.createGeneralBalanceCancellation((request) => request === generation);
  const selectedMainnets = new Set(), mainnetInputs = new Map();
  const testnetIds = new Set(["eip155:11155111", "eip155:84532", "eip155:421614", "eip155:11155420",
    "eip155:97", "eip155:80002", "eip155:43113"]);
  const names = {
    "eip155:1": "Ethereum", "eip155:11155111": "Ethereum Sepolia",
    "eip155:8453": "Base", "eip155:84532": "Base Sepolia",
    "eip155:42161": "Arbitrum One", "eip155:421614": "Arbitrum Sepolia",
    "eip155:10": "OP Mainnet", "eip155:11155420": "OP Sepolia",
    "eip155:56": "BNB Smart Chain", "eip155:97": "BSC Testnet",
    "eip155:137": "Polygon PoS", "eip155:80002": "Polygon Amoy",
    "eip155:43114": "Avalanche C-Chain", "eip155:43113": "Avalanche Fuji",
  };
  const text = (key, fallback) => typeof messages[key] === "string" ? messages[key] : fallback;
  const visibility = window.createGeneralNetworkVisibility({
    getNetworks: () => networks.map((item) => ({ ...item, label: `${names[item.id]}${item.testnet ? ` · ${text("generalTestnet", "Testnet")}` : ""}` })),
    isBusy: () => loading || receiving,
    text, onChange: () => { renderNetworkSelectors(); change(); },
  });
  const controls = () => {
    account.disabled = (loading && !balancePending) || receiving || !currentWallets.length;
    network.disabled = Boolean(window.walletHome) || (loading && !balancePending) || receiving || !networks.length;
    load.disabled = loading || receiving;
    read.disabled = balancePending || loading || receiving || !currentWallets.length || !networks.length;
    receive.disabled = loading || receiving || !currentWallets.length || !networks.length;
    receiveAsset.disabled = receiving || !currentWallets.length || !networks.length;
    receiveCopy.disabled = receiving || !displayedReceive;
    allRead.disabled = loading || receiving || !currentWallets.length || ![...selectedMainnets].some((id) => !visibility.hidden.has(id));
    for (const input of mainnetInputs.values()) input.disabled = loading || receiving || !currentWallets.length;
    visibility.controls(loading || receiving || !networks.length);
    window.updateGeneralRpcSelection?.(network.value, Boolean(networks.length), loading || receiving);
    if (typeof window.updateCustomAssetsSelection === "function")
      window.updateCustomAssetsSelection(account.value, network.value, Boolean(currentWallets.length && networks.length));
  };
  window.updateGeneralControls = controls;
  const resetResult = () => {
    if (balanceTimer !== undefined) window.clearTimeout(balanceTimer);
    if (allTimer !== undefined) window.clearTimeout(allTimer);
    window.clearTimeout(refreshTimer);
    initialBalanceReadStarted = false;
    balanceTimer = undefined; displayedBalance = undefined;
    assetsList.replaceChildren(); assetsListWrap.hidden = true;
    window.walletHome?.balanceShown(false); window.walletHome?.balanceRows([]);
    allTimer = undefined; allResult.replaceChildren();
    result.textContent = text("generalNotLoaded", "Balance has not been requested.");
  };
  const resetReceive = () => {
    receiveGeneration++; receiving = false; displayedReceive = undefined;
    receivePanel.hidden = true;
    const dialog = document.getElementById("wallet-receive-dialog"); if (dialog?.open) dialog.close();
    receiveQr.hidden = true;
    receiveAddress.textContent = "";
    receiveAccount.textContent = "";
    receiveNetwork.textContent = "";
    receiveContract.textContent = "";
    receiveStatus.textContent = "";
    receiveAssetsStatus.textContent = "";
  };
  document.getElementById("wallet-receive-dialog")?.addEventListener("close", () => { resetReceive(); controls(); });
  const option = (value, label) => { const item = document.createElement("option"); item.value = value; item.textContent = label; return item; };
  const formatAmount = window.formatGeneralAmount;
  function renderBalance(display) {
    const description = display.snapshot ? window.describeGeneralBalance(display.snapshot, display.selected, text, formatAmount, display.forceStale)
      : { rows: [], blockLabel: display.basePending ? text("generalLoading", "Reading balance…") : text("generalTokenUnavailable", "Balance is unavailable"), delay: null };
    const custom = display.custom ? window.describeGeneralCustomBalance(display.custom, display.walletId, display.selected, text, formatAmount) : null;
    assetsListWrap.hidden = window.renderGeneralAssetRows(assetsList, [...description.rows, ...(custom?.rows || [])]) === 0;
    window.walletHome?.balanceShown(!assetsListWrap.hidden);
    window.walletHome?.balanceRows(description.rows);
    result.textContent = [description.blockLabel, display.customPending ? text("customLoading", "Loading tokens…") :
      display.customFailed ? text("generalCustomUnavailable", "Custom token balances are unavailable") : "",
      (display.customFailed && custom?.rows.length || display.forceStale && !display.basePending)
        ? text("generalLastKnown", "Showing the last known balance.") : "",
      custom?.partial || "", ...window.generalBalanceDiagnostics(display, text)].filter(Boolean).join(" · ");
    if (balanceTimer !== undefined) window.clearTimeout(balanceTimer);
    balanceTimer = undefined;
    const delay = description.delay === null ? custom?.delay ?? null : custom?.delay == null ? description.delay : Math.min(description.delay, custom.delay);
    if (delay !== null) {
      const identity = displayedBalance;
      const builtInExpires = description.delay !== null && (custom?.delay == null || description.delay <= custom.delay);
      balanceTimer = window.setTimeout(() => {
        if (displayedBalance === identity) { if (builtInExpires) identity.forceStale = true; renderBalance(identity); }
      }, delay);
    }
  }
  const cancelBalanceView = () => {
    if (!balancePending) return;
    balancePending = false; loading = false; cancellation.cancel();
  };
  window.updateGeneralWallets = (wallets, nextMessages) => {
    messages = nextMessages || {};
    if (typeof window.updateCustomAssetsMessages === "function") window.updateCustomAssetsMessages(messages);
    window.updateGeneralRpcMessages?.(messages);
    const oldSelection = account.value, oldAddress = currentWallets.find((wallet) => wallet.walletId === oldSelection)?.address;
    currentWallets = Array.isArray(wallets) ? wallets : []; if (networks.length && window.walletHome && network.value !== window.walletHome.network) renderNetworkSelectors();
    account.replaceChildren(...currentWallets.map((wallet) => option(wallet.walletId,
      `${window.walletHome?.nameFor(wallet.address, wallet.isDefault ? text("defaultWallet", "Default wallet") : text("wallet", "Wallet")) ?? text("wallet", "Wallet")} · ${wallet.address}`)));
    if (window.walletHome) account.value = currentWallets.find((wallet) => wallet.isDefault)?.walletId ?? "";
    else if (currentWallets.some((wallet) => wallet.walletId === oldSelection)) account.value = oldSelection;
    if (oldSelection !== account.value || oldAddress !== currentWallets.find((wallet) => wallet.walletId === account.value)?.address) {
      generation++; cancelBalanceView(); resetResult(); resetReceive();
    }
    if (!currentWallets.length) result.textContent = text("generalNoAccount", "Open an existing payment wallet first.");
    controls();
    if (!initialNetworkLoadStarted) {
      initialNetworkLoadStarted = true;
      void loadNetworks();
    } else readInitialBalance();
  };
  window.updateGeneralMessages = (next) => {
    window.translateGeneralStatus(messages, next);
    messages = next || {};
    window.localizeGeneralDisplay({ messages, displayedBalance, displayedReceive, currentWallets, networkId: network.value, names, testnetIds, text, renderBalance, renderNetworkSelectors });
  };
  const change = () => { generation++; cancelBalanceView(); resetResult(); resetReceive(); controls(); scheduleBalanceRefresh(); };
  window.onGeneralAssetsChanged = (walletId) => {
    if (walletId !== account.value) return;
    change();
  };
  window.onGeneralRpcChanged = () => { window.updateCustomAssetsSelection?.("", "", false); change(); };
  account.addEventListener("change", change); network.addEventListener("change", change);
  function renderNetworkSelectors() {
    const previous = network.value, mainnet = document.createElement("optgroup"), testnet = document.createElement("optgroup");
    mainnet.label = text("generalMainnets", "Main networks"); testnet.label = text("generalTestnets", "Test networks");
    const visible = window.walletHome ? networks.filter(item => item.id === window.walletHome.network)
      : networks.filter((item) => !visibility.hidden.has(item.id) && (!item.testnet || visibility.showTestnets));
    for (const item of visible) (item.testnet ? testnet : mainnet).append(option(item.id,
      `${names[item.id]}${item.testnet ? ` · ${text("generalTestnet", "Testnet")}` : ""}`));
    network.replaceChildren(mainnet, testnet); if (visible.some((item) => item.id === previous)) network.value = previous;
    else if (visible.some((item) => item.id === "eip155:84532") && !previous) network.value = "eip155:84532";
    else network.value = visible.find((item) => !item.testnet)?.id || "";
    window.renderGeneralMainnetChoices({ visible, names, selected: selectedMainnets, inputs: mainnetInputs, container: allChoices,
      onChange: () => {
        generation++; cancelBalanceView(); resetResult(); controls(); scheduleBalanceRefresh();
        const revision = ++preferenceRevision;
        void window.walletControl.generalSaveDisplayPreferences([...selectedMainnets]).then((saved) => {
          if (revision === preferenceRevision) preferencesStatus.textContent = saved.ok ? "" : text("generalPreferencesUnavailable", "Network choices could not be loaded or saved.");
        }, () => { if (revision === preferenceRevision) preferencesStatus.textContent = text("generalPreferencesUnavailable", "Network choices could not be loaded or saved."); });
      } });
  }
  async function loadNetworks() {
    if (loading) return;
    ++generation; cancelBalanceView(); loading = true; controls(); result.textContent = text("generalNetworkLoading", "Loading networks…");
    try {
      const response = await window.walletControl.generalNetworks();
      window.assertGeneralNetworks(response, names, testnetIds);
      networks = response.value;
      if (!preferencesLoaded && !window.walletHome) {
        preferencesLoaded = true;
        try {
          const saved = await window.walletControl.generalReadDisplayPreferences();
          if (!saved.ok || !Array.isArray(saved.value) || saved.value.length > 7 ||
              new Set(saved.value).size !== saved.value.length || saved.value.some((id) => !networks.some((item) => item.id === id && !item.testnet)))
            throw new Error("Invalid display preferences");
          for (const id of saved.value) selectedMainnets.add(id);
        } catch { preferencesStatus.textContent = text("generalPreferencesUnavailable", "Network choices could not be loaded or saved."); }
      }
      if (!window.walletHome) await visibility.load();
      renderNetworkSelectors(); if (!window.walletHome) visibility.render();
      resetReceive();
      if (currentWallets.length) resetResult();
      else result.textContent = text("generalNoAccount", "Open an existing payment wallet first.");
    } catch { result.textContent = text("generalUnavailable", "Balance is unavailable. Please try again later."); }
    finally { loading = false; controls(); readInitialBalance(); }
  }
  load.addEventListener("click", (event) => {
    if (event.isTrusted) void loadNetworks();
  });
  async function readBalance(background = false) {
    if (balancePending || loading || receiving || !currentWallets.length || !networks.some((item) => item.id === network.value)) return;
    const request = ++generation, walletId = account.value, networkId = network.value;
    const selected = networks.find((item) => item.id === networkId);
    if (!background) {
      if (allTimer !== undefined) window.clearTimeout(allTimer);
      allTimer = undefined; allResult.replaceChildren();
    }
    balancePending = true; controls();
    if (!displayedBalance) result.textContent = text("generalLoading", "Reading balance…");
    try {
      if (!await cancellation.ready(request)) throw new Error("Balance cancellation unavailable");
      if (request !== generation || walletId !== account.value || networkId !== network.value) return;
      let balanceResponse = { status: "pending" }, customResponse = { status: "pending" };
      const publish = () => {
        if (request !== generation || walletId !== account.value || networkId !== network.value) return;
        const previousDisplay = displayedBalance;
        displayedBalance = window.projectGeneralSingleRead({ balanceResponse, customResponse, previousDisplay, walletId, networkId, selected, text, formatAmount });
        try { renderBalance(displayedBalance); } catch (error) { displayedBalance = previousDisplay; throw error; }
      };
      await Promise.all([
        Promise.resolve().then(() => window.walletControl.generalBalance(walletId, networkId))
          .then((value) => { balanceResponse = { status: "fulfilled", value }; publish(); }, () => { balanceResponse = { status: "rejected" }; publish(); }),
        Promise.resolve().then(() => window.walletControl.generalCustomBalances(walletId, networkId, 0))
          .then((value) => { customResponse = { status: "fulfilled", value }; publish(); }, () => { customResponse = { status: "rejected" }; publish(); }),
      ]);
    } catch {
      if (request === generation) {
        if (displayedBalance?.walletId === walletId && displayedBalance.networkId === networkId) {
          displayedBalance.forceStale = true; renderBalance(displayedBalance);
        }
        else { assetsList.replaceChildren(); assetsListWrap.hidden = true; result.textContent = text("generalUnavailable", "Balance is unavailable. Please try again later."); }
      }
    }
    finally { if (request === generation) { balancePending = false; controls(); scheduleBalanceRefresh(); } }
  }
  read.addEventListener("click", (event) => { if (event.isTrusted) void readBalance(); });

  allRead.addEventListener("click", async (event) => {
    if (!event.isTrusted || loading || receiving || !currentWallets.length || ![...selectedMainnets].some((id) => !visibility.hidden.has(id))) return;
    cancelBalanceView();
    const walletId = account.value, request = ++generation;
    const rows = networks.filter((item) => !item.testnet && !visibility.hidden.has(item.id) && selectedMainnets.has(item.id))
      .map((item) => ({ network: item, state: "loading", snapshot: null, customState: "loading", custom: null, accountUnavailable: false, dnsUnavailable: false }));
    if (!rows.length || rows.length > 7) return;
    if (allTimer !== undefined) window.clearTimeout(allTimer);
    allTimer = undefined; loading = true; balancePending = true; controls();
    const render = () => {
      if (request !== generation || walletId !== account.value) return;
      let delay = null;
      const items = rows.map((row) => {
        const line = document.createElement("p");
        let value = text("generalLoading", "Reading balance…");
        if (row.state === "error") value = text("generalTokenUnavailable", "Balance is unavailable");
        if (row.state === "done") {
          const description = window.describeGeneralBalance(row.snapshot, row.network, text, formatAmount);
          value = description.value;
          if (description.delay !== null) delay = delay === null ? description.delay : Math.min(delay, description.delay);
        }
        if (row.customState === "error") value += ` · ${text("generalCustomUnavailable", "Custom token balances are unavailable")}`;
        if (row.customState === "done") {
          const custom = window.describeGeneralCustomBalance(row.custom, walletId, row.network, text, formatAmount);
          if (custom.value) value += ` · ${custom.value}`;
          if (custom.delay !== null) delay = delay === null ? custom.delay : Math.min(delay, custom.delay);
        }
        value += window.generalBalanceDiagnostics(row, text).map((message) => ` · ${message}`).join("");
        line.textContent = `${names[row.network.id]}: ${value}`;
        return line;
      });
      allResult.replaceChildren(...items);
      if (allTimer !== undefined) window.clearTimeout(allTimer);
      allTimer = delay === null ? undefined : window.setTimeout(render, delay);
    };
    render();
    let cursor = 0;
    const worker = async () => {
      while (request === generation && walletId === account.value && cursor < rows.length) {
        const row = rows[cursor++];
        try {
          const response = await window.walletControl.generalBalance(walletId, row.network.id);
          if (request !== generation || walletId !== account.value) return;
          window.recordGeneralBalanceFailure(row, response);
          if (!response.ok) throw new Error("Balance unavailable");
          window.describeGeneralBalance(response.value, row.network, text, formatAmount);
          row.snapshot = response.value; row.state = "done";
        } catch { if (request !== generation || walletId !== account.value) return; row.state = "error"; }
        try {
          const response = await window.walletControl.generalCustomBalances(walletId, row.network.id, 0);
          if (request !== generation || walletId !== account.value) return;
          window.recordGeneralBalanceFailure(row, response);
          if (!response.ok) throw new Error("Custom balance unavailable");
          window.describeGeneralCustomBalance(response.value, walletId, row.network, text, formatAmount);
          row.custom = response.value; row.customState = "done";
        } catch { if (request !== generation || walletId !== account.value) return; row.customState = "error"; }
        render();
      }
    };
    try {
      if (!await cancellation.ready(request)) throw new Error("Balance cancellation unavailable");
      if (request === generation && walletId === account.value) await Promise.all([worker(), worker()]);
    } catch {
      if (request === generation) { for (const row of rows) { row.state = "error"; row.customState = "error"; } render(); }
    } finally { if (request === generation) { loading = false; balancePending = false; controls(); scheduleBalanceRefresh(); } }
  });

  async function loadReceive() {
    if (receiving || receivePanel.hidden) return;
    const walletId = account.value, networkId = network.value, assetId = receiveAsset.value;
    const wallet = currentWallets.find((item) => item.walletId === walletId);
    const selected = networks.find((item) => item.id === networkId);
    if (!wallet || !selected) return;
    const request = ++receiveGeneration;
    receiving = true; displayedReceive = undefined; receiveQr.hidden = true; receiveAddress.textContent = "";
    receiveStatus.textContent = text("generalReceiveLoading", "Preparing your receiving address and QR code…"); controls();
    try {
      const response = await window.walletControl.generalReceive(walletId, networkId, assetId);
      if (request !== receiveGeneration || receivePanel.hidden || walletId !== account.value || networkId !== network.value || assetId !== receiveAsset.value) return;
      if (response?.ok === false && response.error === "GENERAL_ACCOUNT_UNAVAILABLE") {
        receiveStatus.textContent = text("generalAccountRefresh", "Wallet account information is unavailable. Refresh the wallet and try again."); return; }
      const value = response.value, qr = value?.qr;
      if (!response.ok || value.networkId !== networkId || value.assetId !== assetId ||
          typeof value.address !== "string" || value.address.toLowerCase() !== wallet.address.toLowerCase() ||
          !value.asset || typeof value.asset.symbol !== "string" || !qr || !Number.isInteger(qr.size) || qr.size < 21 || qr.size > 57 ||
          typeof qr.modules !== "string" || qr.modules.length !== qr.size * qr.size || !/^[01]+$/.test(qr.modules)) throw new Error("Invalid receiving details");
      const context = receiveQr.getContext("2d");
      if (!context) throw new Error("QR code is unavailable");
      const scale = 6, quiet = 4, dimension = (qr.size + quiet * 2) * scale;
      receiveQr.width = dimension; receiveQr.height = dimension;
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, dimension, dimension);
      context.fillStyle = "#000000";
      for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y * qr.size + x] === "1") context.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
      receiveAccount.textContent = `${text("generalAccount", "Account")}: ${wallet.isDefault ? text("defaultWallet", "Default wallet") : text("wallet", "Wallet")}`;
      receiveNetwork.textContent = `${text("generalNetwork", "Network")}: ${names[networkId]}${selected.testnet ? ` · ${text("generalTestnet", "Testnet")}` : ""} · chainId ${value.chainId}`;
      receiveContract.textContent = value.asset.contractAddress ? `${value.asset.symbol} · ${text("generalReceiveContract", "Token contract")}: ${value.asset.contractAddress}` : value.asset.symbol;
      receiveAddress.textContent = value.address; receiveQr.hidden = false; receiveStatus.textContent = "";
      displayedReceive = { walletId, networkId, assetId };
    } catch {
      if (request === receiveGeneration) receiveStatus.textContent = text("generalReceiveUnavailable", "Receiving details are unavailable. Please try again.");
    } finally { if (request === receiveGeneration) { receiving = false; controls(); } }
  }

  receive.addEventListener("click", async (event) => {
    if (!event.isTrusted || receiving || !currentWallets.length) return;
    const walletId = account.value, networkId = network.value, selected = networks.find((item) => item.id === networkId); if (!selected) return;
    const request = ++receiveGeneration; receivePanel.hidden = false; receiving = true; displayedReceive = undefined; receiveQr.hidden = true;
    const dialog = document.getElementById("wallet-receive-dialog"); if (dialog && !dialog.open) dialog.showModal?.();
    receiveAddress.textContent = ""; receiveAssetsStatus.textContent = "";
    receiveStatus.textContent = text("generalReceiveLoading", "Preparing your receiving address and QR code…"); controls();
    try {
      let custom = [];
      try {
        const response = await window.walletControl.generalReceiveAssets(walletId, networkId);
        if (!response.ok || !Array.isArray(response.value) || response.value.length > 99 ||
            new Set(response.value.map((item) => item?.assetId)).size !== response.value.length ||
            response.value.some((item) => !item || typeof item.contractAddress !== "string" || !/^0x[0-9a-f]{40}$/.test(item.contractAddress) ||
              item.assetId !== `erc20:${item.contractAddress}` || typeof item.symbol !== "string" || Array.from(item.symbol).length > 32 ||
              selected.tokens.some((token) => token.address === item.contractAddress))) throw new Error("Invalid receiving assets");
        custom = response.value;
      } catch {
        if (request === receiveGeneration) receiveAssetsStatus.textContent = text("generalReceiveAssetsUnavailable", "Custom tokens are unavailable; built-in assets remain available.");
      }
      if (request !== receiveGeneration || receivePanel.hidden || walletId !== account.value || networkId !== network.value) return;
      receiveAsset.replaceChildren(option("native", selected.nativeSymbol), ...selected.tokens.map((token) =>
        option(`erc20:${token.address}`, `${token.symbol} · ${token.address}`)), ...custom.map((token) =>
        option(token.assetId, `${token.symbol} · ${token.contractAddress}`)));
      receiving = false; controls(); await loadReceive();
    } catch {
      if (request === receiveGeneration) receiveStatus.textContent = text("generalReceiveUnavailable", "Receiving details are unavailable. Please try again.");
    } finally { if (request === receiveGeneration) { receiving = false; controls(); } }
  });
  receiveAsset.addEventListener("change", (event) => { if (event.isTrusted) void loadReceive(); });
  receiveCopy.addEventListener("click", async (event) => {
    if (!event.isTrusted || receiving || !displayedReceive) return;
    const request = receiveGeneration, identity = displayedReceive;
    receiving = true; controls();
    try {
      const response = await window.walletControl.generalCopyReceive(identity.walletId, identity.networkId, identity.assetId);
      if (request !== receiveGeneration || receivePanel.hidden) return;
      if (response?.ok === false && response.error === "GENERAL_ACCOUNT_UNAVAILABLE") {
        displayedReceive = undefined; receiveQr.hidden = true; receiveAddress.textContent = "";
        receiveStatus.textContent = text("generalAccountRefresh", "Wallet account information is unavailable. Refresh the wallet and try again."); return; }
      if (!response.ok) throw new Error("Copy failed");
      receiveStatus.textContent = text("generalAddressCopied", "Address copied.");
    } catch {
      if (request === receiveGeneration) receiveStatus.textContent = text("generalReceiveUnavailable", "Receiving details are unavailable. Please try again.");
    } finally { if (request === receiveGeneration) { receiving = false; controls(); } }
  });
})();
