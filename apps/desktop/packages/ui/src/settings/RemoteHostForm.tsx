import { useState, useId, isValidElement, cloneElement, type ReactNode } from "react";
import { remoteHostConfigSchema, type RemoteHostConfig, type RemoteHostSummary,
  type RemoteHostManagementClient, type RemoteHostCapabilities } from "@fcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

const SELECT_STYLE = "h-8 w-full rounded-md border border-input-border bg-input px-2 text-ui-base";
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return <div className="flex min-w-0 flex-col gap-1.5 text-ui-base"><label htmlFor={id}>{label}</label>
    {isValidElement<Record<string, unknown>>(children) ? cloneElement(children, { id }) : children}</div>;
}

export function RemoteHostForm({ host, client, capabilities, onClose, onSaved }: {
  host?: RemoteHostSummary; client: RemoteHostManagementClient; capabilities: RemoteHostCapabilities | null;
  onClose(): void; onSaved(host: RemoteHostSummary): void;
}) {
  const { intl } = useFCodeIntl();
  const platform = usePlatform();
  const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  const [config, setConfig] = useState<RemoteHostConfig>(() => host?.config ?? {
    name: "", host: "", port: 22, username: "", authType: "private_key", enabled: true,
    environment: "unspecified", group: "", tags: [], fileRoots: [],
    secretPersistence: capabilities?.secretStorage.available ? "os_protected" : "session",
  });
  const [secretIntent, setSecretIntent] = useState<"keep" | "replace" | "clear">(host ? "keep" : "replace");
  const [secret, setSecret] = useState("");
  const [tagsText, setTagsText] = useState(host?.config.tags.join(", ") ?? "");
  const [rootsText, setRootsText] = useState(host?.config.fileRoots.join(", ") ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const update = <K extends keyof RemoteHostConfig>(key: K, value: RemoteHostConfig[K]) => setConfig((old) => ({ ...old, [key]: value }));
  const close = () => { setSecret(""); onClose(); };
  const save = async () => {
    setError(""); setSaving(true);
    try {
      const normalized = remoteHostConfigSchema.parse({ ...config,
        tags: tagsText.split(",").map((value) => value.trim()).filter(Boolean),
        fileRoots: rootsText.split(",").map((value) => value.trim()).filter(Boolean) });
      const material = config.authType === "password" ? { password: secret } : secret ? { passphrase: secret } : {};
      const saved = await client.request("saveHost", { requestId: crypto.randomUUID(), ...(host ? { hostId: host.hostId, expectedRevision: host.revision } : {}),
        config: normalized, secret: secretIntent === "replace" ? { intent: "replace", material } : { intent: secretIntent } });
      setSecret(""); onSaved(saved); close();
    } catch (failure) { setError(failure instanceof Error ? failure.message : t("saveFailed")); }
    finally { setSecret(""); setSaving(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) close(); }}>
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{t(host ? "edit" : "add")}</DialogTitle></DialogHeader>
      <form className="space-y-4" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("name")}><Input required maxLength={100} value={config.name} onChange={(event) => update("name", event.target.value)} /></Field>
          <Field label={t("environment")}><select className={SELECT_STYLE} value={config.environment} onChange={(event) => update("environment", event.target.value as RemoteHostConfig["environment"])}>
            {["unspecified", "development", "test", "production"].map((value) => <option key={value} value={value}>{t(`environment.${value}`)}</option>)}
          </select></Field>
          <Field label={t("address")}><Input required value={config.host} onChange={(event) => update("host", event.target.value)} placeholder="host.example.com" /></Field>
          <Field label={t("port")}><Input type="number" required min={1} max={65535} value={config.port} onChange={(event) => update("port", Number(event.target.value))} /></Field>
          <Field label={t("username")}><Input required value={config.username} onChange={(event) => update("username", event.target.value)} autoComplete="off" /></Field>
          <Field label={t("authentication")}><select className={SELECT_STYLE} value={config.authType} onChange={(event) => {
            const type = event.target.value as RemoteHostConfig["authType"];
            setConfig((old) => ({ ...old, authType: type, privateKeyPath: undefined, agentPath: undefined }));
            setSecret(""); setSecretIntent("replace");
          }}>{["private_key", "ssh_agent", "password"].map((value) => <option key={value} value={value}>{t(`auth.${value}`)}</option>)}</select></Field>
          {config.authType === "private_key" ? <Field label={t("privateKey")}><div className="flex gap-2">
            <Input aria-label={t("privateKey")} value={config.privateKeyPath ?? ""} readOnly required /><Button type="button" variant="outline" onClick={() => {
              void platform.selectFile().then((path) => { if (path) update("privateKeyPath", path); }).catch(() => setError(t("pickerFailed")));
            }}>{t("choose")}</Button></div></Field> : null}
          {config.authType === "ssh_agent" ? <Field label={t("agentPath")}><Input value={config.agentPath ?? ""} onChange={(event) => update("agentPath", event.target.value || undefined)} /></Field> : null}
          {config.authType !== "ssh_agent" ? <>
            <Field label={t("secretAction")}><select className={SELECT_STYLE} value={secretIntent} onChange={(event) => { setSecretIntent(event.target.value as typeof secretIntent); setSecret(""); }}>
              {host ? <option value="keep">{t("secret.keep")}</option> : null}<option value="replace">{t("secret.replace")}</option><option value="clear">{t("secret.clear")}</option>
            </select></Field>
            {secretIntent === "replace" ? <Field label={t(config.authType === "password" ? "password" : "passphrase")}><Input type="password" value={secret}
              required={config.authType === "password"} maxLength={32768} autoComplete="new-password" spellCheck={false} onChange={(event) => setSecret(event.target.value)} /></Field> : null}
            <Field label={t("persistence")}><select className={SELECT_STYLE} value={config.secretPersistence} onChange={(event) => { update("secretPersistence", event.target.value as RemoteHostConfig["secretPersistence"]); setSecretIntent("replace"); setSecret(""); }}>
              <option value="session">{t("persistence.session")}</option><option value="os_protected" disabled={!capabilities?.secretStorage.available}>{t("persistence.os_protected")}</option>
            </select></Field>
          </> : null}
          <Field label={t("group")}><Input value={config.group} onChange={(event) => update("group", event.target.value)} /></Field>
          <Field label={t("tags")}><Input value={tagsText} onChange={(event) => setTagsText(event.target.value)} /></Field>
          <Field label={t("cwd")}><Input value={config.defaultCwd ?? ""} onChange={(event) => update("defaultCwd", event.target.value || undefined)} /></Field>
          <Field label={t("roots")}><Input value={rootsText} onChange={(event) => setRootsText(event.target.value)} /></Field>
        </div>
        <p className="text-ui-sm text-foreground-subtlest">{t("rootsHelp")}</p>
        {!capabilities?.secretStorage.available ? <p className="text-ui-sm text-foreground-subtlest">{t("sessionHelp")}</p> : null}
        {config.username === "root" || config.environment === "production" ? <p className="text-ui-sm text-destructive">{t("highPrivilege")}</p> : null}
        {error ? <p role="alert" className="break-words text-ui-base text-destructive">{error}</p> : null}
        <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={close}>{t("cancel")}</Button>
          <Button type="submit" disabled={saving}>{t(saving ? "saving" : "save")}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
