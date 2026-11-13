window.createGeneralAccountImport = ({ byId, call, perform, text, show, status, done, connectExisting }) => {
  let previewId, nextOffset = 0, setupId, rows = [], selected = new Map();
  const controls = (busy, invalid) => {
    byId("import-selected").textContent = `${text("importSelected", "Import selected accounts")} (${selected.size})`;
    byId("import-selected").disabled = busy || invalid || selected.size === 0 || selected.size > 20;
    byId("more-accounts").disabled = busy || invalid || nextOffset === null;
    for (const input of byId("mnemonic-account-list").querySelectorAll("input")) input.disabled = busy || invalid || input.dataset.imported === "true";
  };
  const render = () => {
    byId("mnemonic-account-list").replaceChildren();
    for (const row of rows) {
      const label = document.createElement("div"), input = document.createElement("input"), content = document.createElement("span"), title = document.createElement("label"), address = document.createElement("code");
      label.className = "mnemonic-account"; input.type = "checkbox"; input.id = `mnemonic-account-${row.accountIndex}`; title.htmlFor = input.id; input.dataset.imported = String(row.alreadyImported);
      input.checked = selected.has(row.accountIndex); input.disabled = row.alreadyImported;
      title.textContent = `${text("account", "Account")} ${row.accountIndex + 1}${row.alreadyImported ? ` · ${text("alreadyImported", "Already imported")}` : ""}`;
      address.textContent = row.address; content.append(title, address); label.append(input, content);
      input.addEventListener("change", () => {
        if (input.checked) selected.set(row.accountIndex, row.address); else selected.delete(row.accountIndex);
        byId("selection-count").textContent = `${selected.size} / 20`; controls(false, false);
      });
      if (row.alreadyImported) {
        const connect = document.createElement("button"); connect.type = "button"; connect.className = "secondary account-connect";
        connect.textContent = text("connectExistingAccount", "Connect payment network");
        connect.addEventListener("click", event => { event.preventDefault(); void perform(() => connectExisting(row.address)); });
        content.append(connect);
      }
      byId("mnemonic-account-list").append(label);
    }
    byId("selection-count").textContent = `${selected.size} / 20`;
  };
  const load = async () => {
    const value = await call({ action: "preview_accounts", setupId, phrase: byId("secret").value, offset: nextOffset, ...(previewId ? { previewId } : {}) });
    previewId = value.previewId; nextOffset = value.nextOffset;
    const existing = new Map(rows.map(row => [row.accountIndex, row]));
    for (const row of value.accounts) existing.set(row.accountIndex, row);
    rows = [...existing.values()]; render();
  };
  byId("more-accounts").addEventListener("click", () => void perform(load, "import_preview"));
  byId("import-selected").addEventListener("click", () => void perform(async () => {
    if (!previewId || selected.size < 1 || selected.size > 20) return;
    const value = await call({ action: "import_accounts", setupId, phrase: byId("secret").value, previewId,
      accounts: [...selected].map(([accountIndex, address]) => ({ accountIndex, address })) });
    const result = value.results.map(row => {
      const outcome = row.status === "imported" && row.paymentStatus && row.paymentStatus !== "connected"
        ? text("importPaymentPending", "Imported; connect Agent payments from the account list.") : text(`importResult${row.status}`, row.status);
      return `${text("account", "Account")} ${row.accountIndex + 1}: ${outcome}`;
    }).join(" · ");
    await done(); status("importResults", "Import results:", result);
  }));
  return { controls, localize: render, clear() { previewId = undefined; nextOffset = 0; rows = []; selected.clear(); byId("mnemonic-account-list").replaceChildren(); },
    async start(id) { setupId = id; previewId = undefined; nextOffset = 0; rows = []; selected.clear(); await load(); show("mnemonic-accounts"); status("chooseAccounts", "Select accounts to import."); } };
};
