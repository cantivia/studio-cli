# CLAUDE.md

@AGENTS.md

## Claude Code notes

- The user runs Studio CLI all day. Its server hosts their real terminals and Claude sessions. Before restarting it (any edit under `server/` in `npm run dev`), say so, because their shells will restart.
- When testing against the live server, record terminal IDs before you start and delete only the ones you created.
- Studio reads Claude Code's internals (`~/.claude/sessions/<pid>.json`, transcript JSONL, `--settings` theme override). If a Claude Code update changes those formats, the fallout shows up as panes stuck on "Ready", an empty Activity feed, or missing Done ticks. Start debugging in `server/claude.ts`.
- The user writes short, informal requests with screenshots. Confirm what a screenshot points at before rebuilding something big, and keep explanations plain (no jargon).
