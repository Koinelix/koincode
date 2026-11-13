(() => {
  const byId = (id) => document.getElementById(id);
  const bridge = window.generalSetupControl;
  const sections = ["choices", "import-options", "import-form", "address-preview", "mnemonic-accounts", "recovery-words", "backup-form", "history", "manual-form", "backup-export-form", "restore-form", "secret-export"];
  let messages = {}, active, positions = [], busy = false, invalid = false, ready = false, generation = 0, hasBackupChoices = false;
  const text = (key, fallback) => typeof messages[key] === "string" ? messages[key] : fallback;
  let statusMessage;
  const status = (key, fallback, suffix = "") => { statusMessage = { key, fallback, suffix }; byId("status").textContent = `${text(key, fallback)}${suffix ? ` ${suffix}` : ""}`; };
  const accountImport = window.createGeneralAccountImport({ byId, call, perform, text, show, status, connectExisting: connectExistingAccount,
    done: async () => { clearSecrets(); active = undefined; await refresh(); show("choices"); } });
  const history = window.createGeneralHistoryView({ call, perform: (action) => perform(action, "history"), text, show, status });
  const manual = window.createGeneralManualView({ call, perform: (action) => perform(action, "manual"), text, show, status });
  const backup = window.createGeneralBackupView({ call, perform, text, show, status, clearSetupSecrets: clearSecrets });
  const restore = window.createGeneralRestoreView({ call, perform, text, show, status, clearSetupSecrets: clearSecrets });
  let copyingMnemonic = false;
  let exportAccount, exportEpoch = 0, exportTimer, extendedManagement = false, localManagement = false, pendingPaymentSource, nativeAuthenticationPending = false;
  const controls = () => {
    for (const button of document.querySelectorAll("button")) button.disabled = invalid || busy;
    for (const select of document.querySelectorAll("select")) select.disabled = invalid || busy;
    byId("close").disabled = false;
    byId("copy-mnemonic").disabled = invalid || busy || copyingMnemonic || byId("recovery-words").hidden || byId("words").children.length !== 12;
    byId("secret").disabled = invalid || busy || byId("import-form").hidden;
    byId("cancel").hidden = !active;
    byId("back").hidden = Boolean(active) || byId("import-options").hidden;
    accountImport.controls(busy, invalid);
    manual.controls(busy, invalid);
    backup.controls(busy, invalid);
    restore.controls(busy, invalid);
    byId("secret-export-mnemonic").disabled = invalid || busy || exportAccount?.sourceType !== "mnemonic";
    byId("backup-tools").hidden = !extendedManagement || invalid || Boolean(active) || !hasBackupChoices || byId("choices").hidden;
    byId("restore-open").hidden = !extendedManagement;
  };
  function clearSecrets(preservePending = false) {
    clearTimeout(exportTimer); exportTimer = undefined;
    if (!preservePending) exportEpoch++;
    byId("secret-export-value").textContent = ""; byId("secret-export-value").hidden = true;
    byId("secret").value = "";
    byId("words").replaceChildren();
    byId("challenge").replaceChildren();
    positions = []; accountImport.clear();
  }
  function show(id) {
    if (id !== "history") history.clear();
    if (id !== "manual-form") manual.clear();
    if (id !== "backup-export-form") backup.clear();
    if (id !== "restore-form") restore.clear();
    for (const section of sections) byId(section).hidden = section !== id;
    if (!extendedManagement) {
      byId("accounts").hidden = id !== "choices" || !byId("account-list").children.length;
      byId("pending").hidden = id !== "choices" || !byId("pending-list").children.length;
    }
    controls();
    const focus = byId(id)?.querySelector("input,textarea,select,button");
    focus?.focus();
  }
  function invalidate() {
    if (invalid) return;
    invalid = true; generation++; clearSecrets(); history.clear(); manual.clear(); backup.clear(); restore.clear();
    byId("address").textContent = "";
    for (const section of sections) byId(section).hidden = true;
    status("locked", "Protected setup closed. Reopen it from the wallet.");
    controls();
  }
  async function call(command) {
    const current = generation;
    const reply = await bridge.invoke(command);
    if (invalid || current !== generation) throw new Error("GENERAL_OPERATION_CANCELED");
    if (!reply || reply.ok !== true) {
      const code = reply && typeof reply.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(reply.code)
        ? reply.code : "GENERAL_SETUP_UNAVAILABLE";
      throw new Error(code);
    }
    return reply.value;
  }
  async function perform(action, kind = "setup") {
    if (busy || invalid) return;
    busy = true; controls(); status("working", "Working securely…");
    try { await action(); }
    catch (error) {
      if (!ready) { invalidate(); return; }
      if (kind === "manual") { manual.fail(error); return; }
      if (kind === "backup") { backup.fail(error); return; }
      if (kind === "restore") { restore.fail(error); return; }
      if (kind === "secret_export") {
        clearSecrets();
        if (!exportAccount) { show("choices"); return; }
        show("secret-export"); status("secretExportTitle", "Export wallet");
        byId("secret-export-note").textContent = text(error?.message === "GENERAL_AUTH_REQUIRED" ? "secretExportDenied" : "secretExportFailed",
          "The secret was not revealed. Authenticate again to make a new request."); return;
      }
      if ((active?.mode === "import_mnemonic" || active?.mode === "import_private_key") && (!active.setupId || kind === "import_preview")) {
        clearSecrets(); show("import-form");
        const key = error?.message === "PROTECTED_STORAGE_AUTH_REQUIRED" ? "storageAuthorizationRequired"
          : error?.message === "PROTECTED_STORAGE_TIMEOUT" ? "storageTimeout" : "importFailed";
        status(key, "Import could not be completed. Existing wallets were retained. Re-enter the import material to retry.");
        if (key === "importFailed" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.message)) { statusMessage.suffix = error.message; byId("status").textContent += ` ${error.message}`; }
        return;
      }
      clearSecrets(); show("choices");
      try { if (!invalid) await refresh(); } catch { /* Preserve the original error when status is unavailable. */ }
      const code = error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "GENERAL_SETUP_UNAVAILABLE";
      status(kind === "history" ? "historyFailed" : "retained", "The operation could not be verified. Existing state was retained.", code);
    } finally {
      busy = false; controls();
      if (!invalid && document.hasFocus() && (document.activeElement === document.body || document.activeElement?.disabled || document.activeElement?.closest("[hidden]"))) {
        const visible = sections.find((id) => !byId(id).hidden);
        byId(visible)?.querySelector("input:not(:disabled),textarea:not(:disabled),select:not(:disabled),button:not(:disabled)")?.focus();
      }
    }
  }
  async function refresh() {
    const value = await call({ action: "status" });
    if (!value || !Array.isArray(value.accounts) || !Array.isArray(value.setups)) throw new Error("GENERAL_SETUP_UNAVAILABLE");
    hasBackupChoices = Boolean(value.accounts.length || value.setups.length);
    byId("account-list").replaceChildren();
    for (const account of value.accounts) {
      const item = document.createElement("li"), button = document.createElement("button"); item.className = "address";
      const title = document.createElement("strong"), address = document.createElement("code"), rename = document.createElement("button"), editor = document.createElement("form"), input = document.createElement("input"), save = document.createElement("button");
      if (!account.name) title.dataset.i18n = "account"; title.textContent = account.name || text("account", "Account"); address.textContent = account.address; item.append(title, address);
      rename.dataset.i18n = "renameAccount"; rename.type = "button"; rename.className = "secondary"; rename.textContent = text("renameAccount", "Rename");
      input.dataset.i18nAria = "walletName"; input.value = account.name || ""; input.maxLength = 80; input.setAttribute("aria-label", text("walletName", "Wallet name"));
      save.dataset.i18n = "saveName"; save.type = "submit"; save.textContent = text("saveName", "Save name"); editor.hidden = true; editor.append(input, save);
      rename.addEventListener("click", () => { editor.hidden = !editor.hidden; if (!editor.hidden) input.focus(); });
      editor.addEventListener("submit", event => { event.preventDefault(); void perform(async () => {
        await call({ action: "rename_account", sourceId: account.sourceId, name: input.value }); await refresh(); status("nameSaved", "Wallet name saved.");
      }); });
      item.append(rename, editor);
      button.dataset.i18n = "historyTitle"; button.textContent = text("historyTitle", "Manual transfer records"); button.className = "secondary"; button.dataset.sourceId = account.sourceId; button.id = `history-account-${account.sourceId}`;
      button.addEventListener("click", () => void perform(async () => { clearSecrets(); await history.open(account); }, "history")); if (extendedManagement) item.append(button);
      const send = document.createElement("button"); send.dataset.i18n = "manualTitle"; send.textContent = text("manualTitle", "Manual transfer"); send.className = "secondary"; send.id = `manual-account-${account.sourceId}`;
      send.addEventListener("click", () => void perform(async () => { clearSecrets(); await manual.open(account); }, "manual")); if (extendedManagement) item.append(send);
      const exportButton = document.createElement("button"); exportButton.className = "secondary";
      exportButton.dataset.i18n = "secretExportTitle"; exportButton.textContent = text("secretExportTitle", "Export wallet");
      exportButton.addEventListener("click", () => {
        if (busy || invalid) return;
        clearSecrets(); exportAccount = account; byId("secret-export-address").textContent = account.address;
        byId("secret-export-scope").textContent = text(account.sourceType === "mnemonic" ? "secretExportDerived" : "secretExportNoMnemonic",
          account.sourceType === "mnemonic" ? "The private key controls only this account." : "A private-key wallet has no recoverable mnemonic.");
        byId("secret-export-note").textContent = ""; show("secret-export");
      }); item.append(exportButton);
      if (localManagement) {
        const connect = document.createElement("button"); connect.className = "secondary";
        connect.dataset.i18n = "connectPayment"; connect.textContent = text("connectPayment", "Connect Agent payments");
        connect.addEventListener("click", () => void perform(() => connectPayment(account.sourceId))); item.append(connect);
      }
      byId("account-list").append(item);
    }
    byId("accounts").hidden = !value.accounts.length;
    byId("pending-list").replaceChildren();
    for (const setup of value.setups) {
      const item = document.createElement("li"), label = document.createElement("span"), button = document.createElement("button");
      label.dataset.setupMode = setup.mode; label.dataset.setupPhase = setup.phase;
      label.textContent = `${text(setup.mode === "create" ? "createMode" : setup.mode, setup.mode)} · ${text(setup.phase === "canceled" ? "phase_canceled" : setup.phase, setup.phase)}`;
      button.dataset.i18n = "continue"; button.textContent = text("continue", "Continue setup"); button.className = "secondary";
      button.addEventListener("click", () => void perform(() => continueSetup(setup)));
      item.append(label, button); byId("pending-list").append(item);
    }
    byId("pending").hidden = !value.setups.length;
    controls();
  }
  async function connectExistingAccount(address) {
    const setupId = active?.setupId;
    clearSecrets(); active = undefined;
    if (setupId) await call({ action: "cancel", setupId });
    const value = await call({ action: "status" });
    const account = value.accounts.find(item => item.address.toLowerCase() === address.toLowerCase());
    await refresh(); show("choices");
    if (!account) { status("accountNeedsRecovery", "This account has a pending setup. Continue it from the list below."); return; }
    await connectPayment(account.sourceId);
  }
  async function connectPayment(sourceId) {
    clearSecrets();
    const result = await call({ action: "connect_payment", sourceId });
    if (result.status === "needs_upgrade") {
      pendingPaymentSource = sourceId; byId("payment-upgrade").showModal();
    } else { pendingPaymentSource = undefined; status("paymentConnected", "Connected. Select this wallet and configure its payment limits before paying."); }
  }
  byId("payment-upgrade-cancel").addEventListener("click", () => { pendingPaymentSource = undefined; byId("payment-upgrade").close(); });
  byId("payment-upgrade-confirm").addEventListener("click", () => {
    if (!pendingPaymentSource || busy || invalid) return;
    const sourceId = pendingPaymentSource; pendingPaymentSource = undefined; byId("payment-upgrade").close();
    void perform(async () => { await call({ action: "upgrade_payments" }); await connectPayment(sourceId); });
  });
  async function revealCreated() {
    const epoch = exportEpoch, setupId = active.setupId;
    const result = await call({ action: "reveal_created", setupId: active.setupId });
    if (epoch !== exportEpoch || active?.setupId !== setupId || document.visibilityState !== "visible" || !document.hasFocus()) throw new Error("GENERAL_OPERATION_CANCELED");
    if (!result || typeof result.phrase !== "string" || result.phrase.split(" ").length !== 12 ||
        !Array.isArray(result.positions) || result.positions.length !== 3) throw new Error("GENERAL_SETUP_UNAVAILABLE");
    clearSecrets(); positions = result.positions;
    for (const word of result.phrase.split(" ")) { const item = document.createElement("li"); item.textContent = word; byId("words").append(item); }
    show("recovery-words"); status("backupWarning", "Write all 12 words in order. Keep them private.");
  }
  async function continueSetup(setup) {
    clearSecrets(); active = { setupId: setup.setupId, mode: setup.mode };
    if (setup.phase === "canceled") await call({ action: "resume", setupId: active.setupId });
    if (setup.mode === "create") {
      if (setup.phase === "started") await call({ action: "stage_create", setupId: active.setupId });
      await revealCreated();
    } else if (["secret_staged", "canceled"].includes(setup.phase)) {
      await call({ action: "confirm_import", setupId: active.setupId });
      active = undefined; await refresh(); show("choices"); status("imported", "Account imported.");
    } else { show("import-form"); status("reenter", "Re-enter the original import material to continue this setup."); }
  }
  byId("import").addEventListener("click", () => { if (!busy && !invalid) { show("import-options"); status("chooseImport", "Choose how to import the existing wallet."); } });
  byId("back").addEventListener("click", () => void perform(async () => { await refresh(); show("choices"); }));
  byId("create").addEventListener("click", () => void perform(async () => {
    clearSecrets();
    const result = await call({ action: "begin", mode: "create" });
    active = { setupId: result.setupId, mode: "create" };
    await call({ action: "stage_create", setupId: active.setupId }); await revealCreated();
  }));
  for (const [id, mode] of [["import-mnemonic", "import_mnemonic"], ["import-key", "import_private_key"]])
    byId(id).addEventListener("click", () => void perform(async () => {
      clearSecrets(); active = { mode }; show("import-form"); status("seedWarning", "Only import through this protected window.");
    }));
  byId("import-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void perform(async () => {
      const mnemonic = active.mode === "import_mnemonic";
      if (!active.setupId) {
        const started = await call({ action: "begin", mode: active.mode }); active.setupId = started.setupId;
      }
      if (mnemonic) { await accountImport.start(active.setupId); return; }
      const result = await call({ action: mnemonic ? "preview_mnemonic" : "preview_private_key", setupId: active.setupId,
        ...(mnemonic ? { phrase: byId("secret").value } : { privateKey: byId("secret").value }) });
      byId("address").textContent = result.address; show("address-preview"); status("verifyAddress", "Verify the account address.");
    }, "import_preview");
  });
  byId("confirm-address").addEventListener("click", () => void perform(async () => {
    const mnemonic = active.mode === "import_mnemonic";
    const result = await call({ action: mnemonic ? "stage_mnemonic" : "stage_private_key", setupId: active.setupId,
      ...(mnemonic ? { phrase: byId("secret").value } : { privateKey: byId("secret").value }), confirmedAddress: byId("address").textContent });
    clearSecrets();
    if (result.status === "staged") await call({ action: "confirm_import", setupId: active.setupId });
    active = undefined; await refresh(); show("choices");
    status(result.status === "staged" ? "imported" : "existing", result.status === "staged" ? "Account imported." : "This account already exists or requires recovery. Its history was retained.");
  }));
  byId("copy-mnemonic").addEventListener("click", async (event) => {
    if (!event.isTrusted || invalid || busy || copyingMnemonic || byId("recovery-words").hidden || !document.hasFocus()) return;
    const words = [...byId("words").children].map((node) => node.textContent);
    if (words.length !== 12 || typeof bridge.copyMnemonic !== "function") return;
    const epoch = exportEpoch; copyingMnemonic = true; controls();
    try {
      const result = await bridge.copyMnemonic(words.join(" "));
      if (!invalid && epoch === exportEpoch && !byId("recovery-words").hidden)
        status(result?.ok === true ? "mnemonicCopied" : "mnemonicCopyFailed", result?.ok === true ? "Copied." : "Copy failed. Try again.");
    } catch {
      if (!invalid && epoch === exportEpoch && !byId("recovery-words").hidden) status("mnemonicCopyFailed", "Copy failed. Try again.");
    } finally { words.fill(""); copyingMnemonic = false; controls(); }
  });
  byId("begin-challenge").addEventListener("click", () => {
    const selected = [...positions]; clearSecrets(); positions = selected;
    for (const position of selected) {
      const label = document.createElement("label"), input = document.createElement("input");
      label.dataset.wordPosition = String(position + 1); label.textContent = `${text("word", "Word")} ${position + 1}`;
      input.autocomplete = "off"; input.spellcheck = false; input.maxLength = 64; input.dataset.position = String(position);
      label.append(input); byId("challenge").append(label);
    }
    show("backup-form"); status("challengeTitle", "Confirm your backup.");
  });
  byId("backup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void perform(async () => {
      const inputs = [...byId("challenge").querySelectorAll("input")];
      const result = await call({ action: "confirm_backup", setupId: active.setupId, words: inputs.map((input) => input.value) });
      for (const input of inputs) input.value = "";
      if (result.verified !== true) { status("backupIncorrect", "The words did not match. Check your backup and try again."); return; }
      clearSecrets(); active = undefined; await refresh(); show("choices"); status("created", "Wallet created and backup confirmed.");
    });
  });
  byId("cancel").addEventListener("click", () => void perform(async () => {
    clearSecrets();
    if (!active.setupId) { active = undefined; show("import-options"); status("chooseImport", "Choose how to import the existing wallet."); return; }
    await call({ action: "cancel", setupId: active.setupId }); active = undefined;
    await refresh(); show("choices"); status("canceled", "Setup canceled. Staged recovery material was retained.");
  }));
  byId("close").addEventListener("click", () => { invalidate(); bridge?.close(); });
  for (const [id, format] of [["secret-export-mnemonic", "mnemonic"], ["secret-export-key", "private_key"]]) {
    byId(id).addEventListener("click", () => void perform(async () => {
      clearSecrets(); const epoch = exportEpoch, account = exportAccount;
      if (!account || format === "mnemonic" && account.sourceType !== "mnemonic") return;
      const result = await call({ action: "export_secret", sourceId: account.sourceId, format });
      if (epoch !== exportEpoch || account !== exportAccount || document.visibilityState !== "visible" || !document.hasFocus()) return;
      if (result?.format !== format) throw new Error("GENERAL_SETUP_REPLY_INVALID");
      byId("secret-export-value").textContent = format === "mnemonic" ? result.phrase : result.privateKey;
      byId("secret-export-value").hidden = false;
      exportTimer = setTimeout(clearSecrets, 60000);
      byId("secret-export-note").textContent = text("secretExportVisible", "Sensitive content clears when this window loses focus. Revealing again requires authentication.");
    }, "secret_export"));
  }
  byId("secret-export-back").addEventListener("click", () => { if (!busy && !invalid) { clearSecrets(); exportAccount = undefined; show("choices"); } });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || byId("secret-export").hidden) return;
    event.preventDefault(); clearSecrets(); exportAccount = undefined;
    void call({ action: "cancel_secret_export" }).catch(() => {}); show("choices");
  });
  function clearVisibleSecrets() {
    const ownAuthentication = nativeAuthenticationPending && document.visibilityState === "visible";
    if (!ownAuthentication && !byId("secret-export").hidden) void call({ action: "cancel_secret_export" }).catch(() => {});
    const wasHistory = !byId("history").hidden;
    const wasSensitive = ["import-form", "address-preview", "mnemonic-accounts", "recovery-words", "backup-form"].some((id) => !byId(id).hidden);
    history.clear();
    backup.clearPasswords();
    restore.clearPassword();
    if (wasHistory) { show("choices"); status("historyCleared", "Transfer record details were cleared."); }
    clearSecrets(ownAuthentication);
    if (wasSensitive && !busy && !invalid && active && !active.setupId) {
      show("import-form"); status("secretCleared", "Sensitive content was cleared. Re-enter the import material."); return;
    }
    if (wasSensitive && !busy && !invalid) void perform(async () => {
      await refresh(); show("choices"); status("secretCleared", "Sensitive content was cleared. Continue the original setup to resume.");
    });
  }
  window.addEventListener("blur", clearVisibleSecrets);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible") clearVisibleSecrets(); });
  window.addEventListener("beforeunload", () => { clearSecrets(); history.clear(); manual.clear(); backup.clear(); restore.clear(); });
  let presentationGeneration = 0;
  const disposeLocale = bridge?.onLocaleChanged?.(() => {
    const current = ++presentationGeneration;
    void bridge.invoke({ action: "presentation" }).then(reply => {
      if (current !== presentationGeneration || invalid || !reply.ok) return;
      const previous = messages; messages = reply.value.messages; document.documentElement.lang = reply.value.locale;
      for (const id of ["status", "secret-export-note", "secret-export-scope"]) {
        const node = byId(id), key = Object.keys(previous).find(key => previous[key] === node.textContent);
        if (key) node.textContent = text(key, node.textContent);
      }
      for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = text(node.dataset.i18n, node.textContent);
      for (const node of document.querySelectorAll("[data-i18n-aria]")) node.setAttribute("aria-label", text(node.dataset.i18nAria, node.getAttribute("aria-label")));
      accountImport.localize(); controls();
      if (statusMessage) status(statusMessage.key, statusMessage.fallback, statusMessage.suffix);
      for (const node of document.querySelectorAll("[data-word-position]")) if (node.firstChild) node.firstChild.nodeValue = `${text("word", "Word")} ${node.dataset.wordPosition}`;
      for (const node of document.querySelectorAll("[data-setup-mode]")) node.textContent = `${text(node.dataset.setupMode === "create" ? "createMode" : node.dataset.setupMode, node.dataset.setupMode)} · ${text(node.dataset.setupPhase === "canceled" ? "phase_canceled" : node.dataset.setupPhase, node.dataset.setupPhase)}`;
    }).catch(() => {});
  });
  window.addEventListener("beforeunload", () => { presentationGeneration++; disposeLocale?.(); });
  bridge?.onInvalidated(invalidate);
  bridge?.onRestorePassword?.(restore.passwordRequested);
  bridge?.onAuthenticationPhase?.((pending) => { nativeAuthenticationPending = pending === true; });
  if (!bridge || typeof bridge.onReady !== "function") { invalidate(); return; }
  bridge.onReady(() => void perform(async () => {
    const presentation = presentationGeneration;
    const bootstrap = await call({ action: "bootstrap" });
    if (presentation === presentationGeneration) { messages = bootstrap.messages; document.documentElement.lang = bootstrap.locale; }
    extendedManagement = bootstrap.extendedManagement === true; localManagement = bootstrap.localManagement === true;
    document.documentElement.dataset.management = extendedManagement ? "extended" : "basic";
    for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = text(node.dataset.i18n, node.textContent);
    ready = true;
    if (bootstrap.initialView !== "import") await refresh();
    show(bootstrap.initialView === "import" ? "import-options" : "choices"); status("ready", "Choose how to add an account.");
    if (bootstrap.initialView === "export") byId("accounts").scrollIntoView({ block: "nearest" });
  }));
})();
