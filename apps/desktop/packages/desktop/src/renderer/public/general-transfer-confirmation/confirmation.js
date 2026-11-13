(() => {
  "use strict";
  const control = window.transferConfirmationControl, element = (id) => document.getElementById(id);
  let scope, messages = {}, timer, decided = false, deadline = 0;
  const set = (id, value) => { element(id).textContent = String(value); };
  function clear() {
    scope = undefined; decided = true; if (timer) clearInterval(timer);
    element("accept").disabled = true; element("details").hidden = true;
    for (const id of ["account", "recipient", "amount", "amount-atomic", "asset", "contract", "max-fee", "fee-atomic", "native-exposure", "gas-limit", "gas-price", "priority-fee", "nonce", "gas-estimate", "estimated-fee", "quote-block", "quote-hash", "estimate-block", "estimate-hash", "digest", "countdown"])
      set(id, "");
  }
  function decide(accept) {
    if (!scope || decided || (accept && performance.now() >= deadline)) return;
    decided = true; element("accept").disabled = true; element("cancel").disabled = true;
    void control.invoke({ action: "decide", ...scope, accept }).catch(() => {}).finally(clear);
  }
  element("accept").addEventListener("click", () => decide(true));
  element("cancel").addEventListener("click", () => decide(false));
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); decide(false); } });
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clear(); });
  if (!control) { clear(); return; }
  control.onInvalidated(clear);
  control.onReady(async () => {
    try {
      const response = await control.invoke({ action: "bootstrap" });
      if (!response?.ok || decided) { clear(); return; }
      const { locale, view, requestId, remainingMs } = response.value;
      messages = response.value.messages; document.documentElement.lang = locale;
      document.querySelectorAll("[data-i18n]").forEach((item) => { item.textContent = messages[item.dataset.i18n]; });
      scope = { requestId, digest: view.digest }; deadline = performance.now() + remainingMs;
      set("network-name", `${messages[`network${view.chainId}`]} · ${view.networkId}`);
      set("environment", messages[view.testnet ? "testnet" : "mainnet"]); element("environment").classList.toggle("mainnet", !view.testnet);
      set("account", view.accountAddress); set("recipient", view.recipient); set("amount", view.amount);
      set("asset", view.assetKind === "native" ? view.nativeSymbol : `${messages.token} · ${messages.precision}: ${view.decimals}`);
      set("amount-atomic", view.amountAtomic); set("contract", view.contract ?? ""); element("contract-row").hidden = view.contract === null;
      set("max-fee", `${view.maxFee} ${view.nativeSymbol}`); set("fee-atomic", view.maxFeeAtomic);
      set("native-exposure", `${view.nativeExposure} ${view.nativeSymbol}`); set("gas-limit", view.gasLimit); set("gas-price", view.gasPrice);
      set("priority-fee", view.priorityFee ?? ""); element("priority-row").hidden = view.priorityFee === null;
      set("fee-type", view.feeType); set("nonce", view.nonce); set("gas-estimate", view.gasUnits);
      set("estimated-fee", `${view.estimatedFee} ${view.nativeSymbol}`); set("quote-block", view.quoteBlock); set("quote-hash", view.quoteHash);
      set("estimate-block", view.estimateBlock); set("estimate-hash", view.estimateHash); set("digest", view.digest);
      set("status", ""); element("details").hidden = false; element("accept").disabled = false; element("cancel").focus();
      const tick = () => {
        const remaining = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
        set("countdown", `${messages.remaining}: ${remaining}${messages.seconds}`);
        if (remaining === 0) { set("status", messages.expired); decide(false); clear(); }
      };
      tick(); if (!decided) timer = setInterval(tick, 250);
    } catch { clear(); }
  });
})();
