# LCMS Desktop

Desktop LC-MS analysis app built with Electron (frontend shell) and a packaged FastAPI backend.

## Download

Get installers from GitHub Releases:

- macOS (Apple Silicon): `LCMS.Desktop-*-arm64.dmg`
- Windows installer: `LCMS.Desktop.Setup.*.exe`
- Windows portable: `LCMS.Desktop.*.exe`

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
