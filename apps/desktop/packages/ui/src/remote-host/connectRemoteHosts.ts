import type { RemoteHostManagementClient, RemoteHostSummary, RemoteTestResult } from "@fcode/shared";

/** Prepare explicit user targets without treating a saved address as a trusted SSH identity. */
export async function connectRemoteHosts(options: {
  client: RemoteHostManagementClient;
  hosts: RemoteHostSummary[];
  signal: AbortSignal;
  test(host: RemoteHostSummary): Promise<RemoteTestResult[]>;
  confirm(result: RemoteTestResult): Promise<boolean>;
}): Promise<RemoteHostSummary[]> {
  const { client, signal } = options;
  const prepared: RemoteHostSummary[] = [];
  for (const selected of options.hosts) {
    let host = selected;
    signal.throwIfAborted();
    if (!host.config.enabled) throw new Error("The selected remote host is disabled.");
    let connected = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = (await options.test(host)).find((value) => value.hostId === host.hostId);
      signal.throwIfAborted();
      if (!result) throw new Error("The remote host did not return a connection result.");
      if (result.success) { connected = true; break; }
      if (!result.challenge || !["host_key_unknown", "host_key_changed"].includes(result.error?.code ?? "")) {
        throw new Error(result.error?.message ?? "The remote host connection failed.");
      }
      if (!await options.confirm(result)) throw new DOMException("Connection preparation canceled.", "AbortError");
      signal.throwIfAborted();
      const accepted = await client.request("acceptHostKey", { challengeId: result.challenge.challengeId,
        action: result.error?.code === "host_key_changed" ? "replace_changed_key" : "trust_initial" });
      signal.throwIfAborted();
      const page = await client.request("listHosts", { enabled: true, limit: 200 });
      signal.throwIfAborted();
      const refreshed = page.items.find((value) => value.hostId === host.hostId);
      if (!refreshed || refreshed.securityRevision !== host.securityRevision + 1 || refreshed.trustRevision !== accepted.trustRevision ||
        refreshed.credentialVersion !== host.credentialVersion || JSON.stringify(refreshed.config) !== JSON.stringify(host.config)) {
        throw new Error("The remote host configuration changed while confirming its fingerprint. Select it again.");
      }
      host = refreshed;
    }
    if (!connected) throw new Error("The remote host identity kept changing. Reconnect after verifying its fingerprint.");
    prepared.push(host);
  }
  if (!options.hosts.length) return [];
  // Re-read revisions after trust acceptance; a draft must never bind its stale trustRevision.
  const page = await client.request("listHosts", { enabled: true, limit: 200 });
  signal.throwIfAborted();
  return prepared.map((selected) => {
    const host = page.items.find((value) => value.hostId === selected.hostId);
    if (!host || host.securityRevision !== selected.securityRevision || host.trustRevision !== selected.trustRevision || host.trustState !== "trusted") {
      throw new Error("The remote host configuration changed while connecting. Select it again.");
    }
    return host;
  });
}
