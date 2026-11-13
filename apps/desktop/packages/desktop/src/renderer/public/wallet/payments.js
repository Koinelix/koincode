window.createWalletPaymentView = (api, { message, run, showError, isWorking = () => false, compact = false, subscribe = true }) => {
  const panel = document.getElementById("wallet-payments");
  const choicesByApproval = new Map();
  let version = 0, timer, views = [], working = false;
  const label = (key, fallback) => message(key, fallback);
  const atomic = (value) => {
    const amount = BigInt(value), fraction = (amount % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
    return `${amount / 1000000n}${fraction ? `.${fraction}` : ""} USDC`;
  };
  const short = value => `${value.slice(0, 6)}…${value.slice(-4)}`;
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function line(card, key, fallback, value) {
    const row = node("div", undefined, "payment-fact");
    row.append(node("dt", label(key, fallback)), node("dd", value)); card.append(row);
  }
  function budgetLines(card, value, maximum = value.limits.maxPerPaymentAtomic) {
    line(card, "perPayment", "Per payment", atomic(maximum));
    line(card, "rollingLimit", "Rolling 24-hour limit", atomic(value.limits.maxRolling24hAtomic));
    line(card, "cumulativeLimit", "Cumulative limit", atomic(value.limits.maxCumulativeAtomic));
  }
  function details(value) {
    const disclosure = node("details", undefined, "payment-details"), facts = node("dl");
    disclosure.append(node("summary", label("paymentDetails", "Payment details")), facts);
    line(facts, "paymentTarget", "Request", `${value.method} ${value.origin}${value.path}`);
    line(facts, "wallet", "Wallet", value.wallet.address);
    line(facts, "payTo", "Pay to", value.payTo);
    line(facts, "network", "Network", value.network);
    line(facts, "asset", "Asset", value.asset);
    line(facts, "paymentBody", "Request body bytes / SHA-256", `${value.bodyByteLength} / ${value.bodySha256 ?? "—"}`);
    line(facts, "paymentOperation", "Operation / request", `${value.operationId} / ${value.requestId}`);
    line(facts, "paymentSignatureTime", "Maximum signature lifetime (seconds)", value.maxTimeoutSeconds);
    line(facts, "paymentScope", "Authorization scope", label("paymentScope", "This request only approves this purchase. This session covers this endpoint and recipient within wallet limits."));
    budgetLines(facts, value);
    if (value.budget) {
      for (const [key, fallback, field] of [
        ["reserved", "Reserved", "reservedAtomic"], ["rollingSpent", "Spent in rolling 24 hours", "rolling24hSpentAtomic"],
        ["cumulativeSpent", "Cumulative spent", "cumulativeSpentAtomic"],
        ["rollingRemaining", "Remaining in rolling 24 hours", "rolling24hRemainingAtomic"],
        ["cumulativeRemaining", "Cumulative remaining", "cumulativeRemainingAtomic"],
      ]) line(facts, key, fallback, atomic(value.budget[field]));
    }
    return disclosure;
  }
  function render(scrollToApprovalId) {
    clearTimeout(timer); panel.replaceChildren(); panel.hidden = !views.length;
    let earliest = Infinity;
    for (const { value, until } of views) {
      const card = node("article", undefined, "payment-authorization"), heading = node("header", undefined, "payment-heading");
      heading.append(node("h2", label("paymentTitle", "Payment authorization")));
      if (value.network === "eip155:84532") heading.append(node("span", label("generalTestnet", "Testnet"), "payment-network-badge"));
      if (!compact) card.append(heading);
      const price = node("div", undefined, "payment-price");
      price.append(node("span", label(value.paymentScheme === "upto" ? "paymentMaximum" : "paymentAuthorizationAmount",
        value.paymentScheme === "upto" ? "Maximum authorization" : "Authorization amount"), "payment-muted"), node("strong", atomic(value.amountAtomic)));
      if (!compact && value.paymentScheme === "upto") price.append(node("p", label("paymentUsageNotice", "Final charges follow actual usage.")));
      card.append(price);
      const summary = node("dl", undefined, "payment-summary");
      line(summary, "paymentService", "Service", value.origin);
      line(summary, "paymentEndpoint", "Endpoint", `${value.method} ${value.path}`);
      line(summary, "network", "Network", value.network === "eip155:84532" ? "Base Sepolia" : "Base");
      line(summary, "wallet", "Wallet", `${value.wallet.isDefault ? label("defaultWallet", "Default wallet") : label("wallet", "Wallet")} · ${short(value.wallet.address)}`);
      line(summary, "paymentRecipient", "Recipient", short(value.payTo));
      if (!compact) card.append(summary);
      const live = () => views.some(entry => entry.value === value) && until > performance.now();
      const submit = choice => {
        if (working || isWorking() || !live()) return;
        working = true; render();
        void Promise.resolve().then(() => run(() => api.decidePayment(value.approvalId, choice)))
          .catch(() => showError("PAYMENT_APPROVAL_UNAVAILABLE"))
          .finally(() => { working = false; void refresh(); });
      };
      const blocked = !value.budget || value.budget.blocked || !value.limits.enabled || value.wallet.recoveryRequired || value.wallet.signingPaused;
      const expired = until <= performance.now(), locked = value.diagnosticCode === "WALLET_LOCKED";
      if (expired) {
        card.append(node("p", label("paymentExpired", "This quote expired. No new payment can be approved here."), "payment-warning"));
      } else {
        earliest = Math.min(earliest, until);
        if (blocked) card.append(node("p", value.budget ? label("budgetBlocked", "New payments are blocked by the current wallet state.")
          : label("budgetUnavailable", "Budget state is unavailable."), "payment-warning"));
        const scopes = node("fieldset", undefined, "payment-scopes"), limits = node("dl", undefined, "payment-scope-limits");
        budgetLines(limits, value);
        const actions = node("div", undefined, "payment-actions"), deny = node("button", label("paymentDeny", "Deny"));
        deny.type = "button"; deny.dataset.paymentChoice = "deny"; deny.disabled = working || isWorking();
        deny.addEventListener("click", event => { if (event.isTrusted) submit("deny"); }); actions.append(deny);
        if (!blocked) {
          const approve = node("button", undefined, "payment-approve"); approve.type = "button"; approve.disabled = working || isWorking();
          if (locked) {
            approve.textContent = label("paymentContinue", "Unlock and continue"); approve.dataset.paymentChoice = "continue";
          } else {
            const choices = ["once", "session", ...(value.allowPersistent === false ? [] : ["persistent"])];
            if (!choices.includes(choicesByApproval.get(value.approvalId))) choicesByApproval.set(value.approvalId, "once");
            scopes.append(node("legend", label("paymentAllow", "Allow payments"), compact ? "sr-only" : undefined));
            const names = { once: ["paymentRequestOnly", "This request only"], session: ["paymentSession", "This session"], persistent: ["paymentAlways", "Always"] };
            const descriptions = {
              once: ["paymentOnceDescription", "Ask again for the next payment."],
              session: ["paymentSessionDescription", "Allow this chat to pay this endpoint and recipient within your wallet limits."],
              persistent: ["paymentAlwaysDescription", "Allow future requests from this client to this endpoint and recipient up to this amount, within your wallet limits."],
            };
            const updateChoice = () => {
              const selected = choicesByApproval.get(value.approvalId);
              approve.dataset.paymentChoice = selected;
              approve.textContent = label(selected === "once" ? "paymentAllowOnce" : selected === "session" ? "paymentAllowSession" : "paymentAllowAlways",
                selected === "once" ? "Allow this request" : selected === "session" ? "Allow for this session" : "Always allow");
              limits.hidden = compact || selected === "once";
              limits.replaceChildren();
              const cap = selected === "persistent" && BigInt(value.amountAtomic) < BigInt(value.limits.maxPerPaymentAtomic)
                ? value.amountAtomic : value.limits.maxPerPaymentAtomic;
              budgetLines(limits, value, cap);
            };
            for (const choice of choices) {
              const option = node("label", undefined, "payment-scope-option"), radio = node("input"), copy = node("span");
              radio.type = "radio"; radio.name = `payment-scope-${value.approvalId}`; radio.value = choice;
              radio.checked = choicesByApproval.get(value.approvalId) === choice; radio.disabled = working || isWorking();
              radio.addEventListener("change", event => {
                if (!event.isTrusted || working || isWorking() || !live() || !radio.checked) return;
                choicesByApproval.set(value.approvalId, choice); updateChoice();
              });
              copy.append(node("strong", label(...names[choice])));
              if (!compact) copy.append(node("small", label(...descriptions[choice])));
              option.append(radio, copy); scopes.append(option);
            }
            updateChoice(); card.append(scopes, limits);
          }
          approve.addEventListener("click", event => { if (event.isTrusted) submit(locked ? "continue" : choicesByApproval.get(value.approvalId)); });
          actions.append(approve);
        }
        card.append(details(value), actions);
      }
      if (expired) card.append(details(value));
      panel.append(card);
      if (value.approvalId === scrollToApprovalId) card.scrollIntoView({ block: "start" });
    }
    if (Number.isFinite(earliest)) timer = setTimeout(render, Math.max(1, earliest - performance.now()));
  }
  async function refresh() {
    const current = ++version;
    try {
      const started = performance.now(), result = await api.paymentStatus();
      if (version !== current) return;
      if (!result.ok || !Array.isArray(result.value) || result.value.length > 32) throw new Error("PAYMENT_APPROVAL_UNAVAILABLE");
      const newApproval = result.value.find(value => !views.some(entry => entry.value.approvalId === value.approvalId));
      for (const id of choicesByApproval.keys()) if (!result.value.some(value => value.approvalId === id)) choicesByApproval.delete(id);
      views = result.value.map(value => ({ value, until: started + value.expiresInMs })); render(newApproval?.approvalId);
    } catch {
      if (version !== current) return;
      invalidate(); showError("PAYMENT_APPROVAL_UNAVAILABLE");
    }
  }
  function invalidate() {
    version++; clearTimeout(timer); views = []; choicesByApproval.clear(); panel.replaceChildren(); panel.hidden = true;
  }
  if (subscribe) api.onPaymentChanged(() => { void refresh(); });
  return { refresh, invalidate, localize: () => render() };
};
