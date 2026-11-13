import { closeSync, constants, fchmodSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface PublishFile {
  mode?: number;
  path: string;
}

export interface RemoteHostPublishIO {
  makeDirectory(path: string): void;
  readFile(path: string): Buffer;
  writeExclusive(path: string, bytes: Buffer, mode: number): void;
}

export const remoteHostPublishIO: RemoteHostPublishIO = {
  makeDirectory(path) { mkdirSync(path); },
  readFile(path) { return readFileSync(path); },
  writeExclusive(path, bytes, mode) {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode);
    try {
      writeFileSync(fd, bytes);
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
  },
};

/** Publish without replacing any path; an incomplete target is deliberately preserved. */
export function publishRemoteHostSeed(input: {
  files: readonly PublishFile[];
  marker: string;
  targetRoot: string;
  temporaryRoot: string;
  io?: RemoteHostPublishIO;
}): void {
  const io = input.io ?? remoteHostPublishIO;
  io.makeDirectory(input.targetRoot);
  const createdDirectories = new Set<string>();
  for (const file of input.files) {
    const segments = file.path.split("/");
    if (segments.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
      throw new Error("Remote Host seed contains an invalid relative path.");
    }
    const destination = join(input.targetRoot, ...segments);
    const directory = dirname(destination);
    const directories: string[] = [];
    for (let current = directory; current !== input.targetRoot && !createdDirectories.has(current); current = dirname(current)) {
      directories.unshift(current);
    }
    for (const path of directories) {
      io.makeDirectory(path);
      createdDirectories.add(path);
    }
    io.writeExclusive(destination, io.readFile(join(input.temporaryRoot, ...segments)), file.mode ?? 0o644);
  }
  io.writeExclusive(join(input.targetRoot, input.marker), io.readFile(join(input.temporaryRoot, input.marker)), 0o644);
}
