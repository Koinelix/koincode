/** Persist compiled workflow entries without expanding child-process command lines. */
import { closeSync, constants, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export interface HarnessWarning {
  kind: "entry_file_fallback";
  /** Preferred destination; the historical field name is retained for callers. */
  projectDir: string;
  fallbackDir: string;
  error: string;
}

export interface WriteChildEntryFileInput {
  cwd: string;
  runId: string;
  source: string;
  /** Trusted host destination. Product policy stays outside this app-free library. */
  entryDirectory?: string;
  onWarning?: (warning: HarnessWarning) => void;
}

export interface ChildEntryFile {
  path: string;
  location: "project" | "profile" | "tmpdir";
}

export function workflowRunsDir(cwd: string, entryDirectory?: string): string {
  if (entryDirectory !== undefined && (!isAbsolute(entryDirectory) || resolve(entryDirectory) === parse(resolve(entryDirectory)).root)) {
    throw new Error("The workflow entry directory must be absolute.");
  }
  return entryDirectory ?? join(cwd, ".koincode", "workflow-runs");
}

export function fallbackWorkflowRunsDir(entryDirectory?: string): string {
  return entryDirectory
    ? join(dirname(entryDirectory), "workflow-runs-fallback")
    : join(tmpdir(), "koincode-workflow-runs");
}

export function childEntryFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.mjs`;
}

export function writeChildEntryFile(input: WriteChildEntryFileInput): ChildEntryFile {
  const projectDir = workflowRunsDir(input.cwd, input.entryDirectory);
  const fileName = childEntryFileName(input.runId);
  try {
    return { path: writeInto(projectDir, fileName, input.source, input.entryDirectory !== undefined),
      location: input.entryDirectory ? "profile" : "project" };
  } catch (error) {
    const fallbackDir = fallbackWorkflowRunsDir(input.entryDirectory);
    input.onWarning?.({ kind: "entry_file_fallback", projectDir, fallbackDir,
      error: error instanceof Error ? error.message : String(error) });
    return { path: writeInto(fallbackDir, fileName, input.source, input.entryDirectory !== undefined),
      location: input.entryDirectory ? "profile" : "tmpdir" };
  }
}

function prepareTrustedEntryDirectory(directory: string): void {
  const path = resolve(directory), root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
      info = lstatSync(current);
    }
    const trustedOwner = typeof process.getuid !== "function" || info.uid === 0 || info.uid === process.getuid();
    const trustedMode = typeof process.getuid !== "function" || (info.mode & 0o022) === 0 ||
      ((info.mode & 0o1000) !== 0 && info.uid === 0);
    if (!info.isDirectory() || info.isSymbolicLink() || !trustedOwner || !trustedMode) {
      throw new Error("The trusted workflow entry directory has an unsafe ancestor.");
    }
  }
}

function writeInto(dir: string, fileName: string, source: string, trusted: boolean): string {
  if (trusted) prepareTrustedEntryDirectory(dir);
  else mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  }
  const path = join(dir, fileName);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Workflow entries must be regular files.");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try { writeFileSync(fd, source, "utf8"); } finally { closeSync(fd); }
  return path;
}
