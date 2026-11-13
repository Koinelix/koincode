(() => {
  const NETWORKS = ["1", "11155111", "8453", "84532", "42161", "421614", "10", "11155420", "56", "97", "137", "80002", "43114", "43113"];
  window.createGeneralHistoryView = ({ call, perform, text, show, status }) => {
    const byId = (id) => document.getElementById(id);
    let generation = 0, account, head, nextOffset;
    const clear = () => {
      generation++; account = undefined; head = undefined; nextOffset = undefined;
      byId("history-address").textContent = ""; byId("history-items").replaceChildren();
      byId("history-note").textContent = ""; byId("history-next").hidden = true;
    };
    const amount = (value, decimals) => {
      if (decimals === null) return value;
      if (decimals === 0) return value;
      const digits = value.padStart(decimals + 1, "0"), whole = digits.slice(0, -decimals), fraction = digits.slice(-decimals).replace(/0+$/, "");
      return fraction ? `${whole}.${fraction}` : whole;
    };
    const field = (key, value) => {
      const row = document.createElement("p"), label = document.createElement("strong"), data = document.createElement("span");
      label.textContent = `${text(key, key)}: `; data.textContent = value; data.className = "address"; row.append(label, data); return row;
    };
    const load = async (offset = 0) => {
      if (!account) return;
      const original = { ...account }, current = ++generation, networkId = byId("history-network").value;
      byId("history-items").replaceChildren(); byId("history-next").hidden = true;
      const query = { action: "history", sourceId: original.sourceId, networkId, offset, limit: 20, ...(offset ? { head } : {}) };
      const page = await call(query);
      if (current !== generation || !account || original.sourceId !== account.sourceId || networkId !== byId("history-network").value) return;
      if (page.sourceId !== original.sourceId || page.accountAddress !== original.address || page.networkId !== networkId ||
          page.nextOffset !== null && page.nextOffset !== offset + page.items.length) throw new Error("GENERAL_HISTORY_UNAVAILABLE");
      head = page.head; nextOffset = page.nextOffset;
      const symbol = ["eip155:56", "eip155:97"].includes(networkId) ? "BNB" : ["eip155:137", "eip155:80002"].includes(networkId) ? "POL" :
        ["eip155:43114", "eip155:43113"].includes(networkId) ? "AVAX" : "ETH";
      byId("history-note").textContent = text(page.status === "unregistered" ? "historyUnregistered" : page.items.length ? "historyRiskRetained" : "historyEmpty", "No verified record is available.");
      for (const item of page.items) {
        const entry = document.createElement("li");
        entry.append(field("historyPhase", text(`history_${item.phase}`, item.phase)),
          field("historyBroadcast", text(`history_${item.broadcast}`, item.broadcast)),
          field("historyMaterial", text(`history_material_${item.material}`, item.material)),
          field("historyRecipient", item.recipient ?? text("historyUnknown", "Unknown")),
          field("historyAsset", item.asset === "native" ? symbol : item.asset.slice(6)),
          field("historyAmount", `${amount(item.amountAtomic, item.decimals)} (${item.amountAtomic} ${text("historyAtomic", "atomic units")})`),
          field("historyFee", `${amount(item.maxFeeAtomic, 18)} ${symbol} (${item.maxFeeAtomic} ${text("historyAtomic", "atomic units")})`),
          field("historyTime", text("historyTimeUnknown", "Time unknown")),
          field("historyHash", item.transactionHash ?? text("historyUnknown", "Unknown")),
          field("historyRisk", item.riskId));
        byId("history-items").append(entry);
      }
      byId("history-next").hidden = nextOffset === null;
      status("historyRiskRetained", "These records do not prove finality. Existing risks are retained.");
    };
    byId("history-refresh").addEventListener("click", () => void perform(() => load()));
    byId("history-network").addEventListener("change", () => void perform(() => load()));
    byId("history-next").addEventListener("click", () => void perform(() => load(nextOffset)));
    byId("history-back").addEventListener("click", () => { clear(); show("choices"); status("ready", "Choose how to add an account."); });
    return { clear, async open(selected) {
      clear(); account = { sourceId: selected.sourceId, address: selected.address };
      byId("history-address").textContent = selected.address;
      byId("history-network").replaceChildren(...NETWORKS.map((chain) => {
        const option = document.createElement("option"); option.value = `eip155:${chain}`; option.textContent = text(`historyNetwork_${chain}`, option.value); return option;
      }));
      show("history"); await load();
    } };
  };
})();
