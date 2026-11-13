(() => {
  const api = window.walletPayment, error = document.getElementById("payment-error");
  let text = {}, generation = 0;
  const message = (key, fallback) => typeof text[key] === "string" ? text[key] : fallback;
  const showError = () => {
    error.hidden = false;
    error.textContent = message("paymentConfirmationUnavailable", "Payment confirmation is unavailable. Please check the original request.");
  };
  const view = window.createWalletPaymentView(api, { message, showError, compact: true, subscribe: false,
    run: async action => {
      error.hidden = true;
      const result = await action();
      if (!result.ok) showError();
      return result;
    } });
  async function refresh() {
    const current = ++generation;
    try {
      const reply = await api.presentation();
      if (current !== generation) return;
      if (!reply.ok) throw new Error("Presentation unavailable");
      text = reply.value.text;
      document.documentElement.lang = message("lang", "en");
      await view.refresh();
    } catch { if (current === generation) { view.invalidate(); showError(); } }
  }
  const dispose = [api.onPaymentChanged(() => { void refresh(); }), api.onLocaleChanged(() => { void refresh(); })];
  window.addEventListener("beforeunload", () => { generation++; view.invalidate(); for (const stop of dispose) stop(); });
})();
