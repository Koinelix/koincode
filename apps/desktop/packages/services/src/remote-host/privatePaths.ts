import { chmod, mkdir, lstat } from "node:fs/promises";
import { RemoteHostError } from "@fcode/shared";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export async function protectRemoteHostPath(filePath: string, directory: boolean): Promise<void> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new RemoteHostError("permission_denied", "The private storage path is not a regular owned entry.", "storage");
  if (process.platform !== "win32") {
    await chmod(filePath, directory ? DIRECTORY_MODE : FILE_MODE);
    return;
  }
  if (!directory && info.nlink !== 1) throw new RemoteHostError("permission_denied", "The private Windows file has multiple links.", "storage");
  try {
    const { verifyWindowsRemoteHostPrivatePath } = await import("./windowsSecurity.js");
    await verifyWindowsRemoteHostPrivatePath(filePath, directory);
  } catch { throw new RemoteHostError("permission_denied", "The private Windows storage ACL could not be verified.", "storage"); }
}

export async function createRemoteHostPrivateDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") {
    const { createWindowsRemoteHostPrivateDirectory } = await import("./windowsSecurity.js");
    await createWindowsRemoteHostPrivateDirectory(directoryPath); return;
  }
  await mkdir(directoryPath, { recursive: true, mode: DIRECTORY_MODE });
  await protectRemoteHostPath(directoryPath, true);
}
