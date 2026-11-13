# Protected Host private SQLite

SQLite 3.54.1 is public-domain software. The original copyright disclaimer and
license notice are preserved at the start of `sqlite/3.54.1/sqlite3.c` and
`sqlite3.h`. SQLite is not the author of the KoinCode-specific adapters.

Upstream: https://www.sqlite.org/
Release: https://www.sqlite.org/releaselog/3_54_1.html
Source archive: https://www.sqlite.org/2026/sqlite-amalgamation-3540100.zip
The exact archive and source hashes are recorded in `sqlite/3.54.1/source.json`.

This source is compiled only for the protected Host's private native bridge.
It does not replace Node, Electron, the broker metadata journal, or Skill SQLite.
The final signed bridge package must preserve these notices and verify the
approved version, source hashes, build options and exported-symbol boundary.
This static development artifact is not a signed or installed native bridge.
