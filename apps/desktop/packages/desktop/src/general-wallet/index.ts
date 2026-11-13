import { startGeneralWalletUtility } from "./service.js";

const parent = process.parentPort;
if (!parent) throw new Error("The general wallet utility requires a private parent port.");
startGeneralWalletUtility(parent, () => process.exit(0));
