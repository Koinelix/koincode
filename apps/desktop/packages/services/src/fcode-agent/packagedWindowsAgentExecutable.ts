import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

/** Keep Node execution separate from the Windows GUI image admitted by Native. */
export function resolvePackagedWindowsAgentExecutable(options: {
  platform: string; executable: string; bundlePath: string;
}): string {
  if (options.platform !== "win32") return options.executable;
  const root = dirname(options.executable);
  const bundleRelative = relative(join(root, "resources"), options.bundlePath);
  if (bundleRelative.startsWith("..") || isAbsolute(bundleRelative)) return options.executable;
  const runtime = join(root, "fcode-agent-runtime.exe");
  if (!existsSync(runtime)) throw new Error("The packaged Windows Agent runtime is missing. Reinstall FCode.");
  return runtime;
}
