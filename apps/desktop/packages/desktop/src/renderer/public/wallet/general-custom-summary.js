(() => {
  window.renderGeneralAssetRows = (container, items) => {
    const rows = [...items].sort((a, b) => Number(b.symbol === "USDC") - Number(a.symbol === "USDC")).map((item) => {
      const row = document.createElement("div"), icon = document.createElement("span"), content = document.createElement("span");
      row.className = "general-asset-row"; row.setAttribute("role", "listitem");
      icon.className = "general-asset-icon"; if (icon.dataset) icon.dataset.symbol = item.symbol; icon.setAttribute("aria-hidden", "true"); icon.textContent = item.symbol.slice(0, 1);
      content.className = "general-asset-amount"; content.textContent = item.value;
      const name = document.createElement("span"); name.className = "general-asset-name"; name.textContent = item.symbol;
      row.append(icon, name, content); return row;
    });
    container.replaceChildren(...rows); return rows.length;
  };
  window.createGeneralBalanceCancellation = (isCurrent) => {
    let pending = Promise.resolve(true);
    const cancel = () => {
      try { pending = Promise.resolve(window.walletControl.generalCancelBalances()).then((response) => response?.ok === true, () => false); }
      catch { pending = Promise.resolve(false); }
    };
    return { cancel, async ready(request) {
      if (await pending) return true;
      if (!isCurrent(request)) return false;
      cancel(); return pending;
    } };
  };
  window.formatGeneralAmount = (value, decimals) => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error("Invalid balance");
    if (decimals === 0) return value;
    const digits = value.padStart(decimals + 1, "0");
    const whole = digits.slice(0, -decimals), fraction = digits.slice(-decimals);
    const significantFraction = fraction.replace(/0+$/, "");
    return value !== "0" && whole === "0" && decimals > 6 && fraction.slice(0, 6) === "000000"
      ? "<0.000001" : `${whole}${significantFraction ? `.${significantFraction}` : ""}`;
  };
  window.describeGeneralCustomBalance = (page, walletId, selected, text, formatAmount) => {
    if (!page || !Array.isArray(page.assets) || page.assets.length > 20 || !Number.isInteger(page.total) ||
        page.total < page.assets.length || page.total > 100) throw new Error("Invalid custom assets");
    const visible = page.assets.filter((item) => item.visible);
    if (page.assets.some((item) => !item || item.walletId !== walletId.toLowerCase() || item.networkId !== selected.id ||
        typeof item.contractAddress !== "string" || !/^0x[0-9a-f]{40}$/.test(item.contractAddress) ||
        typeof item.visible !== "boolean" || !(item.symbol === null || typeof item.symbol === "string" && Array.from(item.symbol).length <= 32) ||
        !(item.decimals === null && item.decimalsSource === "unknown" || Number.isInteger(item.decimals) &&
          item.decimals >= 0 && item.decimals <= 255 && ["chain", "user"].includes(item.decimalsSource))) ||
        new Set(page.assets.map((item) => item.contractAddress)).size !== page.assets.length) throw new Error("Invalid custom assets");
    const snapshot = page.snapshot;
    if ((snapshot === null) !== (visible.length === 0)) throw new Error("Invalid custom snapshot");
    let delay = null;
    const values = [], rows = [];
    if (snapshot !== null) {
      if (!snapshot || snapshot.networkId !== selected.id || !Array.isArray(snapshot.assets) || snapshot.assets.length !== visible.length ||
          typeof snapshot.blockNumber !== "string" || !/^(0|[1-9][0-9]*)$/.test(snapshot.blockNumber) ||
          typeof snapshot.fetchedAt !== "string" || !Number.isFinite(Date.parse(snapshot.fetchedAt))) throw new Error("Invalid custom snapshot");
      const fetched = Date.parse(snapshot.fetchedAt), expired = Date.now() < fetched || Date.now() - fetched >= 30000;
      for (let index = 0; index < visible.length; index++) {
        const item = visible[index], result = snapshot.assets[index];
        if (!result || result.contractAddress !== item.contractAddress) throw new Error("Invalid custom asset identity");
        const name = `${item.symbol || `${item.contractAddress.slice(0, 8)}…${item.contractAddress.slice(-4)}`} (${item.contractAddress})`;
        let value;
        if (result.status === "error") value = text("generalTokenUnavailable", "Balance is unavailable");
        else if (result.status === "metadata_conflict") value = text("generalTokenConflict", "Precision does not match; balance is hidden");
        else if (result.status === "fresh" || result.status === "stale") {
          value = item.decimals === null ? `${result.amountAtomic} ${text("customRawUnits", "raw units")}` : formatAmount(result.amountAtomic, item.decimals);
          if (item.decimals === null && (typeof result.amountAtomic !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(result.amountAtomic))) throw new Error("Invalid balance");
          if (item.decimalsSource === "user") value += ` · ${text("customPrecisionUnverified", "Precision unverified")}`;
          if (result.status === "stale" || expired) {
            const origin = result.status === "stale" ? result.previous : snapshot;
            if (!origin || typeof origin.blockNumber !== "string" || !/^(0|[1-9][0-9]*)$/.test(origin.blockNumber) ||
                typeof origin.fetchedAt !== "string" || !Number.isFinite(Date.parse(origin.fetchedAt))) throw new Error("Invalid balance origin");
          } else {
            delay = Math.max(1, 30000 - (Date.now() - fetched));
          }
        } else throw new Error("Invalid custom balance");
        const label = `${value} ${item.symbol || name}`;
        values.push(label); rows.push({ symbol: item.symbol || "?", value: label });
      }
    }
    const partial = page.total > page.assets.length ? text("generalCustomPartial", "Only the first 20 added tokens are shown; open the token list for more.") : "";
    if (partial) values.push(partial);
    return { value: values.join(" · "), rows, partial, delay };
  };
  window.describeGeneralBalance = (snapshot, selected, text, formatAmount, forceStale = false) => {
    if (!snapshot || !selected || snapshot.networkId !== selected.id || !Array.isArray(snapshot.assets) ||
        snapshot.assets.length < 1 || snapshot.assets.length > 3 || typeof snapshot.blockNumber !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(snapshot.blockNumber)) throw new Error("Invalid balance");
    const fetched = Date.parse(snapshot.fetchedAt);
    if (!Number.isFinite(fetched)) throw new Error("Invalid snapshot time");
    const expired = forceStale || Date.now() < fetched || Date.now() - fetched >= 30000;
    const format = (item, symbol, decimals) => {
      if (item.status === "metadata_conflict") return `${symbol}: ${text("generalTokenConflict", "Precision does not match; balance is hidden")}`;
      if (item.status === "error") return `${symbol}: ${text("generalTokenUnavailable", "Balance is unavailable")}`;
      if (item.status !== "fresh" && item.status !== "stale") throw new Error("Invalid balance status");
      const old = item.status === "stale", origin = old ? item.previous : snapshot;
      if (!origin || typeof origin.blockNumber !== "string" || !/^(0|[1-9][0-9]*)$/.test(origin.blockNumber) ||
          typeof origin.fetchedAt !== "string" || !Number.isFinite(Date.parse(origin.fetchedAt))) throw new Error("Invalid balance origin");
      return `${formatAmount(item.amountAtomic, decimals)} ${symbol}`;
    };
    const native = snapshot.assets[0];
    if (!native || native.asset?.kind !== "native" || native.status === "metadata_conflict") throw new Error("Invalid native asset");
    const rows = [{ symbol: selected.nativeSymbol, value: format(native, selected.nativeSymbol, 18) }];
    for (const token of snapshot.assets.slice(1)) {
      if (!token || token.asset?.kind !== "erc20" || !["USDC", "USDT", "ARB"].includes(token.asset.symbol) ||
          ![6, 18].includes(token.asset.decimals)) throw new Error("Invalid token asset");
      rows.push({ symbol: token.asset.symbol, value: format(token, token.asset.symbol, token.asset.decimals) });
    }
    return { value: rows.map((row) => row.value).join(" · "), rows, blockLabel: "",
      delay: !expired && snapshot.assets.some((item) => item.status === "fresh")
      ? Math.max(1, 30000 - (Date.now() - fetched)) : null };
  };
  window.recordGeneralBalanceFailure = (row, response) => {
    if (response?.ok !== false) return;
    row.accountUnavailable ||= response.error === "GENERAL_ACCOUNT_UNAVAILABLE";
    row.dnsUnavailable ||= response.error === "GENERAL_BALANCE_DNS_UNAVAILABLE";
  };
  window.generalBalanceDiagnostics = (display, text) => [
    display.accountUnavailable ? text("generalAccountRefresh", "Wallet account information is unavailable. Refresh the wallet and try again.") : "",
    display.dnsUnavailable ? text("generalDnsUnavailable", "The RPC address could not be resolved. Check your network and try again.") : "",
  ].filter(Boolean);
  window.projectGeneralSingleRead = ({ balanceResponse, customResponse, previousDisplay, walletId, networkId, selected, text, formatAmount }) => {
    const basePending = balanceResponse.status === "pending", customPending = customResponse.status === "pending";
    let snapshot = null, forceStale = false, custom = null, customFailed = !customPending;
    try {
      const response = balanceResponse.status === "fulfilled" ? balanceResponse.value : null;
      if (!response?.ok) throw new Error("Invalid balance");
      window.describeGeneralBalance(response.value, selected, text, formatAmount);
      snapshot = response.value;
    } catch {
      if (previousDisplay?.walletId === walletId && previousDisplay.networkId === networkId && previousDisplay.snapshot) {
        snapshot = previousDisplay.snapshot; forceStale = basePending ? previousDisplay.forceStale : true;
      }
    }
    try {
      const response = customResponse.status === "fulfilled" ? customResponse.value : null;
      if (!response?.ok) throw new Error("Invalid custom balance");
      window.describeGeneralCustomBalance(response.value, walletId, selected, text, formatAmount);
      custom = response.value; customFailed = false;
    } catch {
      if (previousDisplay?.walletId === walletId && previousDisplay.networkId === networkId) custom = previousDisplay.custom;
    }
    const accountUnavailable = [balanceResponse, customResponse].some((response) =>
      response.status === "fulfilled" && response.value?.ok === false && response.value.error === "GENERAL_ACCOUNT_UNAVAILABLE");
    const dnsUnavailable = [balanceResponse, customResponse].some((response) =>
      response.status === "fulfilled" && response.value?.ok === false && response.value.error === "GENERAL_BALANCE_DNS_UNAVAILABLE");
    return { walletId, networkId, snapshot, forceStale, custom, customFailed, basePending, customPending, selected, accountUnavailable, dnsUnavailable };
  };
})();
