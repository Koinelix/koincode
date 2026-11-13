import { createHash } from "node:crypto";
import { access, cp, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

const manifestName = "snapshot.json";
const required = ["SKILL.md", "LICENSE", "scripts/generate_image.py", "scripts/image_config.py",
  "scripts/configure_image.py", "scripts/wallet_client.py", "scripts/response_privacy.py",
  "scripts/image_result.py",
  "references/images-api.md", "references/openapi.yaml", "references/wallet-compatibility.md",
  "references/x402-and-recovery.md"];

async function entries(root, path = root) {
  const result = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    const full = join(path, item.name);
    if (item.isDirectory()) result.push(...await entries(root, full));
    else if (item.isFile()) result.push(relative(root, full).split(sep).join("/"));
    else throw new Error(`Koinelix snapshot contains a non-regular entry: ${full}`);
  }
  return result.sort();
}

export async function verifyKoinelixSnapshot(root) {
  const info = await lstat(join(root, manifestName));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new Error("Invalid Koinelix snapshot manifest");
  const manifest = JSON.parse(await readFile(join(root, manifestName), "utf8"));
  if (manifest.version !== 1 || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== "object")
    throw new Error("Invalid Koinelix snapshot manifest");
  const files = (await entries(root)).filter((path) => path !== manifestName);
  const expected = Object.keys(manifest.files).sort();
  if (required.some((path) => !files.includes(path)) || JSON.stringify(files) !== JSON.stringify(expected))
    throw new Error("Koinelix snapshot asset list does not match its manifest");
  for (const path of files) {
    if (path.split("/").some((part) => ["dist", "__pycache__", ".git", "node_modules"].includes(part)))
      throw new Error(`Unexpected generated file in Koinelix snapshot: ${path}`);
    if (path.endsWith(".go") || /(?:^|\/)(?:go\.mod|go\.sum|vendor)(?:\/|$)/.test(path))
      throw new Error(`Unexpected Go source in Koinelix snapshot: ${path}`);
    const hash = createHash("sha256").update(await readFile(join(root, ...path.split("/")))).digest("hex");
    if (manifest.files[path] !== hash) throw new Error(`Koinelix snapshot hash mismatch: ${path}`);
  }
  return manifest;
}

// Desktop dev and packaged builds both call this after stageAgentBundle clears glm.
export async function stageBundledSkillPack({ repoRoot, glmDir }) {
  const sourceRoot = resolve(repoRoot, "apps/kcode-cli/packages/bundled-skills");
  const targetRoot = resolve(glmDir, "packages/bundled-skills");
  await verifyKoinelixSnapshot(resolve(sourceRoot, "skills/koinelix"));
  await mkdir(targetRoot, { recursive: true });
  await cp(resolve(sourceRoot, "skills"), resolve(targetRoot, "skills"), {
    recursive: true,
    filter: (path) => ![".DS_Store", ".venv", "__pycache__", "node_modules"].includes(basename(path)) &&
      !path.endsWith(".pyc"),
  });
  for (const path of ["skills/dynamic-workflows/SKILL.md", "skills/dynamic-workflows/patterns.md", "skills/dynamic-workflows/examples.md"]) {
    await access(resolve(targetRoot, path));
  }
  const stagedSkill = resolve(targetRoot, "skills/koinelix");
  await verifyKoinelixSnapshot(stagedSkill);
}
