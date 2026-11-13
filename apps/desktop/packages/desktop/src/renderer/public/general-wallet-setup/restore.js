(() => {
  window.createGeneralRestoreView = ({ call, perform, text, show, status, clearSetupSecrets }) => {
    const byId = (id) => document.getElementById(id);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    let requestId, activeRequest, stage, challenge, preview, generation = 0, busy = false, invalid = false;
    let running = false, canceling = false, submitting = false, locked = false, complete = false, composing = false;
    const note = (key, fallback) => { byId("restore-note").textContent = text(key, fallback); };
    const clearPassword = () => { byId("restore-password").value = ""; };
    const controls = (working = busy, ended = invalid) => {
      busy = working; invalid = ended;
      byId("restore-prepare").disabled = invalid || busy || running || locked || !requestId || Boolean(preview);
      byId("restore-publish").disabled = invalid || busy || running || locked || !preview || !requestId;
      byId("restore-publish").hidden = !preview;
      byId("restore-cancel").disabled = invalid || !running || !activeRequest || canceling;
      byId("restore-back").disabled = invalid || busy || running || complete;
      const waiting = Boolean(running && challenge && !submitting && !canceling && !invalid);
      byId("restore-password").disabled = !waiting;
      byId("restore-password-submit").disabled = !waiting;
      byId("restore-password-form").hidden = !challenge || invalid || canceling;
    };
    const clear = () => {
      generation++; requestId = undefined; activeRequest = undefined; stage = undefined; challenge = undefined; preview = undefined;
      locked = false; complete = false; composing = false; clearPassword();
      byId("restore-accounts").replaceChildren();
      for (const id of ["restore-summary", "restore-result", "restore-note"]) byId(id).textContent = "";
      controls();
    };
    const fail = (error) => {
      clearPassword(); challenge = undefined; requestId = undefined; locked = true;
      const code = error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "GENERAL_RECOVERY_STORE_UNAVAILABLE";
      const key = code === "GENERAL_RECOVERY_WRITE_UNCERTAIN" ? "restoreUncertain" : code === "GENERAL_BACKUP_INVALID" ? "restoreInvalid" :
        ["GENERAL_OPERATION_CANCELED", "GENERAL_RECOVERY_OPERATION_CANCELED", "GENERAL_AUTH_REJECTED", "GENERAL_AUTH_TIMEOUT"].includes(code) ? "restoreCanceled" : "restoreUnavailable";
      note(key, "The restore could not be verified. Inspect the original operation before continuing."); status(key, "Restore requires inspection."); controls();
    };
    const open = async () => {
      clear(); clearSetupSecrets(); const current = generation; show("restore-form");
      const value = await call({ action: "restore_options" }); if (current !== generation) return;
      requestId = value.requestId; locked = !value.available;
      note(value.available ? "restoreNotice" : "restoreUnavailable", "Select one encrypted wallet backup in the protected file dialog."); controls();
    };
    const passwordRequested = (value) => {
      if (invalid || !running || canceling || challenge || !value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join() !== "challengeId,requestId,stage" || value.requestId !== activeRequest || value.stage !== stage || !uuid.test(value.challengeId)) return;
      challenge = { requestId: value.requestId, challengeId: value.challengeId }; clearPassword(); controls();
      note("restorePasswordReady", "System authentication completed for this step. Enter the backup password.");
      if (document.hasFocus()) byId("restore-password").focus();
    };
    const run = (nextStage) => {
      if (busy || invalid || running || locked || !requestId || (nextStage === "prepare" ? Boolean(preview) : !preview)) return;
      const current = generation, original = requestId; activeRequest = original; stage = nextStage; running = true; canceling = false; challenge = undefined;
      clearPassword(); controls();
      void perform(async () => {
        note(nextStage === "prepare" ? "restorePreparing" : "restorePublishing", "Complete the original protected restore step. No automatic retry will occur.");
        const value = await call({ action: nextStage === "prepare" ? "restore_prepare" : "restore_publish", requestId: original });
        if (current !== generation) return;
        if (nextStage === "prepare") {
          if (value.requestId !== original) throw new Error("GENERAL_SETUP_REPLY_INVALID");
          preview = value;
          byId("restore-summary").textContent = `${text(value.mode === "new_installation" ? "restoreNewInstallation" : "restoreSameInstallation", value.mode)} · ${text("restoreSelected", "Selected keys: {count}").replace("{count}", String(value.selectedKeyCount))}`;
          byId("restore-accounts").replaceChildren(...value.accounts.map((account) => {
            const li = document.createElement("li"); li.textContent = `${account.address} · ${text(account.sourceType === "mnemonic" ? "exportMnemonic" : "exportPrivateKey", account.sourceType)} · ${text(account.status === "ready" ? "exportReady" : "exportStaged", account.status)} · ${text(account.materialSelected ? "restoreMaterialSelected" : "restoreMaterialNotSelected", account.materialSelected ? "Selected material" : "Material not selected")}`; return li;
          }));
          note(value.signingContinuity === "unknown" ? "restoreUnknown" : "restoreContinuity", "Review the exact restore scope before explicitly confirming.");
          status("restoreReview", "Review the restore preview. Nothing has been published by this preview.");
        } else {
          complete = true; locked = true; requestId = undefined;
          byId("restore-result").textContent = value.recoveryId;
          byId("accounts").hidden = true; byId("pending").hidden = true;
          note(value.signingMode === "archive_only" ? "restoreCompleteReadOnly" : "restoreComplete", "The original restore target reopened. Reopen wallet management to inspect it.");
          status("restoreFinished", "Restore target reopened. Close this management window.");
        }
      }, "restore").finally(() => {
        clearPassword(); challenge = undefined; activeRequest = undefined; stage = undefined; running = false; canceling = false; controls();
      });
    };
    byId("restore-open").addEventListener("click", () => void perform(open, "restore"));
    byId("restore-prepare").addEventListener("click", () => run("prepare"));
    byId("restore-publish").addEventListener("click", () => run("publish"));
    byId("restore-password-form").addEventListener("compositionstart", () => { composing = true; });
    byId("restore-password-form").addEventListener("compositionend", () => { composing = false; });
    byId("restore-password-form").addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.isComposing || composing)) event.preventDefault(); });
    byId("restore-password-form").addEventListener("submit", (event) => {
      event.preventDefault(); if (composing || invalid || !running || !challenge || submitting || canceling) return;
      let password = byId("restore-password").value; clearPassword();
      let normalized = password.normalize("NFKC"); const bytes = new TextEncoder().encode(normalized);
      const valid = normalized.isWellFormed() && Array.from(normalized).length >= 16 && bytes.byteLength <= 256;
      bytes.fill(0); normalized = "";
      if (!valid) { password = ""; note("exportPasswordInvalid", "Use at least 16 characters and at most 256 UTF-8 bytes."); byId("restore-password").focus(); return; }
      const original = challenge, current = generation; submitting = true; controls();
      void call({ action: "restore_password", ...original, password }).then(() => {
        if (current === generation && challenge === original) { challenge = undefined; note("restoreChecking", "Verifying the original encrypted backup."); }
      }, () => { if (current === generation) note("restorePasswordRejected", "The original password challenge could not be verified. Cancel or inspect the original operation."); })
        .finally(() => { password = ""; clearPassword(); submitting = false; controls(); });
    });
    byId("restore-cancel").addEventListener("click", () => {
      if (invalid || !running || !activeRequest || canceling) return;
      const original = activeRequest, current = generation; canceling = true; challenge = undefined; clearPassword(); controls();
      const waiting = () => { if (current === generation && running) note("restoreCanceling", "Waiting for the original restore task to drain. Existing effects are retained."); };
      void call({ action: "restore_cancel", requestId: original }).then(waiting, waiting);
    });
    byId("restore-back").addEventListener("click", () => { if (busy || invalid || running || complete) return; clear(); show("choices"); status("ready", "Choose an account operation."); });
    return { controls, clear, clearPassword, fail, passwordRequested };
  };
})();
