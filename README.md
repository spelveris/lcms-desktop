# LCMS Desktop

Desktop LC-MS analysis app built with Electron (frontend shell) and a packaged FastAPI backend.

## Downloads

Get installers from GitHub Releases.

`<version>` means the numeric release version (for example `0.2.2` for tag `v0.2.2`).

| Platform | File | Description |
| --- | --- | --- |
| Windows | `LCMS.Desktop.Setup.<version>.exe` | Installer (recommended) |
| Windows | `LCMS.Desktop-<version>-win.zip` | Portable (no install) |
| Windows | `LCMS.Desktop.<version>.exe` | Portable executable |
| macOS (Apple Silicon) | `LCMS.Desktop-<version>-arm64.dmg` | Disk image (recommended) |
| macOS (Apple Silicon) | `LCMS.Desktop-<version>-arm64-mac.zip` | Zip archive |

### macOS First-Run (if Gatekeeper blocks launch)

If macOS shows "app is damaged" or blocks launch after download, run:

```bash
xattr -dr com.apple.quarantine "/Applications/LCMS Desktop.app"
codesign --force --deep --sign - "/Applications/LCMS Desktop.app"
open "/Applications/LCMS Desktop.app"
```

## Run In Dev Mode

```bash
cd /Users/dspelveris/lcms-desktop
./start-dev.sh
```

In another terminal for full Electron UI:

```bash
cd /Users/dspelveris/lcms-desktop
npm start
```

## Build

```bash
npm run dist:mac
npm run dist:win
```

## Notes

- The backend health endpoint is `http://127.0.0.1:8741/api/health`.
- Release assets are produced by `.github/workflows/build-desktop.yml`.
