# Going public: checklist

Everything below is **prepared but not done**. Nothing here is live. Work through it in order; each step says how to check it and how to undo it. Your own Studio keeps working at `studio-cli.cantivia.com` until step 5.

What changes: `studio-cli.cantivia.com` stops being *your* Studio and becomes a normal website with a download button. Anyone can install the app. Phones pair with a one-time code (no emails, no company login). Each person's computer gets its own private address from a small connection service.

## 1. Deploy the connection service (10 min)

See [provisioner/README.md](../provisioner/README.md). When `curl https://studio-api.cantivia.com/v1/health` says `{"ok":true}`, it's up.
*Undo:* `npx wrangler delete` in `provisioner/`. Nothing else depends on it yet.

## 2. Host the installer

The repo is private, so GitHub release links won't open for the public. Use a public Cloudflare R2 bucket:

```bash
npm run app                                  # builds release/out/Studio-CLI-<version>.dmg (one file, every Mac)
npx wrangler r2 bucket create studio-cli-downloads
# In the Cloudflare dashboard: R2 → studio-cli-downloads → Settings → Custom Domains → add dl.cantivia.com
npx wrangler r2 object put studio-cli-downloads/studio-cli/Studio-CLI-0.1.0.dmg \
  --file release/out/Studio-CLI-0.1.0.dmg --content-type application/x-apple-diskimage --remote
```

Check: `curl -I https://dl.cantivia.com/studio-cli/Studio-CLI-0.1.0.dmg` returns 200. If you used another address, edit `site/downloads.json`.
*Undo:* delete the object.

**Strongly recommended before announcing:** sign and notarize the app (Apple Developer ID, $99/year). Unsigned, every new user hits a one-time "Open Anyway" step (explained on the page and in INSTALL.md). Signed, they just open it. With the certificate installed and `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` set, `npm run app` signs and notarizes by itself.

## 3. Try the whole thing yourself, privately

Install the DMG on a spare Mac (or a second user account). Open it, Settings → Phone & remote access → **Turn on phone access** → **Add a phone**, scan with your phone. If that works end to end, the service, the tunnel and pairing are good.

## 4. Move *yourself* onto the app (your terminals keep running)

You currently run Studio from the code at `studio-cli.cantivia.com` behind Cloudflare Access. One command moves you over:

```bash
npm run switch-to-app -- --dry-run     # shows exactly what it will do, changes nothing
npm run switch-to-app
```

It checks the app is installed and notes your running terminals; stops the dev servers (only processes that really are Studio); turns off the old tunnel and moves its files to `~/.studio-cli/old-remote/` (moved, never deleted); opens the app; and **checks every one of your terminals is in the app**, stopping with a clear message if not. Your workspaces, Claude history and shell setup are shared by both, so nothing is copied or lost. Rehearsed in a sandbox with running terminals, a Vite server and an unrelated program on another port.

Afterwards: in the app, Settings → Phone & remote access → Turn on phone access, and pair your iPad and phone. The old "Studio CLI" Chrome app pointed at the code version, so remove it (chrome://apps).

*Undo:* `npm run switch-to-app -- --undo` closes the app and puts the old tunnel files back; then `npm run dev`.

## 5. Put the website on `studio-cli.cantivia.com`

The page is in `site/` (plain HTML, no build). It currently points at your Mac's tunnel through a DNS record, so:

1. In the Cloudflare dashboard, remove the **old Access app** "Studio CLI" and the **old tunnel's public hostname** for `studio-cli.cantivia.com` (Zero Trust → Networks → Tunnels → `studio-cli` → Public hostnames; the app can be deleted afterwards). Delete the old tunnel too once you've moved to the app in step 4.
2. Deploy the site and attach the domain (this replaces the DNS record):
   ```bash
   npx wrangler pages project create studio-cli-site --production-branch main
   npx wrangler pages deploy site --project-name studio-cli-site
   # Dashboard: Workers & Pages → studio-cli-site → Custom domains → add studio-cli.cantivia.com
   ```
3. Check: open https://studio-cli.cantivia.com on a Mac. It should show the page, and the button should download the right file.

*Undo:* remove the custom domain from the Pages project and re-add the tunnel's public hostname.

## 6. Tell people

Send the link. Anyone can install, and everyone's Studio, terminals and Claude stay on their own computer.

## What's still manual afterwards

- **New versions:** `npm run app`, upload the new file to R2, change the version and URL in `site/downloads.json`, redeploy the site. Users download the new file and drag it over the old one (there is no auto-update yet).
- **If someone abuses the connection service:** set `MAX_PER_DAY` to `0` and redeploy to stop new sign-ups; existing installs keep working. See provisioner/README.md.
