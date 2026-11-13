#!/usr/bin/env node
// Export a reviewable snapshot from an explicit Skill source. Never runs as part
// of an application build, never modifies the source or an existing snapshot.
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const files = ["SKILL.md", "LICENSE", "references/images-api.md", "references/openapi.yaml",
  "references/wallet-compatibility.md", "references/x402-and-recovery.md",
  "references/reference-host.md", "scripts/reference_host.py",
  "scripts/request_options.py", "scripts/request_store.py", "scripts/configure_image.py",
  "scripts/generate_image.py", "scripts/image_config.py", "scripts/image_result.py",
  "scripts/response_privacy.py", "scripts/wallet_client.py"];
async function list(root, dir = root) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await list(root, full));
    else if (entry.isFile()) result.push(relative(root, full).split(sep).join("/"));
    else throw new Error(`Snapshot contains non-regular entry: ${full}`);
  }
  return result.sort();
}

const [source, output, ...rest] = process.argv.slice(2);
if (!source || !output || rest.length || ![source, output].every(isAbsolute))
  throw new Error("Usage: create-koinelix-snapshot.mjs <absolute-skill-source> <new-absolute-output>");
await mkdir(output, { recursive: false }); // Fails instead of overwriting an existing snapshot.
for (const name of files) {
  const input = join(source, ...name.split("/"));
  const info = await lstat(input);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not a regular source file: ${input}`);
  const target = join(output, ...name.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await cp(input, target, { force: false, errorOnExist: true });
}

const digest = {};
for (const name of await list(output)) digest[name] = createHash("sha256").update(await readFile(join(output, ...name.split("/")))).digest("hex");
await writeFile(join(output, "snapshot.json"), JSON.stringify({ version: 1, files: digest }, null, 2) + "\n", { flag: "wx" });
process.stdout.write(`Prepared ${Object.keys(digest).length} files for review at ${output}\n`);
