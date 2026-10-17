# Automatic updates for the Mac app (design)

Approved 17 Oct 2026. The app is not signed with an Apple Developer ID, so Electron's built-in updater
(Squirrel.Mac, which demands a Developer ID signature) can't be used. Studio updates itself instead, and
every release is stamped with our own Ed25519 key so nobody who controls the website or GitHub can push code.

## Behaviour

- **Check:** 2 minutes after the app starts, then every 4 hours, and on "Check now". Source:
  `https://studio-cli.cantivia.com/downloads.json` (version + stamps); file: `/download/<arch>` (the site's
  cached DMG). `STUDIO_UPDATE_URL` overrides the site (tests).
- **Download** quietly to `<userData>/updates/`, then verify (below). Unpack: `hdiutil attach -nobrowse
  -readonly -noautoopen -noverify` to a temp mount point, `ditto` the `.app` to `<userData>/updates/next.app`,
  detach. Check the staged app's bundle id (`com.cantivia.studio-cli`) and version match, `codesign --verify
  --deep --strict` passes, and strip `com.apple.quarantine`.
- **Wait until quiet:** no Claude busy for 2 minutes and no typing (any device, or `/send`) for 5 minutes.
  The server tracks both times; the app asks it every 30 s once an update is staged.
- **Install:** rename the running bundle to `<userData>/updates/previous.app`, rename `next.app` into its place
  (copy with `ditto` if they're on different volumes), write `<userData>/updates/pending.json`
  `{from, to, hidden, at}`, start a detached watchdog, stop the server, wait for it to exit, `app.relaunch()`.
  The pty host is detached, so terminals keep running. If the window was hidden, the new version starts hidden.
- **Confirm:** the new version, once its server answers, deletes `pending.json` and `previous.app` and posts a
  notification "Studio updated to X". If the port is still taken at start and `pending.json` is under
  2 minutes old, it waits up to 15 s for the old server to go away instead of failing.
- **Rollback:** the watchdog (`/bin/sh`, detached) waits 120 s; if `pending.json` still exists, it moves the
  new bundle aside, puts `previous.app` back and reopens it.
- **Won't update** when the app runs from a disk image, from App Translocation, or from a folder it can't
  write: status says "Move Studio CLI to Applications to get updates".
- **Settings → Updates:** version, what the updater is doing, "Update automatically" (on by default),
  "Check now", and "Update now" when an update is ready (skips the quiet wait).
- In `npm run dev` (no Mac app) Settings says updates come with the Mac app.

## Stamp (signature)

- Message: `studio-cli-update\n<version>\n<arch>\n<sha256 of the DMG, hex>`, signed with Ed25519.
  Binding version and chip stops an old or wrong file being passed off as new.
- `site/downloads.json` gains `"sig": { "arm64": "<base64>", "x64": "<base64>" }`.
- Public key (SPKI DER, base64) is a constant in `electron/updater.cjs`. `STUDIO_UPDATE_PUBKEY` overrides it
  (tests only; whoever can set the app's environment already controls it).
- Private key: `~/.studio-cli-release/update-signing-key.pem`, mode 0600, created by `npm run release:key`.
  Back it up; losing it means one more manual install for everyone.
- Only a version strictly newer than the running one is installed.

## Pieces

| File | Job |
| --- | --- |
| `electron/updater.cjs` (new) | check, download, verify, stage, wait, install, confirm, watchdog |
| `electron/main.cjs` | start the updater; `--start-hidden`; wait for the port after an update; separate userData when `STUDIO_DATA_DIR` is set, so test copies never share the real app's single-instance lock |
| `server/updates.ts` (new) | quiet times, the app's last status report, the "automatic" preference (`updates.json`), check/install requests |
| `server/index.ts`, `server/terminals.ts` | register routes; record typing and Claude busy times |
| `src/components/SettingsMenu.tsx` | Updates section |
| `scripts/release.mjs` (new), `package.json` | `npm run release`: build, stamp, GitHub release, `downloads.json`, commit, deploy site. `npm run release:key` |
| `scripts/build-app.mjs` | copy all of `electron/`; `--version` and `--out` for update tests |

App ↔ server: every 15 s the app `POST`s its status to `/api/update/report` (local only); the reply carries
`{auto, check, install, sinceBusy, sinceInput}`. The UI reads `GET /api/update` and sends `POST /api/update`
`{auto?, check?, install?}`.

## Testing

All hidden (`STUDIO_HIDDEN=1`, own port, own data dir, headless browser), never touching the running app:
1. Build the real 0.1.4 and a test 0.1.5 (`--version 0.1.5 --arch arm64 --out …`). Stamp 0.1.5 with a test key;
   serve it from a fake site on localhost.
2. Install 0.1.4 from its DMG into a temp folder, start it with the test key and fake site, open a terminal.
3. Expect: download, verify, swap, relaunch as 0.1.5, the terminal still alive, `previous.app` gone,
   "updated" notification present, no windows on screen for the test process.
4. A wrong stamp is refused and nothing is installed.
5. A broken 0.1.6 (exits at start) is rolled back to 0.1.5 by the watchdog.
