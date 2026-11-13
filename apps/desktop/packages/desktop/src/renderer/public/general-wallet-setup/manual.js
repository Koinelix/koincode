(() => {
  window.createGeneralManualView = ({ call, perform, text, show, status }) => {
    const byId = (id) => document.getElementById(id);
    let account, requestId, options, generation = 0, sending = false, canceling = false, locked = false, busy = false, invalid = false;
    const network = () => options?.networks.find((item) => item.networkId === byId("manual-network").value);
    const note = (key, fallback) => { byId("manual-note").textContent = text(key, fallback); };
    const controls = (working = busy, ended = invalid) => {
      busy = working; invalid = ended;
      for (const id of ["manual-network", "manual-asset", "manual-recipient", "manual-amount"]) byId(id).disabled = busy || invalid || locked || !options?.available;
      byId("manual-send").disabled = busy || invalid || locked || !options?.available || !account || Boolean(network()?.reason);
      byId("manual-cancel").disabled = invalid || !sending || !activeRequest || canceling;
      byId("manual-back").disabled = busy || invalid || sending;
    };
    const clear = () => {
      generation++; account = undefined; requestId = undefined; activeRequest = undefined; options = undefined; locked = false;
      byId("manual-address").textContent = ""; byId("manual-result").textContent = ""; byId("manual-note").textContent = "";
      byId("manual-network").replaceChildren(); byId("manual-asset").replaceChildren();
      byId("manual-recipient").value = ""; byId("manual-amount").value = ""; controls();
    };
    const assets = () => {
      const selected = network(); byId("manual-asset").replaceChildren(...(selected?.assets ?? []).map((asset) => {
        const option = document.createElement("option"); option.value = asset.assetId;
        option.textContent = `${asset.symbol} · ${asset.assetId === "native" ? text("manualNative", "Native asset") : asset.assetId.slice(6)} · ${asset.decimals} ${text("manualPrecision", "decimals")}`;
        return option;
      }));
      note(selected?.reason === "legacy_network_reserved" ? "manualReserved" : selected?.reason ? "manualFeeUnavailable" : "manualNotice",
        "A separate confirmation and system authentication are required. Skill budgets do not apply.");
      byId("manual-amount").value = ""; byId("manual-result").textContent = ""; controls();
    };
    const fail = (error) => {
      const code = error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "GENERAL_SETUP_UNAVAILABLE";
      requestId = undefined;
      const key = ["INVALID_REQUEST", "INVALID_ADDRESS", "INVALID_AMOUNT", "INVALID_ASSET"].includes(code) ? "manualInvalidInput" :
        ["INSUFFICIENT_FUNDS", "INSUFFICIENT_GAS_FUNDS"].includes(code) ? "manualInsufficient" :
        ["GENERAL_APPROVAL_DECLINED", "GENERAL_AUTH_REQUIRED", "GENERAL_OPERATION_CANCELED"].includes(code) ? "manualDeclined" :
        ["GENERAL_FEE_UNAVAILABLE", "GENERAL_FEE_CHANGED", "GENERAL_FUNDS_UNAVAILABLE"].includes(code) ? "manualReadFailed" :
        ["GENERAL_ACCOUNT_UNAVAILABLE", "GENERAL_CONFIGURATION_CHANGED"].includes(code) ? "manualChanged" :
        ["SECRET_ADMISSION_UNAVAILABLE", "GENERAL_DRAFT_UNAVAILABLE", "GENERAL_FEE_CAP_UNAVAILABLE", "LEGACY_NETWORK_RESERVED"].includes(code) ? "manualUnavailable" : "manualUnknown";
      locked = ["manualUnknown", "manualChanged", "manualUnavailable"].includes(key);
      note(key, "Review the original operation before another transfer.");
      byId("manual-result").textContent = ""; status(key, "Check the original operation."); controls();
    };
    byId("manual-network").addEventListener("change", assets);
    byId("manual-asset").addEventListener("change", () => { byId("manual-amount").value = ""; byId("manual-result").textContent = ""; });
    byId("manual-form").addEventListener("keydown", (event) => { if (event.key === "Enter" && event.isComposing) event.preventDefault(); });
    byId("manual-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (sending || busy || invalid || locked || !options?.available || !account || network()?.reason) return;
      const current = generation, input = { accountId: account.sourceId, networkId: byId("manual-network").value,
        assetId: byId("manual-asset").value, recipient: byId("manual-recipient").value, amount: byId("manual-amount").value };
      sending = true; canceling = false; controls();
      void perform(async () => {
        if (!requestId) {
          const refreshed = await call({ action: "manual_options" });
          if (current !== generation || !refreshed.available || JSON.stringify(refreshed.networks) !== JSON.stringify(options.networks)) throw new Error("GENERAL_CONFIGURATION_CHANGED");
          requestId = refreshed.requestId;
        }
        const original = requestId; requestId = undefined; activeRequest = original; controls();
        note("manualWorking", "Checking balances and fees. Complete the separate confirmation when it opens.");
        const result = await call({ action: "manual_send", requestId: original, input });
        if (current !== generation) return;
        locked = true; byId("manual-result").textContent = result.transactionHash;
        note(result.status === "UNKNOWN" ? "manualUnknown" : "manualSubmitted", "Submitted or uncertain transactions require checking the original records.");
        status(result.status === "UNKNOWN" ? "manualUnknown" : "manualSubmitted", "Check the original transaction.");
      }).finally(() => { activeRequest = undefined; sending = false; canceling = false; controls(); });
    });
    let activeRequest;
    byId("manual-cancel").addEventListener("click", () => {
      if (!sending || canceling || !activeRequest || invalid) return;
      canceling = true; controls(); const current = generation;
      const waiting = () => { if (current === generation && !invalid && sending) note("manualCanceling", "Waiting for the original operation to stop safely."); };
      void call({ action: "manual_cancel", requestId: activeRequest }).then(waiting, waiting);
    });
    byId("manual-back").addEventListener("click", () => { if (sending || busy) return; clear(); show("choices"); status("ready", "Choose an account operation."); });
    return { clear, controls, fail, async open(selected) {
      clear(); const current = generation; account = { sourceId: selected.sourceId, address: selected.address };
      byId("manual-address").textContent = account.address; show("manual-form");
      const value = await call({ action: "manual_options" }); if (current !== generation) return;
      options = value; requestId = value.requestId;
      byId("manual-network").replaceChildren(...value.networks.map((item) => {
        const option = document.createElement("option"); option.value = item.networkId;
        option.textContent = text(`historyNetwork_${item.networkId.slice(7)}`, `${item.networkId} · ${text(item.testnet ? "manualTestnet" : "manualMainnet", item.testnet ? "Test network" : "Main network")}`);
        return option;
      }));
      if (value.networks.some((item) => item.networkId === "eip155:421614")) byId("manual-network").value = "eip155:421614";
      assets(); if (!value.available) note("manualUnavailable", "Manual transfer is unavailable in this protected host.");
      status(value.available ? "manualNotice" : "manualUnavailable", "Check the protected transfer options."); controls();
    } };
  };
})();
