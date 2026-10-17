# Going public: checklist

**Status (14 Oct 2026): steps 0–5 and 7 are done and live** (repo public, `main` merged, connection service at studio-api.cantivia.com, release v0.1.0, website on studio-cli.cantivia.com). **Step 6 (moving the owner onto the app) is deliberately left for the owner to do by hand.** The rest of this document is the record of how, and the undo for each step. Original note: everything below was prepared first and run in order. Work through it in order; each step says how to check it and how to undo it. Your own Studio keeps working at `studio-cli.cantivia.com` until step 7.

What changes: the GitHub repo becomes public (with the Mac app as a GitHub release), and `studio-cli.cantivia.com` stops being *your* Studio and becomes a normal website with a download button and a GitHub link. Anyone can install the app. Phones pair with a one-time code (no emails, no company login). Each person's computer gets its own private address from a small connection service.

## 0. Decisions to confirm before step 1

- **Licence.** `LICENSE` is MIT (copyright Cantivia), the most common choice and the same as the Agent View code it builds on. Change it before going public if you want something else.
- **The author email in the history.** All the commits are authored with your personal Outlook address. When the repo is public that address is visible on GitHub. If you'd rather it weren't, say so first: it needs a history rewrite to GitHub's no-reply address (new commit IDs), which is only safe *before* going public.
- **Third-party art.** The Agent View's sprites and the *FS Pixel Sans Unicode* font are redistributed exactly as upstream Pixel Agents (public, MIT) ships them, credited in `CREDITS.md`. I could not independently confirm separate terms for the sprites and font; a quick look at the upstream project before going public is sensible.

Already checked: no keys, tokens or secrets anywhere in the current code or in the full history; no personal names left in the docs.

## 1. Make the GitHub repo public

```bash
gh repo edit cantivia/studio-cli --visibility public --accept-visibility-change-consequences \
  --description "Every terminal and Claude Code session in one calm window. On your Mac, reachable from your phone." \
  --homepage https://studio-cli.cantivia.com --add-topic claude-code --add-topic terminal --add-topic macos --add-topic electron
```

Check: open https://github.com/cantivia/studio-cli in a private browser window.
*Undo:* `gh repo edit cantivia/studio-cli --visibility private --accept-visibility-change-consequences`. Anything already copied while it was public can't be recalled, which is why step 0 comes first.

## 2. Merge the branch to `main`

Note: your local `main` already has 6 commits that aren't on GitHub yet (phone/iPad access, terminals surviving restarts, workspace sharing). They're part of this branch's history and will be pushed with it, so they go public too.

```bash
git checkout main && git merge --no-ff share-links && git push origin main
```

## 3. Deploy the connection service (10 min)

See [provisioner/README.md](../provisioner/README.md). When `curl https://studio-api.cantivia.com/v1/health` says `{"ok":true}`, it's up.
*Undo:* `npx wrangler delete` in `provisioner/`. Nothing else depends on it yet.

## 4. Publish the Mac app as a GitHub release

The website serves downloads from its own cached address (`/download/arm64`, `/download/x64`, see `site-worker/worker.mjs`), which fetches the files from the latest GitHub release once and then serves them from Cloudflare's network (about 50 MB/s from the cache; also supports resuming). The release files must be named exactly `Studio-CLI-arm64.dmg` and `Studio-CLI-x64.dmg`:

```bash
npm run app                       # builds release/out/Studio-CLI-<version>-arm64.dmg and -x64.dmg (about 120 MB each)
mkdir -p /tmp/rel && cp release/out/Studio-CLI-*-arm64.dmg /tmp/rel/Studio-CLI-arm64.dmg && cp release/out/Studio-CLI-*-x64.dmg /tmp/rel/Studio-CLI-x64.dmg
gh release create v0.1.1 /tmp/rel/*.dmg --title "Studio CLI 0.1.1" --notes "..."
# then set "version" in site/downloads.json to match (it names the cache entry), and redeploy the site:
cd site-worker && npx wrangler deploy
curl -sI https://studio-cli.cantivia.com/download/arm64 | grep -i x-studio-cache     # MISS the first time, HIT after
```


