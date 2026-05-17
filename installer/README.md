# GM-Puppeteer Windows installer

A self-contained, per-user Windows installer built with [Inno Setup]. It
bundles a Node 24 runtime, the prebuilt `dist/`, production `node_modules`, and
Chromium, so the target machine needs nothing preinstalled. The compiled
`.exe` is roughly **250–300 MB** (most of it Chromium).

[Inno Setup]: https://jrsoftware.org/isinfo.php

## Layout

| File | Purpose |
| --- | --- |
| `gm-puppeteer.iss` | Main Inno Setup script — `[Setup]`, `[Files]`, `[Code]`. |
| `scripts/envpage.pas` | Custom wizard pages for the 12 environment settings; writes `.env`. |
| `scripts/clients.pas` | MCP client detection and config merge/removal. |
| `merge-mcp.mjs` | Node helper: safe JSON merge/backup/remove for file-based clients. Bundled and run by the installer. |
| `templates/env.template` | Documents the `.env` shape (not consumed at install time). |
| `assets/gm-puppeteer.ico` | Optional installer/app icon — wired in via `#ifexist` if present. |

## How it is built in CI

`.github/workflows/build-installer.yml` runs on `windows-latest`:

1. `npm ci`, `npm run build`, `npm test`.
2. Stage a payload tree under `staging/`: `dist/`, production `node_modules`
   (`npm ci --omit=dev --ignore-scripts`), the official Node 24 Windows zip,
   and Chromium (`npx puppeteer browsers install chrome`, cached).
3. `choco install innosetup`, then compile with `ISCC.exe`.
4. Upload the `.exe` artifact on every push to `main`; publish a GitHub
   Release on `v*` tags.

## Building locally

On Windows, with [Inno Setup 6] installed and Node 24 on `PATH`:

```powershell
# from the repo root
npm ci
npm run build

# assemble the staging tree the .iss expects
mkdir staging
xcopy /E /I dist staging\dist
copy package.json staging\ ; copy package-lock.json staging\
cd staging ; npm ci --omit=dev --ignore-scripts ; cd ..
# extract a node-vX.Y.Z-win-x64 zip into staging\node
# install Chromium: set PUPPETEER_CACHE_DIR=<repo>\staging\chromium
#   then run: npx puppeteer browsers install chrome

# compile (point ChromeDir at the folder containing chrome.exe)
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" `
  /DAppVersion=0.0.0-local `
  /DChromeDir=<repo>\staging\chromium\chrome\win64-<rev>\chrome-win64 `
  installer\gm-puppeteer.iss
```

The compiled installer lands in `installer/Output/`.

[Inno Setup 6]: https://jrsoftware.org/isdl.php

## Notes & caveats

- **Unsigned.** Windows SmartScreen warns on first run. Code signing is out of
  scope; a `signtool` step can be added to the workflow before artifact upload.
- **`.env` holds the Foundry GM password in plaintext.** It lives in the
  ACL-restricted per-user `%LOCALAPPDATA%` install directory.
- **Client config merges are non-destructive.** `merge-mcp.mjs` writes a
  timestamped `.gm-puppeteer-backup-<ts>` copy and refuses to touch a config
  file that is not valid JSON.
- **Uninstall** removes only the `gm-puppeteer` entry from each configured
  client (siblings preserved) and offers to keep `.env` /
  `.puppeteer-profile` by copying them to `%LOCALAPPDATA%\gm-puppeteer-saved`.
