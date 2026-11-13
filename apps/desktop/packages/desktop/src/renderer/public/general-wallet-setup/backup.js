(() => {
  window.createGeneralBackupView = ({ call, perform, text, show, status, clearSetupSecrets }) => {
    const byId = (id) => document.getElementById(id);
    let options, requestId, activeRequest, generation = 0, running = false, canceling = false, locked = false, busy = false, invalid = false;
    const items = [];
    const note = (key, fallback) => { byId("export-note").textContent = text(key, fallback); };
    const clearPasswords = () => { byId("export-password").value = ""; byId("export-confirm").value = ""; };
    const controls = (working = busy, ended = invalid) => {
      busy = working; invalid = ended;
      const unavailable = busy || invalid || locked || running || !options?.available;
      for (const input of byId("backup-export-form").querySelectorAll("input")) input.disabled = unavailable;
      byId("export-submit").disabled = unavailable || !requestId || !items.some((item) => item.input.checked);
      byId("export-cancel").disabled = invalid || !running || !activeRequest || canceling;
      byId("export-back").disabled = busy || invalid || running;
    };
    const summary = () => {
      const selected = items.filter((item) => item.input.checked).length;
      byId("export-coverage").textContent = text("exportCoverage", "Selected keys: {count}. All known history is included.").replace("{count}", String(selected));
      const omitted = items.filter((item) => !item.input.checked);
      byId("export-omitted").replaceChildren(...omitted.map((item) => { const li = document.createElement("li"); li.textContent = item.label; return li; }));
      byId("export-omitted-section").hidden = omitted.length === 0;
      controls();
    };
    const clear = () => {
      generation++; options = undefined; requestId = undefined; activeRequest = undefined; locked = false;
      clearPasswords(); items.length = 0;
      for (const id of ["export-sources", "export-pending", "export-omitted"]) byId(id).replaceChildren();
      byId("export-coverage").textContent = ""; byId("export-result").textContent = ""; byId("export-note").textContent = "";
      byId("export-omitted-section").hidden = true; controls();
    };
    const fail = (error) => {
      clearPasswords(); requestId = undefined; locked = true;
      const code = error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "GENERAL_BACKUP_UNAVAILABLE";
      const key = code === "GENERAL_BACKUP_EXPORT_UNCERTAIN" ? "exportUnknown" : code === "GENERAL_BACKUP_HISTORY_CHANGED" ? "exportChanged" :
        ["GENERAL_OPERATION_CANCELED", "GENERAL_AUTH_REQUIRED"].includes(code) ? "exportCanceled" :
        code === "GENERAL_BACKUP_INVALID" ? "exportInvalid" : code === "GENERAL_OPERATION_BUSY" ? "exportBusy" : "exportUnavailable";
      note(key, "The backup could not be verified. No automatic export or overwrite will be attempted.");
      status(key, "Check the original backup operation."); controls();
    };
    const append = (kind, value) => {
      const li = document.createElement("li"), label = document.createElement("label"), input = document.createElement("input"), description = document.createElement("span");
      const itemId = kind === "source" ? value.sourceId : value.setupId;
      input.type = "checkbox"; input.checked = true; input.id = `export-${kind}-${itemId}`; input.dataset.kind = kind; input.dataset.itemId = itemId;
      label.className = "export-choice";
      const words = kind === "source" ? `${value.address} · ${text(value.sourceType === "mnemonic" ? "exportMnemonic" : "exportPrivateKey", value.sourceType)} · ${text(value.status === "ready" ? "exportReady" : "exportStaged", value.status)}` :
        `${text(value.mode === "create" ? "createMode" : value.mode, value.mode)} · ${text(value.phase === "canceled" ? "phase_canceled" : value.phase, value.phase)} · ${itemId}`;
      description.textContent = words; label.append(input, description); li.append(label);
      byId(kind === "source" ? "export-sources" : "export-pending").append(li); items.push({ input, label: words });
      input.addEventListener("change", () => {
        if (busy || invalid || locked || running || !requestId) return;
        clearPasswords(); const current = generation, original = requestId, selected = input.checked;
        void perform(async () => { await call({ action: "backup_select", requestId: original, kind, itemId, selected });
          if (current === generation) summary(); }, "backup");
      });
    };
    const open = async () => {
      clear(); clearSetupSecrets(); const current = generation; show("backup-export-form");
      const value = await call({ action: "backup_options" }); if (current !== generation) return;
      options = value; requestId = value.requestId;
      for (const source of value.sources) append("source", source);
      for (const setup of value.pendingSetups) append("pending", setup);
      summary();
      const key = !value.available ? "exportUnavailable" : items.length ? "exportNotice" : "exportEmpty";
      note(key, "Select the material to include in this encrypted backup."); status(key, "Check backup coverage."); controls();
    };
    byId("backup-open").addEventListener("click", () => void perform(open, "backup"));
    byId("backup-export-form").addEventListener("keydown", (event) => { if (event.key === "Enter" && event.isComposing) event.preventDefault(); });
    byId("backup-export-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy || invalid || locked || running || !options?.available || !requestId || !items.some((item) => item.input.checked)) return;
      let password = byId("export-password").value;
      let confirmation = byId("export-confirm").value; clearPasswords();
      let normalized = password.normalize("NFKC"); const bytes = new TextEncoder().encode(normalized);
      const valid = Array.from(normalized).length >= 16 && bytes.byteLength <= 256 && normalized === confirmation.normalize("NFKC") && normalized.isWellFormed();
      bytes.fill(0); confirmation = ""; normalized = "";
      if (!valid) {
        password = ""; note("exportPasswordInvalid", "Enter matching passwords with at least 16 characters and at most 256 UTF-8 bytes.");
        byId("export-password").focus(); return;
      }
      const current = generation, original = requestId; requestId = undefined; activeRequest = original; running = true; canceling = false; controls();
      void perform(async () => {
        try {
          note("exportWorking", "Complete system authentication and choose a new backup file. Existing files will not be overwritten.");
          const value = await call({ action: "backup_export", requestId: original, password });
          if (current !== generation) return;
          locked = true; byId("export-result").textContent = value.backupId;
          note(value.allReferencedKeys ? "exportComplete" : "exportPartial", "Encrypted backup saved with the selected coverage.");
          status(value.allReferencedKeys ? "exportComplete" : "exportPartial", "Check the saved backup coverage.");
        } finally { password = ""; clearPasswords(); }
      }, "backup").finally(() => { activeRequest = undefined; running = false; canceling = false; controls(); });
    });
    byId("export-cancel").addEventListener("click", () => {
      if (!running || canceling || invalid || !activeRequest) return;
      canceling = true; clearPasswords(); controls(); const current = generation;
      const waiting = () => { if (current === generation && !invalid && running) note("exportCanceling", "Waiting for the original backup operation to drain."); };
      void call({ action: "backup_cancel", requestId: activeRequest }).then(waiting, waiting);
    });
    byId("export-back").addEventListener("click", () => { if (busy || running || invalid) return; clear(); show("choices"); status("ready", "Choose an account operation."); });
    return { clear, clearPasswords, controls, fail };
  };
})();
