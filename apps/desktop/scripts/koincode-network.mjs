import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Paired payment network and Koinelix endpoint, chosen at launch and fixed at build time. */
const repositoryRoot = resolve(import.meta.dirname, "..");
export const NETWORK_NAMES = Object.freeze(["testnet", "mainnet"]);
const PROFILE_FILE = "config/network.json";
const SELECTION_FILE = "config/network.selected";
const LOCAL_ORIGIN = "http://127.0.0.1:8080";

function fail(message) {
  throw new Error(`Invalid KoinCode network configuration: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  if (actual.join() !== [...keys].sort().join()) fail(`${label} must contain exactly ${keys.join(", ")}.`);
}

function endpoint(value, name) {
  let url;
  try { url = new URL(value); } catch { fail(`${name}.llmBaseUrl is not a URL.`); }
  if (typeof value !== "string" || url.href !== value || url.username || url.password || url.search || url.hash)
    fail(`${name}.llmBaseUrl must be a plain canonical URL.`);
  const local = url.origin === LOCAL_ORIGIN;
  const remote = url.protocol === "https:" && !url.port;
  if (name === "testnet" ? !local : !remote)
    fail(name === "testnet" ? `testnet must use ${LOCAL_ORIGIN}.` : "mainnet must use https on the default port.");
  return value;
}

export function parseNetworkProfiles(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { fail(`${PROFILE_FILE} is not JSON.`); }
  exactKeys(raw, NETWORK_NAMES, PROFILE_FILE);
  const profiles = {};
  for (const name of NETWORK_NAMES) {
    exactKeys(raw[name], ["x402Mainnet", "llmBaseUrl"], name);
    if (raw[name].x402Mainnet !== (name === "mainnet")) fail(`${name}.x402Mainnet must be ${name === "mainnet"}.`);
    profiles[name] = Object.freeze({ x402Mainnet: raw[name].x402Mainnet, llmBaseUrl: endpoint(raw[name].llmBaseUrl, name) });
  }
  return Object.freeze(profiles);
}

export function readNetworkSelection(root = repositoryRoot) {
  let text;
  try { text = readFileSync(resolve(root, SELECTION_FILE), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const name = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!NETWORK_NAMES.includes(name)) fail(`${SELECTION_FILE} must contain testnet or mainnet.`);
  return name;
}

export function writeNetworkSelection(name, root = repositoryRoot) {
  if (!NETWORK_NAMES.includes(name)) fail("the selected network must be testnet or mainnet.");
  writeFileSync(resolve(root, SELECTION_FILE), `${name}\n`, "utf8");
}

export function loadNetworkProfiles(root = repositoryRoot) {
  return parseNetworkProfiles(readFileSync(resolve(root, PROFILE_FILE), "utf8"));
}

/** Production builds are always mainnet and never read the selection; other builds default to testnet. */
export function resolveKoincodeNetwork({ root = repositoryRoot, env = process.env } = {}) {
  const profiles = loadNetworkProfiles(root);
  const name = env.NODE_ENV === "production" ? "mainnet" : readNetworkSelection(root) ?? "testnet";
  return Object.freeze({ name, ...profiles[name] });
}
