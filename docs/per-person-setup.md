# One Studio per person

Every person runs **their own Studio on their own computer**. Their terminals, Claude login and history,
workspaces and remote connection are theirs alone. There is no shared server and no shared account.

- Ashkan's phone/iPad reaches Ashkan's Mac. Feargal's reach Feargal's computer.
- Each person has their own address (e.g. `studio-cli.cantivia.com` for Ashkan, `studio-feargal.cantivia.com` for Feargal),
  their own Cloudflare Tunnel, and an Access rule that lists **only them**.
- The only thing that crosses between people is a **share link** (below), made on purpose.

## Setting up your own Studio (about 15 minutes, once)

1. **Run it.** `git clone` the repo, `npm install`, `npm run dev` (or `npm run build && npm start`). Open http://127.0.0.1:4610.
2. **Tunnel** (so your phone/iPad can reach your computer). In Cloudflare Zero Trust → Networks → Tunnels, create a tunnel
   named `studio-<you>`. Add a public hostname, e.g. `studio-<you>.cantivia.com`, pointing at `http://127.0.0.1:4610`.
   Save the tunnel token to `~/.studio-cli/tunnel-token`, `brew install cloudflared`, and keep the tunnel running with a
   LaunchAgent (`~/Library/LaunchAgents/com.studio-cli.tunnel.plist`: run `cloudflared tunnel --no-autoupdate run --token-file <path>`
   with `RunAtLoad` and `KeepAlive` true).
3. **Access app for you.** Zero Trust → Access → Applications → Add a self-hosted app for that hostname. One policy:
   *Allow → Emails → your own email* (just you, not the whole domain). Note its **Application Audience (AUD) tag**.
4. **Access app for share links.** Add a second self-hosted app on the **same hostname with path `/share/*`**. One policy:
   *Allow → Emails ending in → @cantivia.com*. Note its AUD tag. (Cloudflare uses the most specific app, so only share
   links are open to colleagues; everything else stays yours alone.)
5. **`~/.studio-cli/remote.json`:**
   ```json
   {
     "host": "studio-<you>.cantivia.com",
     "team": "<your-team>.cloudflareaccess.com",
     "aud": "<AUD of the app from step 3>",
     "allow": ["<you>@cantivia.com"],
     "shareAud": "<AUD of the app from step 4>",
     "shareAllow": ["@cantivia.com"]
   }
   ```
   Restart Studio (Vite reads the hostname at startup). Without this file every request from outside your computer is refused.
6. **Keep the computer reachable.** The computer must be on and awake. With `remote.json` present, Studio runs
   `caffeinate` so it doesn't idle-sleep while Studio is running. Closing the lid on battery still sleeps a Mac.

Studio checks the login itself as well as Cloudflare (`server/access.ts`): a request from outside must carry a valid token
for the right app, or it gets a 403. A login from the share-link app is accepted only on `/share/*` paths, never on the API or terminals.

## Locking down an existing Studio

If your `remote.json` still says `"allow": ["@cantivia.com"]`, anyone at the company can reach your terminals. Change it to
just your email, and make the same change on the Access policy in Cloudflare. Edits to `remote.json` apply immediately.

## Share links

- **Share link on a conversation** (Sessions tab): the link opens a read-only page of the conversation. "Open in my Studio"
  hands it to the visitor's own Studio, which copies it into *their* Claude history and continues it there, on their own computer.
- **Share link on a workspace** (link icon in the sidebar): the link opens a page that shows your live terminals. Guests only
  watch, unless you tick "Guests can type" on the link. Typing runs commands on your computer, so only allow it for people you trust.
- A link names one thing, expires after 7 days, and can be turned off at any time in the Shared tab (that also drops anyone
  watching). Anyone opening it must also pass the share-link login. The link is a secret: don't post it publicly.
- Links work only while the sharer's computer is on and Studio is running.
