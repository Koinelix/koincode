import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Wallet builds are release requirements, but they must not gate the ordinary desktop watcher. */
export function selectDesktopBuildTargets(targets, args) {
  const watch = args.some((arg) => arg === "--watch" || arg.startsWith("--watch="));
  return watch ? targets.filter((target) => target.name !== "wallet" && target.name !== "general-wallet") : targets;
}

export function desktopDevBuildState(root, exists = existsSync) {
  const missingMarkers = ["main", "host", "preload"].filter(
    (name) => !exists(resolve(root, `out/.${name}-build-ready`)),
  );
  return { missingMarkers, hasMainBundle: exists(resolve(root, "out/main/index.js")) };
}
