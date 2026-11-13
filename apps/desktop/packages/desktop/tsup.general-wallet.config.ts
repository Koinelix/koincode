import targets from "./tsup.config.js";

/** New wallet assets are built separately from the legacy wallet and ordinary watcher. */
export default Array.isArray(targets) ? targets.filter((target) => target.name === "general-wallet") : targets;
