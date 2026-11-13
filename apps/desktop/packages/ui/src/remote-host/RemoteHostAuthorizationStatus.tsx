import { useEffect, useRef, useState } from "react";
import type { RemoteHostManagementClient, RemoteSessionAuthorizationStatus } from "@fcode/shared";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

const AUTHORIZATION_POLL_MS = 2000;
export function RemoteHostAuthorizationStatus({ client, workspaceKey, sessionId }: {
  client: RemoteHostManagementClient; workspaceKey: string; sessionId: string;
}) {
  const { intl } = useFCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  const revision = useRef(0);
  const [status, setStatus] = useState<RemoteSessionAuthorizationStatus>({ active: false, targets: [] });
  const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  useEffect(() => {
    let current = true; let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const captured = revision.current;
      try {
        const value = await client.request("getSessionAuthorization", { workspaceKey, sessionId });
        if (current && captured === revision.current) { setStatus(value); setError(""); }
      } catch (failure) { if (current) setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { if (current) timer = setTimeout(read, AUTHORIZATION_POLL_MS); }
    };
    void read(); return () => { current = false; clearTimeout(timer); };
  }, [client, workspaceKey, sessionId]);
  if (!status.active) return null;
  return <div className="mx-3 mt-2 space-y-1 rounded border border-warning p-2 text-ui-sm" data-testid="remote-host-session-authorization">
    <div className="flex flex-wrap items-center gap-2"><strong>{t("sessionAuthorizationActive")}</strong>
      <button type="button" disabled={pending} className="rounded border px-2 py-1" data-testid="remote-host-revoke-authorization" onClick={async () => {
        revision.current++; setPending(true); setError("");
        try {
          await client.request("revokeSessionAuthorization", { workspaceKey, sessionId });
          setStatus({ active: false, targets: [] });
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setPending(false); }
      }}>{t("revokeSessionAuthorization")}</button>
    </div>
    <p>{t("sessionAuthorizationActiveDescription")}</p>
    {status.targets.map(target => <p key={target.hostId} className={`break-all ${target.environment === "production" ? "text-destructive" : ""}`}>
      {target.name} · {target.username}@{target.endpoint} · {t(`environment.${target.environment}`)}
    </p>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
