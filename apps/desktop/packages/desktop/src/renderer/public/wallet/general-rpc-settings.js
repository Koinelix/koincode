(() => {
  const choice = document.getElementById("general-rpc-choice");
  const apply = document.getElementById("general-rpc-apply");
  const status = document.getElementById("general-rpc-status");
  let messages = {}, network = "", selected = "default", count = 0, busy = false, blocked = true, revision = 0;
  const text = (key, fallback) => typeof messages[key] === "string" ? messages[key] : fallback;
  const controls = () => { choice.disabled = blocked || busy || count < 2; apply.disabled = choice.disabled || choice.value === selected; };
  const load = async (id, current) => {
    try {
      const response = await window.walletControl.generalRpcChoices(id), value = response.value;
      if (current !== revision) return;
      if (!response.ok || !value || !Array.isArray(value.choices) || value.choices.length < 1 || value.choices.length > 10 ||
          value.choices.some((item) => !item || typeof item.id !== "string" || typeof item.provider !== "string" ||
            typeof item.endpoint !== "string") || !value.choices.some((item) => item.id === value.selected)) throw new Error("Invalid endpoint choices");
      selected = value.selected; count = value.choices.length;
      choice.replaceChildren(...value.choices.map((item) => {
        const option = document.createElement("option"); option.value = item.id;
        option.textContent = `${item.provider} · ${item.endpoint}`; return option;
      }));
      choice.value = selected;
    } catch { if (current === revision) { count = 0; status.textContent = text("generalRpcUnavailable", "Could not verify the endpoint."); } }
    if (current === revision) controls();
  };
  window.updateGeneralRpcMessages = (value) => { messages = value || {}; };
  window.updateGeneralRpcSelection = (id, available, disabled) => {
    blocked = !available || disabled;
    const next = available ? id : "";
    if (next !== network) {
      network = next; count = 0; choice.replaceChildren(); status.textContent = "";
      const current = ++revision;
      if (network) void load(network, current);
    }
    controls();
  };
  choice.addEventListener("change", controls);
  apply.addEventListener("click", async (event) => {
    if (!event.isTrusted || blocked || busy || !network || choice.value === selected) return;
    const id = network, next = choice.value, current = revision;
    busy = true; controls();
    try {
      const response = await window.walletControl.generalChangeRpc(id, next);
      if (!response.ok) {
        if (current === revision) status.textContent = response.error === "GENERAL_RPC_DECLINED"
          ? text("generalRpcDeclined", "Endpoint change canceled.")
          : text("generalRpcUnavailable", "Could not change the endpoint.");
      } else {
        window.onGeneralRpcChanged?.();
        if (current === revision) status.textContent = text("generalRpcApplied", "Endpoint updated. Request the balance again.");
      }
    } catch { if (current === revision) status.textContent = text("generalRpcUnavailable", "Could not change the endpoint."); }
    finally { busy = false; if (current === revision) await load(id, current); controls(); }
  });
})();
