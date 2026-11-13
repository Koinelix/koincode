import type { FCodePermissionRequest } from "@fcode/shared";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

export function RemoteHostPermissionBlock({ request }: { request: FCodePermissionRequest }) {
  const { intl } = useFCodeIntl();
  const display = request.display?.kind === "remote_host_approval" ? request.display : null;
  if (!display) return null;
  const details = display.details;
  const targets = Array.isArray(details.targets) ? details.targets as Array<Record<string, unknown>> : [];
  const offer = details.sessionAuthorizationOffer as { workspaceRoot?: string; targets?: Array<Record<string, unknown>> } | undefined;
  return <div className="space-y-3" data-testid="remote-host-permission">
    <p className="font-medium">{intl.formatMessage({ id: display.phase === "preflight" ? "remoteHosts.preflightPermission" : "remoteHosts.operationPermission" })}</p>
    {targets.map((target, index) => <div key={String(target.hostId ?? index)} className="space-y-1 break-all rounded border p-2">
      <p><strong>{String(target.name ?? target.hostId)}</strong> · {String(target.username ?? "")}@{String(target.endpoint ?? "")} · {String(target.environment ?? "")}</p>
      {Boolean(target.path) && <p className="font-mono">{String(target.path)}</p>}
      {Boolean(target.command) && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{JSON.stringify(target.command, null, 2)}</pre>}
      {Boolean(target.verify) && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{JSON.stringify(target.verify, null, 2)}</pre>}
    </div>)}
    {offer && <div className="space-y-1 rounded border border-warning p-2" data-testid="remote-host-session-authorization-scope">
      <strong>{intl.formatMessage({ id: "remoteHosts.sessionAuthorizationScope" })}</strong>
      <p>{intl.formatMessage({ id: "remoteHosts.allowSessionDescription" })}</p>
      {offer.targets?.map(target => <p key={String(target.hostId)} className={target.environment === "production" ? "text-destructive" : ""}>
        {String(target.name)} · {String(target.username)}@{String(target.endpoint)} · {String(target.environment)} · {String(target.hostId)}
      </p>)}
      <p className="break-all">{intl.formatMessage({ id: "remoteHosts.sessionWorkspaceRoot" })}: {offer.workspaceRoot}</p>
    </div>}
    <details><summary>{intl.formatMessage({ id: "remoteHosts.permissionDetails" })}</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-ui-xs">{JSON.stringify(details, null, 2)}</pre></details>
  </div>;
}
