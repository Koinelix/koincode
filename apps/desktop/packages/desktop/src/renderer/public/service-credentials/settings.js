(() => {
  const api = window.serviceCredentials, byId = (id) => document.getElementById(id);
  let labels = {}, entries = [], selectedRef;
  const text = (id, key) => { byId(id).textContent = labels[key] || key; };
  function render() {
    for (const [id, key] of Object.entries({ title: "title", description: "description", "saved-title": "savedTitle",
      "add-title": selectedRef ? "replaceTitle" : "addTitle", "origin-label": "origin", "path-label": "path",
      "secret-label": "secret", save: selectedRef ? "replace" : "save", "cancel-edit": "cancel" })) text(id, key);
    byId("cancel-edit").hidden = !selectedRef;
    const container = byId("entries"); container.replaceChildren();
    if (!entries.length) { const empty = document.createElement("p"); empty.textContent = labels.empty; container.append(empty); }
    for (const entry of entries) {
      const row = document.createElement("article"), target = document.createElement("p");
      target.textContent = `${entry.origin}${entry.path}`; row.append(target);
      const replace = document.createElement("button"); replace.type = "button"; replace.textContent = labels.replace;
      replace.addEventListener("click", () => { selectedRef = entry.ref; byId("origin").value = entry.origin;
        byId("path").value = entry.path; byId("origin").readOnly = true; byId("path").readOnly = true;
        byId("secret").value = ""; render(); byId("secret").focus(); });
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = labels.remove;
      remove.addEventListener("click", async () => { const result = await api.revoke(entry.ref);
        if (!result.ok) { byId("error").textContent = labels.error; return; } await refresh(); });
      row.append(replace, remove); container.append(row);
    }
  }
  async function refresh() {
    const result = await api.status();
    if (result.value?.messages) { labels = result.value.messages; document.documentElement.lang = result.value.locale; }
    if (!result.ok) { render(); byId("error").textContent = labels.error || "Service credential storage unavailable."; return; }
    entries = result.value.entries; render();
  }
  byId("cancel-edit").addEventListener("click", () => { selectedRef = undefined; byId("form").reset();
    byId("origin").readOnly = false; byId("path").readOnly = false; render(); });
  byId("form").addEventListener("submit", async (event) => {
    event.preventDefault(); byId("error").textContent = ""; byId("saved").textContent = "";
    const secret = byId("secret").value; byId("secret").value = ""; byId("save").disabled = true;
    try {
      const result = await api.save(byId("origin").value, byId("path").value, secret, selectedRef);
      if (!result.ok) { byId("error").textContent = labels.error; return; }
      selectedRef = undefined; byId("form").reset(); byId("origin").readOnly = false; byId("path").readOnly = false;
      await refresh(); byId("saved").textContent = labels.saved;
    } finally { byId("save").disabled = false; }
  });
  void refresh();
})();
