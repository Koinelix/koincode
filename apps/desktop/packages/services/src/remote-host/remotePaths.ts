import { posix } from "node:path";
import { RemoteHostError, remotePathSchema, type RemoteHostRecord, type RemoteSftpPort } from "@fcode/shared";

export function remotePathInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

/** SFTP path validation is a client guard; the SSH account remains the isolation boundary. */
export class RemotePathGuard {
  private constructor(readonly home: string, readonly roots: string[], private readonly files: RemoteSftpPort) {}

  static async create(host: RemoteHostRecord, files: RemoteSftpPort): Promise<RemotePathGuard> {
    const home = await files.realpath(".");
    if (!posix.isAbsolute(home)) throw new RemoteHostError("path_not_allowed", "The server returned an invalid home directory.");
    const roots: string[] = [];
    for (const root of host.config.fileRoots.length ? host.config.fileRoots : [home]) {
      const actual = await files.realpath(root);
      if (!posix.isAbsolute(actual) || (await files.stat(actual))?.type !== "directory") {
        throw new RemoteHostError("path_not_allowed", "An allowed remote root is not a directory.");
      }
      roots.push(posix.normalize(actual));
    }
    return new RemotePathGuard(posix.normalize(home), roots, files);
  }

  async resolve(input: string, options: { allowMissing?: boolean; siblingRequired?: boolean } = {}): Promise<string> {
    remotePathSchema.parse(input);
    const path = posix.resolve(this.home, input);
    if (!this.roots.some((root) => remotePathInside(root, path))) {
      throw new RemoteHostError("path_not_allowed", "The remote path is outside the allowed file roots.");
    }
    const segments = path.split("/").filter(Boolean);
    let current = "/";
    let missing = false;
    for (const segment of segments) {
      current = posix.join(current, segment);
      if (missing) continue;
      const info = await this.files.stat(current);
      if (!info) { missing = true; continue; }
      if (info.type === "symlink" || info.type === "special") {
        throw new RemoteHostError("path_not_allowed", "Links and special files cannot be used by structured remote tools.");
      }
      if (current !== path && info.type !== "directory") throw new RemoteHostError("path_not_allowed", "A remote parent is not a directory.");
      const actual = await this.files.realpath(current);
      if (posix.normalize(actual) !== current) throw new RemoteHostError("path_not_allowed", "The remote path resolved through a link.");
    }
    if (missing && !options.allowMissing) throw new RemoteHostError("path_not_allowed", "The remote path does not exist.");
    if (options.siblingRequired && !this.roots.some((root) => remotePathInside(root, posix.dirname(path)))) {
      throw new RemoteHostError("path_not_allowed", "Temporary and backup paths must remain inside an allowed root.");
    }
    return path;
  }
}
