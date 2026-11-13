(() => {
  const contract = document.getElementById("custom-contract"), inspect = document.getElementById("custom-inspect");
  const add = document.getElementById("custom-add"), previewText = document.getElementById("custom-preview");
  const decimals = document.getElementById("custom-decimals"), decimalsWrap = document.getElementById("custom-decimals-wrap");
  const refresh = document.getElementById("custom-refresh"), previous = document.getElementById("custom-prev");
  const reload = document.getElementById("custom-reload");
  const next = document.getElementById("custom-next"), status = document.getElementById("custom-status");
  const list = document.getElementById("custom-list");
  let walletId = "", networkId = "", available = false, messages = {}, serial = 0, busy = false;
  let preview, offset = 0, total = 0, rows = [], snapshot, staleTimer;
  let inspectionTicket = 0, cancellation = Promise.resolve(true);
  const text = (key, fallback) => typeof messages[key] === "string" ? messages[key] : fallback;
  const current = (ticket, owner, network) => ticket === serial && owner === walletId && network === networkId && available;
  function requestCancellation() {
    try { return Promise.resolve(window.walletControl.generalCancelInspections()).then((response) => response?.ok === true, () => false); }
    catch { return Promise.resolve(false); }
  }
  function cancelInspection() {
    if (!inspectionTicket) return;
    inspectionTicket = 0; cancellation = requestCancellation();
  }
  async function inspectionReady(ticket, owner, network) {
    if (await cancellation) return true;
    if (!current(ticket, owner, network)) return false;
    cancellation = requestCancellation(); return await cancellation;
  }
  function controls() {
    contract.disabled = !available || busy;
    inspect.disabled = !available || busy;
    decimals.disabled = !available || busy || !preview || !preview.needsDecimals;
    add.disabled = !available || busy || !preview;
    refresh.disabled = !available || busy || !rows.some((item) => item.visible);
    reload.disabled = !available || busy;
    previous.disabled = !available || busy || offset === 0;
    next.disabled = !available || busy || offset + 20 >= total;
    for (const row of list.children) if (row.children[1]) row.children[1].disabled = busy || !available;
  }
  function amount(value, decimals) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error("Invalid amount");
    if (decimals === null) return `${value} ${text("customRawUnits", "raw units")}`;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Invalid precision");
    if (decimals === 0) return value;
    const digits = value.padStart(decimals + 1, "0"), whole = digits.slice(0, -decimals);
    const rawFraction = digits.slice(-decimals), fraction = rawFraction.replace(/0+$/, "");
    if (value !== "0" && whole === "0" && decimals > 6 && rawFraction.slice(0, 6) === "000000") return "<0.000001";
    return `${whole}${fraction ? `.${fraction}` : ""}`;
  }
  function validPage(value) {
    if (!value || !Array.isArray(value.assets) || value.assets.length > 20 || !Number.isInteger(value.total) ||
        value.total < 0 || value.total > 100 || value.assets.length > value.total ||
        value.assets.some((item) => !item || item.walletId !== walletId.toLowerCase() || item.networkId !== networkId ||
          typeof item.contractAddress !== "string" || !/^0x[0-9a-f]{40}$/.test(item.contractAddress) ||
          typeof item.visible !== "boolean" || !(item.name === null || typeof item.name === "string" && Array.from(item.name).length <= 128) ||
          !(item.symbol === null || typeof item.symbol === "string" && Array.from(item.symbol).length <= 32) ||
          !(item.decimals === null && item.decimalsSource === "unknown" || Number.isInteger(item.decimals) && item.decimals >= 0 && item.decimals <= 255 &&
            ["chain", "user"].includes(item.decimalsSource)))) throw new Error("Invalid asset page");
  }
  function render() {
    if (staleTimer !== undefined) window.clearTimeout(staleTimer);
    staleTimer = undefined;
    let stale = false;
    if (snapshot) {
      const fetched = Date.parse(snapshot.fetchedAt);
      stale = !Number.isFinite(fetched) || Date.now() < fetched || Date.now() - fetched >= 30000;
      if (!stale) staleTimer = window.setTimeout(render, Math.max(1, 30000 - (Date.now() - fetched)));
    }
    const nodes = rows.map((item) => {
      const row = document.createElement("div"), detail = document.createElement("span"), toggle = document.createElement("button");
      row.className = "custom-asset-row"; row.setAttribute("role", "listitem");
      const name = item.symbol || `${item.contractAddress.slice(0, 8)}…${item.contractAddress.slice(-4)}`;
      const result = snapshot?.assets?.find((entry) => entry.contractAddress === item.contractAddress);
      let balance = text("customNotRead", "Balance not requested");
      if (!item.visible) balance = text("customHidden", "Hidden");
      else if (result?.status === "fresh" || result?.status === "stale") {
        balance = amount(result.amountAtomic, item.decimals);
        if (item.decimalsSource === "user") balance += ` · ${text("customPrecisionUnverified", "Precision unverified")}`;
        if (stale || result.status === "stale") {
          const origin = result.status === "stale" ? result.previous : snapshot;
          balance += ` · ${text("generalStale", "Outdated")} · ${text("generalSnapshot", "Block")} ${origin.blockNumber} · ${new Date(origin.fetchedAt).toLocaleString()}`;
        }
      } else if (result?.status === "metadata_conflict") balance = text("generalTokenConflict", "Precision does not match; balance is hidden");
      else if (result?.status === "error") balance = text("generalTokenUnavailable", "Balance is unavailable");
      detail.textContent = `${name}${item.name ? ` · ${item.name}` : ""} · ${item.contractAddress} · ${balance}`;
      toggle.type = "button";
      toggle.textContent = item.visible ? text("customHide", "Hide") : text("customShow", "Show");
      toggle.disabled = busy || !available;
      toggle.addEventListener("click", (event) => { if (event.isTrusted) void visibility(item); });
      row.append(detail, toggle); return row;
    });
    list.replaceChildren(...nodes);
    status.textContent = rows.length ? `${offset + 1}–${offset + rows.length} / ${total}` : text("customEmpty", "No custom tokens on this network.");
    controls();
  }
  async function loadPage(withBalances = false) {
    if (!available || busy) return;
    const owner = walletId, network = networkId, ticket = ++serial;
    busy = true; controls(); status.textContent = text("customLoading", "Loading tokens…");
    try {
      const response = withBalances ? await window.walletControl.generalCustomBalances(owner, network, offset)
        : await window.walletControl.generalListAssets(owner, network, offset);
      if (!current(ticket, owner, network)) return;
      if (!response.ok) throw new Error("Asset list unavailable");
      validPage(response.value);
      const nextSnapshot = withBalances ? response.value.snapshot : null;
      if (withBalances && (nextSnapshot === null) !== (response.value.assets.every((item) => !item.visible))) throw new Error("Invalid snapshot");
      if (nextSnapshot !== null && (!nextSnapshot || nextSnapshot.networkId !== network || !Array.isArray(nextSnapshot.assets) ||
          nextSnapshot.assets.length !== response.value.assets.filter((item) => item.visible).length ||
          typeof nextSnapshot.blockNumber !== "string" || !/^(0|[1-9][0-9]*)$/.test(nextSnapshot.blockNumber) ||
          typeof nextSnapshot.fetchedAt !== "string" || !Number.isFinite(Date.parse(nextSnapshot.fetchedAt)) ||
          nextSnapshot.assets.some((item) => item?.status === "stale" && (!item.previous ||
            typeof item.previous.blockNumber !== "string" || !/^(0|[1-9][0-9]*)$/.test(item.previous.blockNumber) ||
            typeof item.previous.fetchedAt !== "string" || !Number.isFinite(Date.parse(item.previous.fetchedAt)))))) throw new Error("Invalid snapshot");
      rows = response.value.assets; total = response.value.total; snapshot = nextSnapshot;
      render();
    } catch { if (current(ticket, owner, network)) { rows = []; snapshot = null; list.replaceChildren(); status.textContent = text("customUnavailable", "Tokens are unavailable. Please try again."); } }
    finally { if (current(ticket, owner, network)) { busy = false; controls(); } }
  }
  async function visibility(item) {
    if (!available || busy) return;
    const owner = walletId, network = networkId, ticket = ++serial;
    busy = true; controls();
    try {
      const response = await window.walletControl.generalSetAssetVisibility(owner, network, item.contractAddress, !item.visible);
      if (response.ok) window.onGeneralAssetsChanged?.(owner);
      if (!current(ticket, owner, network)) return;
      if (!response.ok) throw new Error("Visibility unavailable");
      busy = false; await loadPage();
    } catch { if (current(ticket, owner, network)) status.textContent = text("customUnavailable", "Tokens are unavailable. Please try again."); }
    finally { if (current(ticket, owner, network)) { busy = false; controls(); } }
  }
  window.updateCustomAssetsMessages = (value) => {
    const oldStatus = status.textContent, key = Object.keys(messages).find(key => messages[key] === oldStatus);
    const previousPreview = previewText.textContent, previewKey = Object.keys(messages).find(key => messages[key] === previewText.textContent);
    messages = value || {}; render();
    if (preview?.display && previousPreview === preview.summary) {
      const data = preview.display;
      preview.summary = `${data.symbol || data.contractAddress} · ${data.name || data.contractAddress} · ${amount(data.balanceAtomic, data.decimals)}`;
      previewText.textContent = preview.summary;
    }
    if (previewKey) previewText.textContent = text(previewKey, previousPreview);
    if (key) status.textContent = text(key, oldStatus);
  };
  window.updateCustomAssetsSelection = (owner, network, enabled) => {
    if (walletId === owner && networkId === network && available === enabled) { controls(); return; }
    cancelInspection();
    serial++; walletId = owner; networkId = network; available = enabled; busy = false; preview = undefined; offset = 0; total = 0;
    rows = []; snapshot = null; contract.value = ""; decimals.value = ""; decimalsWrap.hidden = true; previewText.textContent = ""; list.replaceChildren();
    if (staleTimer !== undefined) window.clearTimeout(staleTimer);
    staleTimer = undefined; status.textContent = ""; controls();
    if (available) void loadPage();
  };
  contract.addEventListener("input", () => { cancelInspection(); serial++; busy = false; preview = undefined; decimals.value = ""; decimalsWrap.hidden = true; previewText.textContent = ""; controls(); });
  inspect.addEventListener("click", async (event) => {
    if (!event.isTrusted || !available || busy) return;
    const target = contract.value.trim(), owner = walletId, network = networkId;
    preview = undefined; decimals.value = ""; decimalsWrap.hidden = true;
    if (!/^0x[0-9a-fA-F]{40}$/.test(target) || /^0x0{40}$/i.test(target)) {
      previewText.textContent = text("customInvalidContract", "Enter a valid nonzero contract address."); controls(); return;
    }
    const ticket = ++serial; busy = true; controls(); previewText.textContent = text("customChecking", "Checking token…");
    try {
      if (!await inspectionReady(ticket, owner, network)) {
        if (current(ticket, owner, network)) previewText.textContent = text("customCancellationUnavailable", "A previous token check could not be canceled. Please try again.");
        return;
      }
      if (!current(ticket, owner, network) || contract.value.trim().toLowerCase() !== target.toLowerCase()) return;
      inspectionTicket = ticket;
      const response = await window.walletControl.generalInspectToken(owner, network, target);
      if (!current(ticket, owner, network) || contract.value.trim().toLowerCase() !== target.toLowerCase()) return;
      const value = response.value;
      if (!response.ok || !value || value.networkId !== network || value.contractAddress !== target.toLowerCase() ||
          typeof value.inspectionId !== "string" || !/^[0-9a-f-]{36}$/.test(value.inspectionId) ||
          !(value.symbol === null || typeof value.symbol === "string") || !(value.name === null || typeof value.name === "string")) throw new Error("Invalid token");
      const balance = amount(value.balanceAtomic, value.decimals);
      previewText.textContent = `${value.symbol || value.contractAddress} · ${value.name || value.contractAddress} · ${balance}`;
      preview = { inspectionId: value.inspectionId, needsDecimals: value.decimals === null, display: value, summary: previewText.textContent };
      decimalsWrap.hidden = !preview.needsDecimals;
    } catch { if (current(ticket, owner, network)) previewText.textContent = text("customCheckFailed", "Token check failed. Verify the network and contract."); }
    finally { if (inspectionTicket === ticket) inspectionTicket = 0; if (current(ticket, owner, network)) { busy = false; controls(); } }
  });
  add.addEventListener("click", async (event) => {
    if (!event.isTrusted || !available || busy || !preview) return;
    const rawDecimals = decimals.value.trim();
    if (preview.needsDecimals && rawDecimals && (!/^(?:0|[1-9][0-9]{0,2})$/.test(rawDecimals) || Number(rawDecimals) > 255)) {
      previewText.textContent = text("customDecimalsInvalid", "Enter a whole number from 0 to 255, or leave it blank for raw units."); return;
    }
    const unverifiedDecimals = preview.needsDecimals && rawDecimals ? Number(rawDecimals) : undefined;
    const owner = walletId, network = networkId, ticket = ++serial, inspectionId = preview.inspectionId;
    preview = undefined; busy = true; controls();
    try {
      const response = await window.walletControl.generalAddAsset(owner, network, inspectionId, unverifiedDecimals);
      if (response.ok) window.onGeneralAssetsChanged?.(owner);
      if (!current(ticket, owner, network)) return;
      if (!response.ok) throw new Error("Asset save failed");
      previewText.textContent = text("customAdded", "Token added."); contract.value = ""; decimals.value = ""; decimalsWrap.hidden = true; busy = false; await loadPage();
    } catch { if (current(ticket, owner, network)) previewText.textContent = text("customAddFailed", "Token could not be added. Check it again or verify the asset limit."); }
    finally { if (current(ticket, owner, network)) { busy = false; controls(); } }
  });
  refresh.addEventListener("click", (event) => { if (event.isTrusted) void loadPage(true); });
  reload.addEventListener("click", (event) => { if (event.isTrusted) void loadPage(); });
  previous.addEventListener("click", (event) => { if (event.isTrusted && !busy && offset > 0) { offset -= 20; void loadPage(); } });
  next.addEventListener("click", (event) => { if (event.isTrusted && !busy && offset + 20 < total) { offset += 20; void loadPage(); } });
  controls();
})();
