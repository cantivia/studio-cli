# Sharing, part 2 (design)

Approved 17 Oct 2026 ("do all of them"). Five pieces, one release (0.1.5).

## 1. Phone & iPad on the Shared page
A "Your phone & iPad" card: paired devices (name, last used, Remove) and "Add a phone or iPad", which opens
Phone & remote access straight on the QR code (`remotePair` flag in the store). If phone access is off, the
card's button turns it on first (same dialog).

## 2. Link options
- **How long:** each link card has a "Lasts" menu: 1 hour, 1 day, 7 days, 30 days, no end date. Changing it counts
  from now. `expiresAt: null` means no end date. New links still start at 7 days.
- **One pane:** a share button in each pane's header makes a `pane` link (`ref` = pane id, stable across respawns).
  The guest page shows just that pane. Same view-only / can-type rules as workspace links.

## 3. Who's watching
- The guest page gets a random visitor id (sessionStorage) and pings `/share/api/<token>/hello` every 5 s.
  The server keeps live presence in memory (seen in the last 15 s = watching now) and the last 30 opens on the
  link (`opens`: when, device from the user agent, country from `cf-ipcountry`).
- Link cards show "N watching now" and the opens. **Kick** closes that visitor's terminal sockets and makes the
  server refuse that visitor id on that link until Studio restarts; their page says they were removed. They can
  reopen the link in a new tab, so turning the link off is the way to keep someone out.

## 4. Guests can message your Claude
- Per link (workspace or pane): "Guests can message your Claude" (off by default). The guest page then shows a
  message box under each Claude pane, with an optional name.
- `POST /share/api/<token>/message` checks the link allows it, the pane belongs to it and is running Claude, the
  text is at most 4,000 characters, and at most 10 messages a minute per link. Delivered straight in:
  `Message from <name> (a guest on your share link):` + text, as a bracketed paste plus Enter.

## 5. Claudes talk to each other
- **Connect:** Claude panel → Teammate tab → "Connect a teammate's Claude" makes a `claude` link for that pane
  (copied). The teammate pastes it into Shared → "Open a link"; their Studio sees it's a Claude link (its server
  asks yours, so no browser cross-origin issues), and they pick one of their Claude panes.
- **Wire:** the joining Studio's server opens a WebSocket to `/share/ws/<token>/claude` on the inviting Studio and
  keeps it open, reconnecting with backoff; its side is saved in `~/.studio-cli/claude-links.json`. Only the
  inviting Studio needs phone access on. Messages: `hello {name, pane}`, `msg {text}`, `peek` / `peek-reply`,
  `pause {paused, by}`, `human` (someone typed in their pane).
- **Commands for Claude** (in every Studio terminal, `bin/studio`, curl only so no Node is needed):
  `studio tell "…"` sends the connected Claude a message; `studio peek` prints what it has been doing (its recent
  messages and commands, from its transcript). On connect, each Claude gets a short intro saying who it's connected to
  and how to use both commands. Incoming: `Message from <name>'s Claude (reply with studio tell "…"):` + text.
- **Brakes:** a Pause switch on each connection (either side; pausing pauses both), Claude's own permission prompts,
  and an automatic pause after 20 messages with no human typing in either pane. Messages to a pane that isn't
  running Claude are held back and the owner is told.
- **Seen by both:** the Teammate tab shows the partner, online/offline, Pause, Disconnect and the conversation.
  Connections are also listed on the Shared page.
- Your name comes from the Mac's full user name (`id -F`).

## Testing
Unit tests for the pure parts (`server/links-core.ts`: expiry options, message formats, the 20-message brake).
Two Studios started side by side on spare ports, each with its own data and Claude folders, with stand-in "Claude"
panes (a `tee` process plus a fake `sessions/<pid>.json` and transcript, so no real Claude usage). The test checks
expiry, pane links, presence, kick, guest messages, connect, tell, peek, pause and the auto-pause. Then headless
browser screenshots of the Shared page, the guest page and the Teammate tab, and a hidden smoke test of the built app.
