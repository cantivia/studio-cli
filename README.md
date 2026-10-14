# Studio CLI

A local, browser-based take on [cmux](https://github.com/manaflow-ai/cmux), styled after Cantivia: vertical workspaces, notification rings and Done ticks for coding agents, a Claude panel with workflows, and an agent view built on [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents).

```bash
npm install
npm run dev        # http://127.0.0.1:4610  (API + terminals on :4600)
```

Run `npm run build && npm start` for a single non-reloading server on :4600. In dev, editing `server/` restarts the server and its terminals. Claude panes come back on the same conversation.

## Install as a Chrome app

With the server running, open http://127.0.0.1:4610 in Chrome and click the install icon at the right of the address bar (or ⋮ → Cast, save and share → Install page as app). It installs as **Studio CLI** with its own window and Dock icon. If the server isn't running, the app shows how to start it.

## Sharing

Everyone runs their own Studio on their own computer. Anyone can download the Mac app ([docs/INSTALL.md](docs/INSTALL.md)) and pair their phone with a one-time code. Developers running from the code use **`npm run setup`**. To share, make a link: **Share link** on a conversation in Sessions, or the link icon on a workspace in the sidebar. The other person opens it from the Shared tab of their own Studio. Details, and how to update a Studio that's already running, are in [docs/per-person-setup.md](docs/per-person-setup.md).

## Terminals

Studio's zsh panes load your normal config through `~/.studio-cli/zsh` (each file sources yours first). If you're on the stock macOS prompt, they add a prompt in the pane's colour: folder, git branch (amber ● when dirty), a red ❯ plus exit code on failure, and the time on the right. Set `STUDIO_KEEP_PROMPT=1` to keep your own. Paper terminals are the default; switch to ink in Settings or ⌘K.

## Done signals

- Claude finishes a turn: the pane gets a ring and a **✓ Done** chip, the workspace shows Done in the sidebar with Claude's last reply, and the office character gets a check
- A shell command that ran 10s or more finishes: same signals, with "Done in 42s" or "Failed (exit 1) after 42s" (`STUDIO_NOTIFY_AFTER=5` changes the threshold)

## What's in it

**From cmux**
- Vertical workspace tabs showing git branch and dirty count, linked PR (via `gh`), live cwd, listening ports and the latest notification
- Split panes (⌘D right, ⌘⇧D down), drag to resize, ⌘⏎ zoom
- Notification rings from OSC 9 / 99 / 777 and BEL, a notification panel, ⌘⇧U to jump to the latest unread
- A browser pane beside your terminal, with one-click detected ports. Sites that forbid embedding (Google, GitHub…) get an Open in side window button instead of an error
- `cmux.json` project commands in the palette and the Claude panel
- Scriptable: REST API plus `bin/studio` (`studio notify`, `studio send`, `studio ls`)

**New**
- **Claude-aware status.** Reads Claude Code's own `~/.claude/sessions/<pid>.json`, so each pane knows whether Claude is working or waiting
- **Notifications that say something.** When Claude finishes, the notification carries its actual last reply, not "Claude is waiting for your input"
- **Claude panel.** Click a Claude pane and a side panel shows its workflows (multi-step, auto-advance when Claude finishes, `{input}` prompts, editable, colour-coded), a live activity feed, searchable skills and slash commands, and earlier conversations in that folder
- **Sessions.** Every past Claude conversation, searchable, resumable as a workspace or a pane
- **Agent View.** One office per workspace (lounge carpeted in its colour), plus Everyone. Every open terminal is a character: typing while Claude edits or a command runs, reading while Claude searches, a green check when a turn or long command finishes. Click a character to jump to its terminal. The office UI is vendored from [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT, see `vendor/pixel-agents/LICENSE`) with a Studio transport (`webview-ui/src/transport/index.ts`); rebuild it with `npm run build:office`. Office layouts save to `~/.studio-cli/offices/`
- ⌘K command palette, desktop notifications, ink or paper terminal themes
- Terminals survive page reloads (server-side scrollback, xterm instances persist across tabs)

## Layout

- `server/`: Express + ws + node-pty. `terminals.ts` (pty + OSC parsing), `meta.ts` (git/ports/PR), `claude.ts` (sessions, transcripts, skills), `store.ts` (workflows), `pixel.ts`
- `src/`: React + Tailwind v4 + framer-motion + xterm.js. Design tokens in `src/styles.css`

Workflows are saved to `~/.studio-cli/workflows.json`.
