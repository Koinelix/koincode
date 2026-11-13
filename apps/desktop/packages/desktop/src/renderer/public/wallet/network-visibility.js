(() => {
  window.assertGeneralNetworks = (response, names, testnetIds) => {
      if (!response.ok || !Array.isArray(response.value) || response.value.length !== 14 ||
          new Set(response.value.map((item) => item?.id)).size !== 14 ||
          response.value.some((item) => !item || !names[item.id] || item.testnet !== testnetIds.has(item.id) ||
            typeof item.nativeSymbol !== "string" || !Array.isArray(item.tokens) || item.tokens.length > 2 ||
            item.tokens.some((token) => !token || token.networkId !== item.id || !/^0x[0-9a-f]{40}$/.test(token.address) ||
              !["USDC", "USDT", "ARB"].includes(token.symbol) || ![6, 18].includes(token.decimals)))) throw new Error("Invalid networks");
  };
  window.translateGeneralStatus = (previous, next) => {
    for (const id of ["general-result", "general-receive-status", "general-receive-assets-status", "general-setup-status", "general-rpc-status"]) {
      const node = document.getElementById(id), key = Object.keys(previous).find(key => previous[key] === node?.textContent);
      if (key && typeof next?.[key] === "string") node.textContent = next[key];
    }
  };
  window.localizeGeneralDisplay = ({ messages, displayedBalance, displayedReceive, currentWallets, networkId, names, testnetIds, text, renderBalance, renderNetworkSelectors }) => {
    const receiveAccount = document.getElementById("general-receive-account"), receiveNetwork = document.getElementById("general-receive-network");
    window.updateCustomAssetsMessages?.(messages); window.updateGeneralRpcMessages?.(messages);
    renderNetworkSelectors();
    if (displayedBalance) renderBalance(displayedBalance);
    if (displayedReceive) {
      const wallet = currentWallets.find(item => item.walletId === displayedReceive.walletId);
      receiveAccount.textContent = `${text("generalAccount", "Account")}: ${text(wallet?.isDefault ? "defaultWallet" : "wallet", "Wallet")}`;
      receiveNetwork.textContent = `${text("generalNetwork", "Network")}: ${names[networkId]}${testnetIds.has(networkId) ? ` · ${text("generalTestnet", "Testnet")}` : ""}`;
    }
  };
  window.createGeneralNetworkVisibility = ({ getNetworks, isBusy, text, onChange }) => {
    const toggle = document.getElementById("general-show-testnets");
    const choices = document.getElementById("general-network-visibility");
    const status = document.getElementById("general-network-settings-status");
    const hidden = new Set(), inputs = new Map();
    let showTestnets = true, loaded = false, failed = false, revision = 0;
    const unavailable = () => text("generalNetworkSettingsUnavailable", "Network visibility could not be loaded or saved.");
    function save() {
      const current = ++revision, value = { showTestnets, hidden: [...hidden] };
      void window.walletControl.generalSaveNetworkVisibility(value).then((response) => {
        if (current === revision) status.textContent = response.ok ? "" : unavailable();
      }, () => { if (current === revision) status.textContent = unavailable(); });
    }
    function render() {
      toggle.checked = showTestnets; inputs.clear(); choices.replaceChildren();
      for (const item of getNetworks()) {
        const label = document.createElement("label"), input = document.createElement("input"), title = document.createElement("span");
        input.type = "checkbox"; input.checked = !hidden.has(item.id); title.textContent = item.label;
        input.addEventListener("change", (event) => {
          if (!event.isTrusted || isBusy() || failed) { input.checked = !hidden.has(item.id); return; }
          if (!input.checked && !item.testnet && getNetworks().filter((entry) => !entry.testnet && !hidden.has(entry.id)).length === 1) {
            input.checked = true; status.textContent = text("generalNetworkKeepMainnet", "Keep at least one main network visible."); return;
          }
          if (input.checked) hidden.delete(item.id); else hidden.add(item.id);
          onChange(); save();
        });
        inputs.set(item.id, input); label.append(input, title); choices.append(label);
      }
    }
    toggle.addEventListener("change", (event) => {
      if (!event.isTrusted || isBusy() || failed) { toggle.checked = showTestnets; return; }
      showTestnets = toggle.checked; onChange(); save();
    });
    return {
      hidden,
      get showTestnets() { return showTestnets; },
      controls(disabled) { toggle.disabled = disabled || failed; for (const input of inputs.values()) input.disabled = disabled || failed; },
      async load() {
        if (loaded) return;
        loaded = true;
        try {
          const response = await window.walletControl.generalReadNetworkVisibility(), value = response.value, networks = getNetworks();
          if (!response.ok || value !== null && (!value || typeof value.showTestnets !== "boolean" || !Array.isArray(value.hidden) ||
              value.hidden.length > 13 || new Set(value.hidden).size !== value.hidden.length ||
              value.hidden.some((id) => !networks.some((item) => item.id === id)) ||
              networks.filter((item) => !item.testnet).every((item) => value.hidden.includes(item.id)))) throw new Error("Invalid network visibility");
          if (value) { showTestnets = value.showTestnets; for (const id of value.hidden) hidden.add(id); }
        } catch {
          failed = true; showTestnets = false; hidden.clear();
          const fallback = getNetworks().find((item) => !item.testnet)?.id;
          for (const item of getNetworks()) if (item.id !== fallback) hidden.add(item.id);
          status.textContent = unavailable();
        }
      },
      render,
    };
  };
  window.renderGeneralMainnetChoices = ({ visible, names, selected, inputs, container, onChange }) => {
    inputs.clear(); container.replaceChildren();
    for (const item of visible.filter((entry) => !entry.testnet)) {
      const label = document.createElement("label"), input = document.createElement("input"), title = document.createElement("span");
      input.type = "checkbox"; input.checked = selected.has(item.id); title.textContent = names[item.id];
      input.addEventListener("change", (event) => {
        if (!event.isTrusted) { input.checked = selected.has(item.id); return; }
        if (input.checked) selected.add(item.id); else selected.delete(item.id);
        onChange();
      });
      inputs.set(item.id, input); label.append(input, title); container.append(label);
    }
  };
})();
