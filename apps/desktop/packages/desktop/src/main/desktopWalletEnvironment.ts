import { delimiter, join } from "node:path";

/** Native wallet processes receive only the system paths needed on this OS. */
export function desktopWalletEnvironment(home: string, environment = process.env): Record<string, string> {
  if (process.platform !== "win32") return {
    HOME: home, PATH: "/usr/bin:/bin", ...(environment.TMPDIR ? { TMPDIR: environment.TMPDIR } : {}),
    ...(environment.LANG ? { LANG: environment.LANG } : {}),
  };
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot) throw new Error("The Windows system directory is unavailable.");
  return {
    HOME: home, USERPROFILE: home, SystemRoot: systemRoot, WINDIR: systemRoot,
    PATH: [join(systemRoot, "System32"), systemRoot].join(delimiter),
    ...(environment.APPDATA ? { APPDATA: environment.APPDATA } : {}),
    ...(environment.LOCALAPPDATA ? { LOCALAPPDATA: environment.LOCALAPPDATA } : {}),
    ...(environment.TEMP ? { TEMP: environment.TEMP } : {}), ...(environment.TMP ? { TMP: environment.TMP } : {}),
  };
}
