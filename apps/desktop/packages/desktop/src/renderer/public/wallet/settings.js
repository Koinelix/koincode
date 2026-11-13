/* Display state only. The trusted host reauthenticates and validates every control command. */
window.createWalletSettingsView = (api, { message, run, showError }, options = {}) => {
  const panel = document.getElementById("wallet-settings");
  let walletId,
    section = "clients",
    offset = 0,
    generation = 0;
  let history = [];
  let bindings = [], latestPolicy;
  const labels = new Map();
  const label = (key, fallback) => { const value = message(key, fallback); labels.set(value, { key, fallback }); return value; };
  const element = (tag, text) => {
    const result = document.createElement(tag);
    if (text !== undefined) {
      result.textContent = typeof text === "function" ? text() : text;
      const binding = typeof text === "function" ? text : labels.has(text) ? () => message(labels.get(text).key, labels.get(text).fallback) : undefined;
      if (binding && result.firstChild) bindings.push({ node: result.firstChild, value: binding });
    }
    return result;
  };
  const button = (text, action) => {
    const result = element("button", text);
    result.type = "button";
    result.addEventListener("click", (event) => {
      if (event.isTrusted) void action();
    });
    return result;
  };
  const amount = (value) => {
    const digits = BigInt(value).toString().padStart(7, "0");
    const fraction = digits.slice(-6).replace(/0+$/, "");
    return `${digits.slice(0, -6)}${fraction ? `.${fraction}` : ""}`;
  };
  const atomic = (value) => {
    if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) throw new Error("WALLET_INVALID_AMOUNT");
    const [whole, fraction = ""] = value.split(".");
    const result = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
    if (result > (1n << 256n) - 1n) throw new Error("WALLET_INVALID_AMOUNT");
    return result.toString();
  };
  function invalidate() {
    generation++; bindings = []; latestPolicy = undefined;
    panel.replaceChildren();
    panel.hidden = true;
  }
  function renderLimits(data) {
    const renderedWalletId = walletId, renderedGeneration = generation;
    const form = element("form");
    if (!options.basic) form.append(element("h3", label("limitsTitle", "Payment limits (USDC)")));
    const fields = {};
    for (const [key, title] of [
      ["maxPerPaymentAtomic", "perPayment"],
      ["maxRolling24hAtomic", "rollingLimit"],
      ["maxCumulativeAtomic", "cumulativeLimit"],
    ]) {
      const line = element("label", label(title, title));
      const input = element("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.maxLength = 86;
      input.value = amount(data.limits[key]);
      input.dataset.limit = key;
      fields[key] = input;
      line.append(input);
      form.append(line);
    }
    const enable = element("input");
    enable.type = "checkbox";
    enable.checked = data.limits.enabled;
    enable.dataset.limit = "enabled";
    const enabledLabel = element(
      "label",
      label("paymentsEnabled", "Enable payments within these limits"),
    );
    enabledLabel.append(enable);
    form.append(enabledLabel);
    const save = element("button", label("saveLimits", "Save limits"));
    save.type = "submit";
    form.append(save);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!event.isTrusted || generation !== renderedGeneration || walletId !== renderedWalletId) return;
      try {
        const limits = { enabled: enable.checked };
        for (const [key, input] of Object.entries(fields)) limits[key] = atomic(input.value);
        void run(() => api.setLimits(renderedWalletId, limits));
      } catch {
        showError("WALLET_INVALID_AMOUNT");
      }
    });
    panel.append(form);
    if (!data.budget)
      panel.append(element("p", label("budgetUnavailable", "Budget state is unavailable.")));
    else
      for (const [key, title] of [
        ["reservedAtomic", "reserved"],
        ["rolling24hSpentAtomic", "rollingSpent"],
        ["cumulativeSpentAtomic", "cumulativeSpent"],
        ["rolling24hRemainingAtomic", "rollingRemaining"],
        ["cumulativeRemainingAtomic", "cumulativeRemaining"],
      ])
        panel.append(element("p", () => `${label(title, title)}: ${amount(data.budget[key])} USDC`));
    if (data.budget?.blocked)
      panel.append(
        element(
          "p",
          label("budgetBlocked", "New payments are blocked by the current wallet state."),
        ),
      );
  }
  function renderAllowance() {
    const id = walletId, version = generation, box = element("article");
    const current = () => version === generation && id === walletId && box.isConnected;
    const status = element("p");
    status.setAttribute("role", "status");
    let working = false, statusText;
    const setStatus = (value) => {
      statusText = value; status.textContent = value();
      if (status.firstChild) bindings.push({ node: status.firstChild, value: () => statusText() });
    };
    async function request(action, display) {
      if (!current() || working) return;
      working = true; box.setAttribute("aria-busy", "true");
      try {
        const response = await action();
        if (!current()) return;
        if (!response.ok) throw new Error(response.error);
        display(response.value);
      } catch (error) {
        if (current()) setStatus(() => label(error.message, label("allowanceError", "Refresh the allowance and try again.")));
      } finally { working = false; box.removeAttribute("aria-busy"); }
    }
    function submitted(result) {
      box.replaceChildren(status, refresh);
      setStatus(() => label(result.status === "submitted" ? "allowanceSubmitted" : "allowanceUnknown", "Check the transaction on chain.") + " " + result.hash);
    }
    function show(info) {
      const input = element("input");
      input.type = "text"; input.inputMode = "decimal"; input.maxLength = 79; input.autocomplete = "off";
      const field = element("label", label("allowanceTarget", "New allowance (USDC)")); field.append(input);
      const controls = element("div");
      setStatus(() => "");
      const preview = button(label("allowancePreview", "Preview network fee"), () => {
        const entered = input.value;
        let target;
        try { target = atomic(input.value); } catch { setStatus(() => label("ALLOWANCE_INVALID_AMOUNT", "Enter a USDC amount with up to six decimals.")); return; }
        return request(() => api.allowancePreview(id, target), quoted => {
          if (input.value !== entered) return;
          const wei = BigInt(quoted.feeWei).toString().padStart(19, "0");
          controls.replaceChildren(element("p", () => label("allowanceEstimate", "Estimated network fee") + " " + wei.slice(0, -18) + "." + wei.slice(-18).replace(/0+$/, "") + " ETH"),
            button(() => label("allowanceConfirm", "Confirm allowance") + " · " + amount(quoted.amount) + " USDC", () => request(() => api.allowanceConfirm(id, quoted.id), submitted)));
        });
      });
      input.addEventListener("input", () => controls.replaceChildren(preview));
      controls.append(preview);
      box.replaceChildren(element("h3", label("allowanceTitle", "On-chain USDC allowance")),
        element("p", (info.network === "eip155:8453" ? "Base Mainnet" : "Base Sepolia") + " · " + info.address),
        element("p", "Permit2 · " + info.spender),
        element("p", () => label("allowanceCurrent", "Current allowance") + " · " + amount(info.allowance) + " USDC"),
        element("p", () => label("allowanceReserved", "Pending payment ceilings") + " · " + amount(info.inFlight) + " USDC"), status);
      if (info.quotes?.length) box.append(element("p", () => label("allowanceQuotes", "Current quote ceilings") + " · " + info.quotes.map(amount).join(" + ") + " USDC"));
      if (info.pendingHash) {
        setStatus(() => label("allowancePending", "Previous authorization transaction") + " " + info.pendingHash);
        box.append(button(label("allowanceResend", "Rebroadcast the same transaction"), () => request(() => api.allowanceResend(id, info.pendingHash), submitted)));
      } else if (info.busy) setStatus(() => label("ALLOWANCE_TX_PENDING", "Wait for outstanding payments before changing allowance."));
      else box.append(field, controls);
      box.append(refresh);
    }
    const refresh = button(label("allowanceRead", "View on-chain allowance"), () => request(() => api.allowanceStatus(id), show));
    box.append(refresh, status); panel.append(box);
  }
  function renderRecords(data) {
    const tabs = element("div");
    tabs.className = "actions";
    for (const [key, title] of [
      ["clients", "clientsTitle"],
      ["grants", "grantsTitle"],
      ["payments", "paymentsTitle"],
    ]) {
      const tab = button(label(title, key), () => {
        history = [];
        return load(key, 0);
      });
      tab.setAttribute("aria-pressed", String(section === key));
      tabs.append(tab);
    }
    panel.append(
      tabs,
      element(
        "p",
        label("recordsMayChange", "Records can change. Refresh starts at the first page."),
      ),
    );
    if (section === "clients") {
      panel.append(
        element(
          "p",
          label(
            "clientScopeNotice",
            "Registration covers this wallet. Revocation removes this client's access to every wallet.",
          ),
        ),
      );
      panel.append(
        button(label("registerExternal", "Register external client"), () =>
          run(() => api.registerClient(walletId, "external")),
        ),
      );
    }
    if (!data.records.length)
      panel.append(element("p", label("noRecords", "No records on this page.")));
    for (const row of data.records) {
      if (section === "clients" && row.clientId === data.desktopClient?.clientId) continue;
      const card = element("article");
      if (section === "clients") {
        card.append(
          element("p", row.clientId),
          element(
            "p",
            `${row.kind} · ${label(row.active ? "active" : "revoked", row.active ? "Active" : "Revoked")}`,
          ),
        );
        if (row.active)
          card.append(
            button(label("revoke", "Revoke"), () =>
              run(() => api.revokeClient(walletId, row.clientId, offset)),
            ),
          );
      } else if (section === "grants") {
        card.append(
          element("p", row.grantId),
          element("p", `${row.scope} · ${row.status}`),
          element("p", `${row.method} ${row.origin}${row.path}${row.pathPrefix ? "*" : ""}`),
          element("p", `${label("payTo", "Pay to")}: ${row.payTo}`),
          element(
            "p",
            `${label("maxPayment", "Maximum payment")}: ${amount(row.maxAmountAtomic)} USDC`,
          ),
          element("p", `${label("grantClients", "Clients")}: ${row.clientIds.join(", ")}`),
          element(
            "p",
            `${label("expiresAt", "Expires at")}: ${row.expiresAt === null ? label("noExpiry", "No expiry") : new Date(row.expiresAt * 1000).toLocaleString()}`,
          ),
        );
        if (["active", "paused"].includes(row.status))
          card.append(
            button(label("revoke", "Revoke"), () =>
              run(() => api.revokeGrant(walletId, row.grantId, offset)),
            ),
          );
      } else {
        card.append(
          element("p", label("legacyPaymentSource", "Skill payment")),
          element("p", `${label("legacyPaymentWallet", "Payment wallet")}: ${data.wallet.address}`),
          element("p", `${label("legacyPaymentNetwork", "Payment network")}: ${data.wallet.network}`),
          element("p", row.requestId),
          element("p", `${row.method} ${row.origin}${row.path}`),
          element("p", `${amount(row.amountAtomic)} USDC · ${row.status}`),
          element(
            "p",
            `${label("reserved", "Reserved")}: ${row.reserved} · ${label("countedSpent", "Counted as spent")}: ${row.spent}`,
          ),
          element("p", `${label("payTo", "Pay to")}: ${row.payTo}`),
        );
        if (row.settlementTx)
          card.append(element("p", `${label("transaction", "Transaction")}: ${row.settlementTx}`));
      }
      panel.append(card);
    }
    const pages = element("div");
    pages.className = "actions";
    if (history.length)
      pages.append(
        button(label("previousPage", "Previous page"), () => load(section, history.pop())),
      );
    if (data.nextOffset !== null)
      pages.append(
        button(label("nextPage", "Next page"), () => {
          history.push(offset);
          return load(section, data.nextOffset);
        }),
      );
    panel.append(pages);
  }
  async function load(nextSection, nextOffset) {
    section = nextSection;
    offset = nextOffset;
    const current = ++generation,
      selected = walletId;
    panel.hidden = false; bindings = []; labels.clear();
    panel.replaceChildren(element("p", label("loadingSettings", "Loading wallet settings…")));
    try {
      const response = await api.inspectWallet(selected, section, offset);
      if (generation !== current || walletId !== selected) return;
      if (!response.ok) throw new Error(response.error);
      if (options.basic) panel.replaceChildren();
      else panel.replaceChildren(
        element("h2", label("settings", "Wallet settings")),
        element("p", response.value.wallet.address),
        element("p", `${response.value.wallet.network} · ${response.value.wallet.asset}`),
      );
      if (!options.basic && response.value.desktopClient) {
        const connection = element("article");
        connection.append(element("h3", label("desktopConnection", "Current desktop connection")),
          element("p", label(response.value.desktopClient.active ? "desktopConnected" : "desktopDisabled", "Desktop wallet connection")));
        panel.append(connection);
      }
      renderLimits(response.value);
      if (response.value.wallet.isDefault && api.allowanceStatus) renderAllowance();
      if (!options.basic) renderRecords(response.value);
      const policy = response.value.limits; latestPolicy = { walletId: selected, policy };
      options.onLimits?.(selected, label("homeLimitsSummary", "Per payment {per} · 24h {daily} · Total {total} USDC")
        .replace("{per}", amount(policy.maxPerPaymentAtomic)).replace("{daily}", amount(policy.maxRolling24hAtomic))
        .replace("{total}", amount(policy.maxCumulativeAtomic)));
    } catch {
      if (generation !== current) return;
      panel.replaceChildren(
        element(
          "p",
          label("settingsUnavailable", "Wallet settings are unavailable. Refresh to try again."),
        ),
      );
    }
  }
  return {
    invalidate,
    localize() {
      for (const binding of bindings) if (binding.node.isConnected) binding.node.nodeValue = binding.value();
      if (latestPolicy?.walletId === walletId) {
        const policy = latestPolicy.policy;
        options.onLimits?.(walletId, label("homeLimitsSummary", "Per payment {per} · 24h {daily} · Total {total} USDC")
          .replace("{per}", amount(policy.maxPerPaymentAtomic)).replace("{daily}", amount(policy.maxRolling24hAtomic)).replace("{total}", amount(policy.maxCumulativeAtomic)));
      }
    },
    async open(id) {
      walletId = id;
      history = [];
      await load("clients", 0);
    },
    update(data) {
      if (options.basic) {
        walletId = data.wallets.find((wallet) => wallet.isDefault)?.walletId;
        if (!walletId) { invalidate(); return; }
      }
      if (!walletId && data.profileOpen) walletId = (data.wallets.find(item => item.isDefault) ?? data.wallets[0])?.walletId;
      if (!walletId) return;
      if (!data.profileOpen || !data.wallets.some((wallet) => wallet.walletId === walletId)) {
        walletId = undefined;
        invalidate();
        return;
      }
      history = [];
      void load(section, 0);
    },
  };
};
