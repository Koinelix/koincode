# KoinCode brand assets

The KC ligature uses forest teal `#064D46` and ivory `#FFF6E6`. Edit `koincode-icon.svg` for the application mark, `koincode-logo.svg` for the horizontal banner, and `koincode-dmg.svg` for the installer background. Banner text is outlined; no font files are required.

From `apps/desktop`:

```sh
pnpm branding:sync
pnpm branding:assets:check
pnpm test:branding
```

Author native exports on macOS using system `sips` and `iconutil`. Synchronization updates PNG, ICNS and ICO files, renderer copies, inline startup/About drawings and `koincode-assets.json`. The read-only check runs on every supported platform and fails on stale or missing resources. Application builds use checked-in exports.

The `fcode-icon.svg` and `fcode-logo.svg` files are compatibility copies of the KoinCode artwork. Change the canonical files and synchronize instead of editing copies. Actual upstream service names and legal attributions are independent of the product's visual identity.
