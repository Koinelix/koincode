import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const PROTECTED_SQLITE_SOURCE_ID = "2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76";
const hashes = { "sqlite3.c": "e2b869d3003b33c942b7dd7063604fbc53553e1b66609570df39b9b7b558ee81", "sqlite3.h": "15ef3f5dbc4a7a980f828fa0d1e473cee5a124e7bb77e9bc70fc0bfa3f9a2af8" };
export function verifyProtectedSqliteSource(directory) {
  if (createHash("sha256").update(readFileSync(join(directory, "source.json"))).digest("hex") !== "6f28a8aea5141312043cbe94f7e5fdc382446dd75401f0da07fd2e58601ea01b") throw new Error("GENERAL_PROTECTED_SQLITE_MANIFEST_INVALID");
  for (const [name, hash] of Object.entries(hashes)) {
    const bytes = readFileSync(join(directory, name));
    if (createHash("sha3-256").update(bytes).digest("hex") !== hash) throw new Error("GENERAL_PROTECTED_SQLITE_SOURCE_INVALID");
  }
  const source = readFileSync(join(directory, "sqlite3.h"), "utf8");
  if (!source.includes(`#define SQLITE_VERSION        "3.54.1"`) || !source.includes(PROTECTED_SQLITE_SOURCE_ID)) throw new Error("GENERAL_PROTECTED_SQLITE_VERSION_INVALID");
}
export function buildProtectedSqlite() {
  if (process.platform !== "darwin") throw new Error("The protected SQLite bridge currently requires macOS.");
  const source = fileURLToPath(new URL("../native/general-protection/", import.meta.url));
  const sqlite = join(source, "sqlite", "3.54.1"); verifyProtectedSqliteSource(sqlite);
  const output = fileURLToPath(new URL("../../../.tmp/general-protected-sqlite/", import.meta.url)); mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(join(output, "build-")), library = join(temporary, "libgeneral-protected-sqlite.a");
  const flags = ["-O2", "-fvisibility=hidden", "-DSQLITE_THREADSAFE=1", "-DSQLITE_DQS=0", "-DSQLITE_OMIT_LOAD_EXTENSION=1", "-DSQLITE_USE_URI=0"];
  const options = { timeout: 30000, stdio: "pipe", env: { PATH: "/usr/bin:/bin" } };
  try {
    const engine = join(temporary, "sqlite3.o"), files = join(temporary, "repository-files.o");
    execFileSync("/usr/bin/clang", [...flags, "-c", join(sqlite, "sqlite3.c"), "-o", engine], options);
    execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", "-O2", "-fvisibility=hidden", "-c", join(source, "repository-files.c"), "-o", files], options);
    const objects = [engine, files];
    for (const name of ["repository-vfs", "repository-pair", "repository-sql"]) {
      const object = join(temporary, `${name}.o`);
      execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", "-O2", "-fvisibility=hidden", "-c", join(source, `${name}.c`), "-o", object], options);
      objects.push(object);
    }
    execFileSync("/usr/bin/ar", ["rcs", library, ...objects], options);
    const probe = join(temporary, "verify.c"), executable = join(temporary, "verify");
    writeFileSync(probe, `#include "sqlite3.h"\n#include <string.h>\n_Static_assert(SQLITE_USE_URI==0 && SQLITE_THREADSAFE==1 && SQLITE_DQS==0 && SQLITE_OMIT_LOAD_EXTENSION==1,"Pinned compile options");\nint main(void) { return sqlite3_libversion_number()!=3054001 || strcmp(sqlite3_sourceid(),"${PROTECTED_SQLITE_SOURCE_ID}") || !sqlite3_compileoption_used("THREADSAFE=1") || !sqlite3_compileoption_used("DQS=0") || !sqlite3_compileoption_used("OMIT_LOAD_EXTENSION") || !sqlite3_compileoption_used("USE_URI"); }\n`);
    execFileSync("/usr/bin/clang", [...flags, "-I", sqlite, probe, library, "-o", executable], options); execFileSync(executable, [], options);
    const symbols = execFileSync("/usr/bin/nm", ["-m", engine], { ...options, encoding: "utf8" });
    if (!symbols.includes("private external _sqlite3_open") || symbols.split("\n").some((line) => / external _sqlite3_/.test(line) && !line.includes("private external")))
      throw new Error("GENERAL_PROTECTED_SQLITE_VISIBILITY_INVALID");
    renameSync(library, join(output, "libgeneral-protected-sqlite.a"));
    writeFileSync(join(output, "source.json"), readFileSync(join(sqlite, "source.json")));
    writeFileSync(join(output, "THIRD_PARTY_NOTICES.md"), readFileSync(join(source, "THIRD_PARTY_NOTICES.md")));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  process.stdout.write("Private protected-Host SQLite 3.54.1 source, compile options and hidden symbols verified. No installation, default SQLite change or secret admission performed.\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildProtectedSqlite();