*Undo:* `gh release delete v0.1.0 --cleanup-tag`.

**Strongly recommended before announcing:** sign and notarize the app (Apple Developer ID, $99/year). Unsigned, every new user hits a one-time "Open Anyway" step (explained on the page and in INSTALL.md). Signed, they just open it. With the certificate installed and `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` set, `npm run app` signs and notarizes by itself.

## 5. Try the whole thing yourself, privately

Install the DMG on a spare Mac (or a second user account). Open it, follow the checklist, Settings → Phone & remote access → **Turn on phone access** → **Add a phone**, scan with your phone. If that works end to end, the service, the tunnel and pairing are good.

## 6. Move *yourself* onto the app (your terminals keep running)

You currently run Studio from the code at `studio-cli.cantivia.com` behind Cloudflare Access. One command moves you over:

```bash
npm run switch-to-app -- --dry-run     # shows exactly what it will do, changes nothing
npm run switch-to-app
```

It checks the app is installed and notes your running terminals; stops the dev servers (only processes that really are Studio); turns off the old tunnel and moves its files to `~/.studio-cli/old-remote/` (moved, never deleted); opens the app; and **checks every one of your terminals is in the app**, stopping with a clear message if not. Your workspaces, Claude history and shell setup are shared by both, so nothing is copied or lost. Rehearsed in a sandbox with running terminals, a Vite server, an unrelated program on another port, and a port squatter.

Afterwards: in the app, Settings → Phone & remote access → Turn on phone access, and pair your iPad and phone. The old "Studio CLI" Chrome app pointed at the code version, so remove it (chrome://apps).

*Undo:* `npm run switch-to-app -- --undo` closes the app and puts the old tunnel files back; then `npm run dev`.

## 7. Put the website on `studio-cli.cantivia.com`

The page is in `site/` (plain HTML, no build) with the download button and GitHub link. The address currently points at your Mac's tunnel through a DNS record, so:

1. In the Cloudflare dashboard, remove the **old Access app** "Studio CLI" and the **old tunnel's public hostname** for `studio-cli.cantivia.com` (Zero Trust → Networks → Tunnels → `studio-cli` → Public hostnames; the app can be deleted afterwards). Delete the old tunnel too once you've moved to the app in step 6.
2. Deploy the site (the custom domain is in `site-worker/wrangler.jsonc`, so this also replaces the DNS record):
   ```bash
   cd site-worker && npx wrangler deploy
   ```
3. Check: open https://studio-cli.cantivia.com on a Mac. It should show the page, the button should download the app, and the GitHub link should open the repo.

*Undo:* remove the custom domain from the Pages project and re-add the tunnel's public hostname.

## 8. Tell people

Send the link. Anyone can install, and everyone's Studio, terminals and Claude stay on their own computer.

## What's still manual afterwards

- **New versions:** bump `version` in `package.json`, commit on `main`, then `npm run release -- --notes "What changed"` (builds, stamps with the update key, publishes the GitHub release, updates `site/downloads.json` and redeploys the website). Apps from 0.1.4 on update themselves within a few hours, once nobody is using Studio; older ones download the new file and drag it over the old one.
- **If someone abuses the connection service:** set `MAX_PER_DAY` to `0` and redeploy to stop new sign-ups; existing installs keep working. See provisioner/README.md.

## Record of what was changed in Cloudflare (for undo)

- Deleted the Access app "Studio CLI" and the CNAME `studio-cli.cantivia.com` -> old tunnel. Copies of both are in `~/.studio-cli/old-cloudflare/` on the owner's Mac (dns-record.json, access-app.json). The old tunnel `studio-cli` itself still exists and is untouched.
- Worker `studio-cli-site` also serves the cached download addresses (`/download/arm64`, `/download/x64`).
- Worker `studio-connect` (custom domain studio-api.cantivia.com, daily cleanup cron), KV namespace REG, worker `studio-cli-site` (custom domain studio-cli.cantivia.com).
- The connection service holds only a minimal token (Tunnel Write + DNS Write on the cantivia.com zone). The broader token used for the cutover should be deleted.
