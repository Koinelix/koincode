window.createWalletHistoryView = (api, { message }) => {
  const byId = id => document.getElementById(id), dialog = byId("wallet-history-dialog"), list = byId("wallet-history-list");
  let walletId, generation = 0, nextOffset = null, loading = false;
  let page = 0, timer, displayed;
  function schedule() {
    window.clearTimeout(timer);
    if (dialog.open && !document.hidden && walletId)
      timer = window.setTimeout(() => { if (dialog.open && !document.hidden) void load(page, true); }, 15000);
  }
  function stop() { window.clearTimeout(timer); generation++; loading = false; }
  dialog.addEventListener("close", stop);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (dialog.open) void load(page, true);
  });
  const amount = value => {
    const atomic = BigInt(value), fraction = (atomic % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
    return `${atomic / 1000000n}${fraction ? `.${fraction}` : ""} USDC`;
  };
  const text = (key, fallback) => message(key, fallback);
  const line = (parent, name, value) => {
    const node = document.createElement("p"); node.textContent = `${name}: ${value}`; parent.append(node);
  };
  const expanded = new Set();
  const node = (tag, content, className) => {
    const element = document.createElement(tag);
    if (content !== undefined) element.textContent = content;
    if (className) element.className = className;
    return element;
  };
  function render(data) {
    const focusedId = document.activeElement?.className === "history-toggle" ? document.activeElement.dataset.intentId : undefined;
    let restoreFocus;
    list.replaceChildren(); nextOffset = data.nextOffset;
    byId("wallet-history-status").textContent = "";
    const table = node("table", undefined, "history-table"), head = node("thead"), headings = node("tr"), body = node("tbody");
    for (const [key, fallback] of [["historyPurpose", "Purpose"], ["historyAmount", "Amount (USDC)"], ["status", "Status"], ["historySettledAt", "Settled at"]]) {
      const cell = node("th", text(key, fallback)); cell.scope = "col"; headings.append(cell);
    }
    head.append(headings); table.append(head, body);
    for (const row of data.records) {
      const entry = node("tr"), purpose = node("td"), value = node("td", undefined, "history-amount"), state = node("td"), time = node("td", undefined, "history-time");
      const title = text(row.scheme === "upto" ? "historyModel" : "historyFixed", row.scheme === "upto" ? "Model call" : "Fixed-price service");
      const toggle = node("button", title, "history-toggle"); toggle.type = "button";
      toggle.dataset.intentId = row.intentId;
      if (focusedId && focusedId === row.intentId) restoreFocus = toggle;
      toggle.setAttribute("aria-label", `${title}: ${text("paymentDetails", "Payment details")}`);
      const detailRow = node("tr", undefined, "history-detail-row"), detailCell = node("td"), detail = node("div", undefined, "history-detail");
      detailCell.colSpan = 4; detailCell.append(detail); detailRow.append(detailCell);
      const isOpen = () => expanded.has(row.intentId);
      const update = () => { detailRow.hidden = !isOpen(); toggle.setAttribute("aria-expanded", String(isOpen())); };
      update();
      toggle.addEventListener("click", () => { if (isOpen()) expanded.delete(row.intentId); else expanded.add(row.intentId); update(); });
      purpose.append(toggle);
      const verified = row.scheme === "upto" ? row.status === "CONFIRMED" && row.actualAmountAtomic != null : row.spent === true;
      if (verified) value.append(node("strong", amount(row.scheme === "upto" ? row.actualAmountAtomic : row.amountAtomic).replace(" USDC", "")));
      else {
        value.append(node("span", text("historyUnverified", "Not yet verified")));
        value.append(node("small", `${text("historyCap", "Max")} ${amount(row.amountAtomic).replace(" USDC", "")}`));
      }
      const status = row.waiverContradicted ? text("historyBrokenWaiver", "Authorization used after the platform waived settlement")
        : text(`historyStatus${row.status}`, text(`paymentStatus${row.status}`, row.status));
      const badge = node("span", status, "history-status");
      badge.dataset.tone = row.waiverContradicted ? "warning" : row.status === "CONFIRMED" ? "confirmed" : "neutral";
      state.append(badge);
      const settledDate = row.settledAt == null ? undefined : new Date(row.settledAt * 1000);
      if (settledDate && Number.isFinite(settledDate.getTime())) {
        const locale = document.documentElement?.lang || "en";
        time.append(node("span", settledDate.toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" })),
          node("small", settledDate.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })));
      } else time.textContent = "—";
      entry.append(purpose, value, state, time); body.append(entry, detailRow);
      const network = row.network === "eip155:8453" ? text("historyMainnet", "Base mainnet")
        : row.network === "eip155:84532" ? text("historyTestnet", "Base Sepolia testnet") : row.network ?? text("historyUnknownNetwork", "Unknown network");
      line(detail, text("network", "Network"), network);
      line(detail, text("paymentTarget", "Request"), `${row.origin}${row.path}`);
      line(detail, text("historyMaximum", "Authorized maximum"), amount(row.amountAtomic));
      if (row.reserved) line(detail, text("reserved", "Reserved"), amount(row.amountAtomic));
      if (row.scheme === "upto" && verified && BigInt(row.actualAmountAtomic) <= BigInt(row.amountAtomic))
        line(detail, text("historyReleased", "Released reservation"), amount((BigInt(row.amountAtomic) - BigInt(row.actualAmountAtomic)).toString()));
      if (row.settledAt != null) {
        const date = new Date(row.settledAt * 1000);
        if (Number.isFinite(date.getTime())) line(detail, text("historySettledAt", "Settled at"), date.toLocaleString(document.documentElement?.lang || "en"));
      }
      if (row.settlementTx) line(detail, text("transaction", "Transaction"), row.settlementTx);
    }
    if (data.records.length) list.append(table);
    else list.textContent = text("noRecords", "No records on this page.");
    restoreFocus?.focus({ preventScroll: true });
    byId("wallet-more-history").hidden = nextOffset === null;
  }
  async function load(offset = 0, displayOnly = false) {
    if (!dialog.open || document.hidden || !walletId || loading) return;
    window.clearTimeout(timer);
    loading = true;
    const current = ++generation, selected = walletId;
    byId("wallet-refresh-history").disabled = true; byId("wallet-more-history").disabled = true;
    try {
      const reply = await api.inspectWallet(selected, "payments", offset, displayOnly);
      if (current !== generation || selected !== walletId) return;
      if (!reply.ok) throw new Error(reply.error);
      const data = reply.value;
      page = offset; displayed = { walletId: selected, data }; render(data);
    } catch {
      if (current === generation) byId("wallet-history-status").textContent = text("historyRefreshFailed", "Could not refresh payment records.");
    }
    finally {
      if (current === generation) { loading = false; byId("wallet-refresh-history").disabled = false; byId("wallet-more-history").disabled = false; schedule(); }
    }
  }
  byId("wallet-open-history").addEventListener("click", event => { if (event.isTrusted && walletId) { dialog.showModal(); void load(); } });
  byId("wallet-close-history").addEventListener("click", () => dialog.close());
  byId("wallet-refresh-history").addEventListener("click", event => { if (event.isTrusted) void load(); });
  byId("wallet-more-history").addEventListener("click", event => { if (event.isTrusted && nextOffset !== null) void load(nextOffset); });
  return { localize() { if (dialog.open && displayed?.walletId === walletId) render(displayed.data); }, select(id) {
    if (walletId !== id) { walletId = id; displayed = undefined; expanded.clear(); stop(); page = 0; byId("wallet-history-status").textContent = ""; nextOffset = null; list.replaceChildren(); if (dialog.open) dialog.close(); }
    byId("wallet-open-history").disabled = !walletId;
  } };
};
