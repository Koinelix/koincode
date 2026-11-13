# Koinelix Skill snapshot

`skills/koinelix` is a reviewable snapshot of the independently maintained Koinelix Skill. Desktop staging verifies every file against `snapshot.json`. The Python image client saves Base64 responses without a native decoder or Go build. The manifest identifies content; it does not authenticate an untrusted source or grant payment permission.

Generate a new snapshot in a new, empty path for review:

```sh
node packages/desktop/scripts/create-koinelix-snapshot.mjs /absolute/path/to/independent/skills/koinelix /absolute/path/to/new-snapshot
```

Review the generated files and update the checked-in snapshot together with the staging tests. Staging does not access a separate checkout or download assets.
