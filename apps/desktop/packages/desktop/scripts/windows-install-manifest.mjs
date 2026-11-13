import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const WINDOWS_INSTALL_MANIFEST_NAME = ".koincode-install-manifest";

export async function writeWindowsInstallManifest(context) {
  if (context.electronPlatformName !== "win32") return;
  const root = context.appOutDir;
  const files = [];
  const visit = async (directory, relativeDirectory = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relativePath.toLowerCase() === WINDOWS_INSTALL_MANIFEST_NAME) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relativePath.replaceAll("/", "\\"));
      }
    }
  };
  await visit(root);
  files.sort();
  await writeFile(join(root, WINDOWS_INSTALL_MANIFEST_NAME), `${files.join("\r\n")}\r\n`, "utf8");
}
