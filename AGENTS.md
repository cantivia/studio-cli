# AGENTS.md

Guide for coding agents working in this repo. Read it before changing anything.

## What this is

**Studio CLI** is a local, browser-based workspace for running many terminals and Claude Code sessions. It takes the ideas of [cmux](https://github.com/manaflow-ai/cmux) and uses Cantivia's visual language (matte white, Inter, one violet accent, liquid glass). It runs on localhost and installs as a Chrome app (PWA). There is no cloud part.

Three top-level views (the tab bar in `src/components/TopNav.tsx`):

- **Workspaces.** A workspace is a folder plus its panes (terminal, Claude, browser), auto-tiled into a grid. Each workspace has a colour that runs through the sidebar dot, pane border and glow, cursor, and shell prompt. Clicking a Claude pane opens the **Claude panel** (workflows, live activity, skills, history).
- **Agent View.** One pixel office per workspace plus "Everyone". Every open terminal is a character. Built on the vendored Pixel Agents UI.
- **Sessions.** Every past Claude Code conversation from `~/.claude/projects`, resumable.

## Run it

```bash
npm install          # postinstall chmods node-pty's spawn-helper (see Gotchas)
npm run dev          # API + terminals on 127.0.0.1:4600, UI (Vite) on 127.0.0.1:4610
npm run build && npm start   # single non-reloading server on :4600 serving dist/
npx tsc --noEmit     # typecheck (src + server). There is no lint or unit-test suite yet
npm run build:office # rebuild the Agent View bundle into public/office (only after editing vendor/)
```

The user opens http://127.0.0.1:4610, usually as the installed Chrome app. Both servers bind to 127.0.0.1 only.

## Layout

```
server/                  Node (tsx), Express + ws + node-pty
  index.ts               HTTP API, WebSocket routes, 2s poller (cwd, ports, git, PR, Claude status, office states)
  terminals.ts           terminal state, scrollback replay, OSC/BEL parser → notifications; talks to pty-host
  pty-host.ts            long-lived process that owns the ptys (unix socket ~/.studio-cli/pty.sock), survives server restarts
  shell.ts               zsh integration written to ~/.studio-cli/zsh (ZDOTDIR): prompt, OSC 7 cwd, long-command notifications, Claude theme
  claude.ts              reads ~/.claude: live sessions/<pid>.json, transcripts (activity), session list, skills/commands
  meta.ts                ps / lsof / git / gh helpers
  offices.ts             Agent View backend: speaks the Pixel Agents webview protocol over /ws/office
  store.ts               workflows (~/.studio-cli/workflows.json), cmux.json project commands, dir listing
src/                     React 19 + Vite + Tailwind v4 (CSS-first, tokens in src/styles.css) + framer-motion + zustand
  lib/store.ts           UI state (persisted to localStorage key "cmux-studio"; the old name is kept on purpose)
  lib/terms.ts           xterm registry living outside React; themes; WebSocket per terminal
  lib/layout.ts          split-tree helpers and gridLayout()
  lib/runs.ts            multi-step workflow runner (auto-advances when Claude goes busy → idle)
  lib/colors.ts          the 10-colour palette (ui + glow tones) and nextHue()
  components/            Sidebar, TopNav, WorkspaceView, TerminalView, BrowserView, ClaudePanel, PixelOffice (Agent View), Sessions, intro/
vendor/pixel-agents/     MIT-licensed Pixel Agents webview + core, with a Studio transport (see below)
public/office/           built Agent View bundle (committed so a fresh clone runs without building vendor/)
public/                  PWA manifest, service worker, icons, offline page
bin/studio               tiny CLI: studio notify | send | ls
```

## How the main pieces work

- **Terminals.** `POST /api/terminals` spawns a login zsh through node-pty (commands run as `zsh -l -i -c "<cmd>; exec zsh -l"`). The browser attaches over `/ws/term/:id`. Frames starting with `\x00` are JSON control messages (resize). The server keeps 512 KB of scrollback for replay after a reload.
- **xterm instances persist outside React** (`lib/terms.ts`). A pane borrows a terminal's DOM node while mounted, so switching tabs never tears down or replays a terminal. Panes respawn their pty when the server no longer knows it (close code 4404 → `gone`).
- **Claude status** comes from Claude Code's own `~/.claude/sessions/<pid>.json` (`status: busy | idle`), matched to a pane through the pty's process tree. Activity comes from the transcript at `~/.claude/projects/<cwd with non-alnum → "-">/<sessionId>.jsonl`.
- **Done signals.** busy → idle raises a notification whose body is Claude's last reply. The zsh integration emits OSC 777 for commands that ran ≥ 10s (`STUDIO_NOTIFY_AFTER`). A finished turn or command shows a ring, a "✓ Done" chip, the sidebar status, and a check on the office character.
- **Workflows** are prompt lists sent to the focused Claude via `/api/terminals/:id/send` (bracketed paste for multi-line). `lib/runs.ts` sends the next step after Claude has been busy and returns idle.
- **Agent View.** `vendor/pixel-agents/webview-ui` is upstream's office UI with three patches: art always loads in-browser (`main.tsx`, `App.tsx`, `browserMock.ts`), and `src/transport/index.ts` connects to Studio's `/ws/office?office=<workspaceId|all>`, buffering server messages until the sprites are loaded. The client tells the server which terminals belong to which workspace via `PUT /api/offices`. `server/offices.ts` turns terminal state into `agentCreated / agentToolStart / agentStatus` messages and tints each office's lounge floor with the workspace colour. Clicking a character sends `focusAgent`, which Studio turns into a jump to that terminal.
- **Browser panes** are iframes. `GET /api/frame-check` reads X-Frame-Options and CSP frame-ancestors first. Sites that forbid embedding (Google, GitHub) get an "Open in side window" card instead of Chrome's error page.
- **Remote access** (iPad, phone): a Cloudflare Tunnel (`studio-cli`, LaunchAgent `com.studio-cli.tunnel`, token in `~/.studio-cli/tunnel-token`) forwards `https://studio-cli.cantivia.com` to Vite on :4610. Cloudflare Access (email code, `@cantivia.com` only) sits in front. `server/access.ts` is the second lock: any request that isn't from this Mac needs a valid Access token, checked in both the API server and a Vite middleware. Settings live in `~/.studio-cli/remote.json`. Without that file every remote request gets a 403. Vite reads the hostname at startup, so restart it after changing the file.
- **Shared workspaces** (`lib/sync.ts`): the workspace list lives on the server (`~/.studio-cli/workspaces.json`, `GET/PUT /api/workspaces`, pushed to other devices over `/ws/events`), so the Mac, iPad and phone show the same workspaces and the same live terminals. Focused/zoomed pane stays per device. On connect a device merges: server list first, then its own workspaces the server hasn't seen, minus ids closed elsewhere (`deleted`). Terminals wait for that merge (`synced`), and `POST /api/terminals` takes a `paneId` so two devices starting the same pane get one terminal.
- **One pty, several devices.** The pty takes the size of whichever device used it last. The server reports the size to every viewer (`\x00{"t":"size"}` frames, also sent after each replay), and `claimSize` in `terms.ts` takes it back when you type, click, point, or return to the tab. On reconnect the client resets xterm before the replay. If the replay leaves a full-screen app (Claude) on screen, it sends `redraw`, and the server nudges the height by one row so the app repaints. Otherwise a mid-frame replay can leave the prompt box missing.
- **One Studio per person.** Studio has no accounts: everyone runs their own copy on their own computer, with their own tunnel, hostname and Access app whose `allow` lists only them. Nothing is shared between people except share links. `npm run setup` (`scripts/setup.mjs`, no dependencies) does all of it through Cloudflare's API: tunnel, DNS, the two Access apps, `remote.json`, and LaunchAgents for the tunnel and a production server. It is idempotent, supports `--dry-run`, and on a Studio that already has a `remote.json` it only locks `allow` to your email and adds the share-link app; it never installs services over a running Studio (port check) or an existing setup. `CLOUDFLARE_API_BASE` points it at a fake Cloudflare for testing. See `docs/per-person-setup.md`.
- **Pairing & open access**: remote.json has `mode: "pairing"` (Mac app default) or `"access"` (Cloudflare Access, `setup`/`invite`). Pairing (`server/devices.ts`, `pair-page.ts`, `/pair`, `/pair/claim`, `/api/remote/{enable,pair,devices}`): "Add a phone" mints an 8-character single-use code valid 5 minutes, only from this computer; the phone claims it and gets a 256-bit `studio_device` cookie (HttpOnly, Secure, Lax); only its SHA-256 is stored; 5 wrong tries/min per IP and a global 30/10 min brake. `access.ts` lets a request in if it's local, or (pairing) has a valid device cookie, or targets only the public files / `/share/*` (token-checked). Remote requests are recognised by `cf-ray`/`cf-connecting-ip` and the Host must equal `remote.json` host; in tests use raw `http.request` since `fetch` ignores a custom Host. The connection service (`provisioner/worker.mjs`, Cloudflare Worker, not deployed) hands each install its own `studio-<words>.<domain>` address + tunnel (`server/provision.ts` talks to it; override with `STUDIO_PROVISIONER`). `site/` is the static download page (reads `site/downloads.json`). `docs/LAUNCH.md` is the go-live runbook; nothing in it is done yet.
- **Mac app** (`electron/main.cjs`, `scripts/build-app.mjs`, `npm run app`): an Electron wrapper so teammates install a DMG instead of cloning. `build-app.mjs` builds the web app, bundles `server/index.ts` and `server/pty-host.ts` with esbuild into `server.mjs` / `pty-host.mjs` (only `node-pty` stays external), adds cloudflared, and runs electron-builder (one universal DMG in `release/out`; `--split` for per-chip DMGs; the per-chip halves must not be signed separately, only the merged app). The app runs the server on Electron's own Node (`ELECTRON_RUN_AS_NODE=1`, `STUDIO_BUNDLED=1`, `STUDIO_ROOT`, `STUDIO_MANAGE_TUNNEL=1`); `terminals.ts` spawns `pty-host.mjs` instead of the `.ts` file in that mode and strips those variables (plus `NODE_ENV`, `PORT`) from your shells. `server/tunnel.ts` runs the bundled cloudflared when `tunnel-token` exists. The window hides on close; quitting stops remote access. Remote access is turned on in Settings → Phone & remote access (`RemoteDialog.tsx`, `/api/remote*`, local requests only), with an **invite** (`server/invite.ts`; `npm run invite` = `scripts/invite.mjs`) as the advanced Access-mode path. Unsigned unless Apple credentials are present (see docs/per-person-setup.md). Testing the app: launch the binary with `STUDIO_PORT`, `STUDIO_DATA_DIR`, `STUDIO_NO_LOGIN_PROMPT=1` and `--remote-debugging-port`, then drive it with Playwright `connectOverCDP`. Never use `pkill -f "Studio CLI.app"`: it also matches the user's installed Chrome app of the same name.
- **Share links** (`server/shares.ts`, `share-page.ts`, `components/Shared.tsx`, `lib/share.ts`): the Shared tab. A link is `https://<your host>/share/<secret token>` (7 days, revocable, stored in `~/.studio-cli/shares.json`) and names one Claude session or one workspace. The server serves a standalone page for it (no build step, only talks to `/share/api/<token>/…` and `/share/ws/<token>/…`). Workspace links show your live terminals; guests never resize the pty and can type only if the link's `canType` is on. Session links show the transcript; "Open in my Studio" `postMessage`s it to the visitor's own Studio (the tab that opened the link, origin-checked in `Shared.tsx`), which writes it to *their* `~/.claude/projects/<slug>/<id>.jsonl` via `POST /api/session-import` (never overwrites). In `server/access.ts`, a second Access app (`shareAud`/`shareAllow`) is accepted only on `isSharePath()` URLs, which is deliberately strict (no dot segments or encoded slashes).
- **Testing two Studios**: start two copies as if on two computers, each with `STUDIO_DATA_DIR` (keep the path short: unix socket limit), `STUDIO_CLAUDE_DIR`, `PORT`=`STUDIO_API_PORT` and `STUDIO_WEB_PORT`. This keeps tests away from `~/.studio-cli` and `~/.claude`.
- **Opening animation** (`components/intro/`) is copied from cantivia/studio's splash with "cli" added. Stroke data comes from that repo's `ink-gen/gen.py` (Hershey fonts).

## Gotchas (each one has bitten this project)

- **node-pty `posix_spawnp failed`**: npm's install-script allowlist can skip node-pty's postinstall, leaving `prebuilds/darwin-*/spawn-helper` non-executable. The `postinstall` script chmods it. Keep it.
- **Studio launched from inside Claude Code** inherits `CLAUDECODE` / `CLAUDE_CODE_*` vars, which make every Claude in a pane a "child session" with no transcript and no sessions file, so status tracking goes blind. `terminals.ts` strips them. Don't remove that filter.
- **CSS `visibility`**: a child with `visibility: visible` shows through a `visibility: hidden` parent. Hidden views must hide their children too (`visible && …`), or they bleed into other views.
- **`backdrop-filter`** (`.liquid-glass`) makes the element the containing block for `position: fixed` children. Modals inside glass panels must be portalled to `document.body`.
- **Don't animate sidebars or rails with AnimatePresence width mount/unmount.** It got stuck a few pixels wide. Use always-mounted elements with CSS width transitions (`.rail`).
- **zustand v5 selectors** that build new arrays or objects cause infinite render loops. Use `useShallow` or return primitives.
- **Claude Code's theme**: on paper (light) terminals Studio runs Claude with `--settings '{"theme":"light"}'` through a zsh function, and `terms.ts` strips the light theme's grey user-message background. The user's global `~/.claude/settings.json` is never touched.
- **Resume only saved conversations.** A Claude session that never got a message has no transcript, and `--resume` fails. The server checks `transcriptExists()` before swapping in `--resume`.
- **Editing `server/` in dev restarts the server**, but terminals live on in the pty host (`server/pty-host.ts`) and the server picks them up again. Editing `pty-host.ts` itself only takes effect after the host is restarted (kill it), and that does end every terminal, so say so first. The host log is `~/.studio-cli/pty-host.log`.
- **Keyboard shortcuts in a browser.** ⌘T, ⌘W and ⌘N belong to Chrome. Studio uses ⌥⌘T (new terminal), ⌥⌘N (new workspace), ⌘D / ⌘⇧D (split), ⌘⏎ (zoom), ⌘K (palette), ⌘⇧U (latest unread), ⌃1–9 (switch workspace). Shortcuts are registered in the capture phase so they beat the focused xterm.

## Conventions

- Design tokens live in `src/styles.css` (no Tailwind config). Colours: ink `#1d1d1f`, muted `#636366`, accent violet `#6d28d9`, paper terminal `#fbf9f4`, brand beige `#F5F1E8`. Motion easing is `cubic-bezier(0.22, 1, 0.36, 1)`.
- Workspace, workflow and office colours always come from `lib/colors.ts` (`ui` for chrome on white, `glow` for prompts, cursors and anything on dark).
- Match the surrounding code: short comments that explain why, no comment banners on trivial code, no new dependencies without a reason.
- Runtime data lives in `~/.studio-cli/` (workflows, office layouts, zsh integration). Never write into `~/.claude/` except through Claude Code itself.

## Verifying UI changes

There's no test suite. Verify in a real browser with Playwright: Chromium and WebKit are in `~/Library/Caches/ms-playwright`, and the library is importable from another local project's `node_modules`. Typical loop: typecheck, drive the flow, screenshot, look at the screenshot. To skip the intro, set `sessionStorage['studio_cli_splash_seen'] = '1'` in an init script. Clean up only the terminals your test created. The user's own terminals run on the same server.
