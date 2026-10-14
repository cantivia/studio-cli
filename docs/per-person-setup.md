# Your own Studio, reachable from your phone

Everyone runs **their own Studio on their own computer**: their own terminals, Claude login and history, workspaces,
and remote address. Nothing is shared between people except links they choose to make.

- Your phone/iPad reaches *your* computer. A colleague's reach *theirs*.
- Each person has their own address (e.g. `studio-ashkan.cantivia.com`) that only they can open.
- To share, you make a link (see the bottom). They open it from their own Studio.

## Set up (about 3 minutes)

```bash
git clone https://github.com/cantivia/studio-cli.git
cd studio-cli
npm install
npm run setup
```

`npm run setup` asks two things (your work email and a Cloudflare token) and does the rest:

1. creates a private tunnel from the internet to this computer, and your own address (`studio-<you>.<company domain>`),
2. locks that address to **only your email** (you sign in with an emailed code),
3. adds a second rule so colleagues can open the **share links** you make, and nothing else,
4. saves the settings and keeps Studio and the tunnel running in the background, starting at login.

Then open the address it prints on your phone, sign in with your email, and you're in your own Studio.

**The Cloudflare token** (used once, never saved): https://dash.cloudflare.com/profile/api-tokens → Create Token →
Create Custom Token, with *Account · Cloudflare Tunnel · Edit*, *Account · Access: Apps and Policies · Edit*,
*Account · Access: Organizations, Identity Providers, and Groups · Read*, *Account · Account Settings · Read*,
*Zone · DNS · Edit*. The setup prints this list too. Delete the token afterwards if you like.

Good to know:
- The setup is safe to run again. It reuses what exists instead of making copies. `npm run setup -- --dry-run` shows what it
  would do without changing anything. `--no-service` skips the background services.
- Your computer has to be on and awake. Studio keeps it from idle-sleeping while it runs (a Mac with the lid shut on battery still sleeps).
- Studio checks the login itself as well as Cloudflare (`server/access.ts`), so a request from outside without a valid
  token for the right rule gets a 403. The share-link login works only on `/share/…` pages, never on terminals or the API.

## Updating a Studio that's already set up (e.g. on the Mac you use every day)

1. Update the code (`git merge` the new branch, or `git pull`).
2. Run `npm run setup -- --email you@company.com`. It sees your existing setup and only **locks it to just you** and **adds the
   share-link rule**. Your tunnel, address and token are left alone, and the old settings are kept as `remote.json.bak`.
3. Restart `npm run dev` (stop it, run it again). Your terminals and Claude sessions keep running: they live in a separate
   host process and reconnect.

## Without the script (manual)

Do the same four things in the Cloudflare Zero Trust dashboard: a tunnel to `http://127.0.0.1:4600` (`npm start`) or
`http://127.0.0.1:4610` (`npm run dev`) with a public hostname; an Access app for that hostname allowing only your email; a
second Access app on the same hostname with path `/share/*` allowing your company's email domain. Then write
`~/.studio-cli/remote.json`:

```json
{
  "host": "studio-you.company.com",
  "team": "your-team.cloudflareaccess.com",
  "aud": "<AUD tag of the first Access app>",
  "allow": ["you@company.com"],
  "shareAud": "<AUD tag of the share-link app>",
  "shareAllow": ["@company.com"]
}
```

## Share links

- **Share link on a conversation** (Sessions tab): the link opens a read-only page of the conversation. "Open in my Studio"
  hands it to the visitor's own Studio, which copies it into *their* Claude history so they continue it on their own computer.
- **Share link on a workspace** (link icon in the sidebar): the link opens a page that shows your live terminals. Guests only
  watch, unless you tick "Guests can type" on the link. Typing runs commands on your computer, so only allow it for people you trust.
- A link names one thing, expires after 7 days, and can be turned off any time in the Shared tab (that also drops anyone
  watching). Opening one needs the secret link **and** a sign-in at your company. Don't post links publicly.
- Links work only while the sharer's computer is on and their Studio is running.
