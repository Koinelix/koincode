import targets from "./tsup.config.js";

/** An explicit wallet-only build never gates the ordinary desktop watcher. */
export default Array.isArray(targets) ? targets.filter((target) => target.name === "wallet") : targets;
