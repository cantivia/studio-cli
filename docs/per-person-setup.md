# Your own Studio, reachable from your phone

Everyone runs **their own Studio on their own computer**: their own terminals, Claude login and history, workspaces,
and remote address. Nothing is shared between people except links they choose to make.

- Your phone/iPad reaches *your* computer. A colleague's reach *theirs*.
- Each person has their own address (e.g. `studio-ashkan.cantivia.com`) that only they can open.
- To share, you make a link (see the bottom). They open it from their own Studio.

## Ways to get your own Studio

**1. The Mac app (for everyone, easiest).** Download the DMG, drag it to Applications, open it. For phone access, press **Turn on phone access** in Settings, then pair each phone with a one-time code or QR. No repo, no Cloudflare account, no email or company login: anyone can use it. See [INSTALL.md](INSTALL.md). Behind the scenes a small connection service ([provisioner/](../provisioner/README.md)) gives each app its own address; going public is covered in [LAUNCH.md](LAUNCH.md).

**2. `npm run setup` (developers running Studio from the code, with Cloudflare Access).** Gives *your own* computer a secure address behind an email login in about 3 minutes. If your email is a company address, colleagues at that company can open your share links; with a public provider like gmail.com, only you can:

```bash
git clone https://github.com/cantivia/studio-cli.git && cd studio-cli && npm install && npm run setup
```

It asks for your work email and a Cloudflare token, then creates a private tunnel and address (`studio-<you>.<company domain>`),
locks it to **only your email**, adds the share-link rule for your company, saves the settings, and keeps Studio and the tunnel
running in the background. `--dry-run` shows what it would do; it's safe to run again.

**3. `npm run invite` (optional, for whoever runs the company's Cloudflare).** Makes a teammate's address behind an email login and prints an invite code they paste into the app's "I have an invite code instead" link. Most people don't need this now that the app can set itself up:

```bash
npm run invite -- --email feargal@cantivia.com
```

It creates their tunnel (`studio-feargal`), address (`studio-feargal.cantivia.com`), an Access app that allows only them, and the
share-link app, and copies a `studio-invite:…` code to your clipboard. Send it to them privately: it contains their tunnel's secret.
Running it again prints the same code. Nothing about your own Studio changes.

**The Cloudflare token** (used once, never saved), for `setup` and `invite`: https://dash.cloudflare.com/profile/api-tokens →
Create Token → Create Custom Token, with *Account · Cloudflare Tunnel · Edit*, *Account · Access: Apps and Policies · Edit*,
*Account · Access: Organizations, Identity Providers, and Groups · Read*, *Account · Account Settings · Read*, *Zone · DNS · Edit*.
Delete it afterwards if you like.

Good to know:
- Your computer has to be on and awake. The Mac app and `setup` both keep it from idle-sleeping while connected (a Mac with the lid shut on battery still sleeps).
- Two ways in from outside, set by `mode` in `remote.json` (`server/access.ts`): **pairing** (the Mac app: a phone pairs once with a single-use code made on the computer, then carries a device cookie; `server/devices.ts`) and **access** (Cloudflare Access with an email allow-list, used by `setup`/`invite`). In both, a request from outside without a valid pairing cookie or Access token gets a 403. Share links are the one public door: they need the secret link, and reach only that one conversation or workspace.

## Building the Mac app

`npm run app` makes both installers (Apple chip and Intel) in `release/out` (about 150 MB each, about two minutes).
`npm run app:dir` builds just the `.app` for testing. Give people the DMG any way you like (a shared drive, or a GitHub release:
`gh release create v0.1.0 release/out/*.dmg`).

**Signing.** Unsigned apps make macOS show the one-time "Open Anyway" step in [INSTALL.md](INSTALL.md). To remove it you need an
Apple Developer ID ($99/year, https://developer.apple.com/programs/). With the certificate in your keychain and
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` set, `npm run app` signs and notarizes the app automatically.

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
