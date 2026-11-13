import { readFile, writeFile } from "node:fs/promises";

const marker = "; fcode-manifest-upgrade-v1";

export function patchNsisInstallUtilSource(source) {
  if (source.includes(marker)) return source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let result = source.replaceAll("\r\n", "\n");
  const prepareAnchor = '  StrCpy $uninstallerFileNameTemp "$PLUGINSDIR\\old-uninstaller.exe"';
  const errorAnchor = '      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY OneMoreAttempt';
  for (const anchor of [prepareAnchor, errorAnchor]) {
    if (!result.includes(anchor)) throw new Error("NSIS missing previous-uninstaller anchor");
  }
  result = result.replace(prepareAnchor, [
    "  !ifmacrodef customPreparePreviousUninstaller",
    "    !insertmacro customPreparePreviousUninstaller",
    "  !endif",
    prepareAnchor,
  ].join("\n"));
  result = result.replace(errorAnchor, [
    "      !ifmacrodef customUnInstallCheck",
    "        ClearErrors",
    "        Return",
    "      !else",
    errorAnchor,
    "      !endif",
  ].join("\n"));
  const retryLabel = "  OneMoreAttempt:";
  if (!result.includes(retryLabel)) throw new Error("NSIS missing previous-uninstaller retry label");
  result = result.replace(retryLabel, [
    "  !ifmacrodef customUnInstallCheck",
    "  !else",
    retryLabel,
    "  !endif",
  ].join("\n"));
  return `${marker}\n${result}`.replaceAll("\n", eol);
}

export async function patchNsisInstallUtilFile(path) {
  const source = await readFile(path, "utf8");
  const patched = patchNsisInstallUtilSource(source);
  if (patched === source) return { changed: false, originalSource: null };
  await writeFile(path, patched, "utf8");
  return { changed: true, originalSource: source };
}
