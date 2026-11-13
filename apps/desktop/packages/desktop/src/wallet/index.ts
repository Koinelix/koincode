import { startWalletService } from "./service.js";
const parent = process.parentPort;
if (!parent) throw new Error("The wallet service requires a private parent port.");
startWalletService(parent);
