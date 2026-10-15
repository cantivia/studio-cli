# Install Studio CLI on your Mac

Your own terminals, your own Claude, on your own computer. No code, no accounts, no Terminal commands.

## 1. Download

Get **Studio CLI** from the download page (https://studio-cli.cantivia.com) or the [latest release on GitHub](https://github.com/cantivia/studio-cli/releases/latest). There is one file per chip type, about 120 MB each: `Studio-CLI-arm64.dmg` for Apple-chip Macs (M1 or newer) and `Studio-CLI-x64.dmg` for Intel Macs. The website picks the right one for you; not sure which you have? Apple menu → About This Mac. macOS 12 or later.

## 2. Install

Open the downloaded file and drag **Studio CLI** onto **Applications**.

## 3. Open it the first time

Until the app is signed with a paid Apple developer certificate, macOS asks you to approve it once:

1. Open **Studio CLI** from Applications. macOS says it can't check it for malware. Click **Done** (not "Move to Trash").
2. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to *Studio CLI*. Enter your Mac password.
3. Click **Open**. You won't be asked again.

(Prefer Terminal? `xattr -dr com.apple.quarantine "/Applications/Studio CLI.app"` does the same thing.)

Studio asks whether to open at login. Say yes if you want your phone to always be able to reach this computer.

## 4. Follow the checklist

The first time you open Studio, a short checklist walks you through it:

1. **Install Claude Code**: one click ("Install it for me") runs Claude's own installer in a terminal you can watch. Skip it if you already have Claude Code.
2. **Sign in to Claude**: one click opens Claude's sign-in in your browser. Your Claude login and history stay on your computer.
3. **Open your first workspace**: pick a folder, then a shell, Claude, or both side by side.
4. **Use it from your phone** (optional): see below.

The ticks appear by themselves as each step finishes. Terminals work without Claude, so you can skip straight to step 3.

## 5. Use it from your phone or iPad

1. In Studio, click the settings icon (bottom left) → **Phone & remote access** → **Turn on phone access** (or use the last step of the checklist). Your computer gets its own private address, like `studio-brave-otter-4821.cantivia.com`.
2. Press **Add a phone**. A QR code and a short code appear.
3. On your phone, scan the QR code with the camera (or open the address, then `/pair`, and type the code). Done: that phone is paired.

Each phone is paired once. Codes work one time and expire after five minutes. You can see your paired devices in the same dialog and sign any of them out, or **Turn off** to switch phone access off completely.

Your computer has to be on and awake. Studio keeps it from idle-sleeping while phone access is on. It can't stay reachable with the lid closed on battery.

## Is the terminal the same as Terminal.app?

Yes, for what matters. Studio starts your own login shell (the one macOS has on record for you) and loads your own `.zshrc`/`.zprofile`, exactly as Terminal does, so you get the same `PATH`, Homebrew, Node/nvm, Python, aliases, prompt tools and everything else you've installed. Studio only swaps the prompt if you're still on macOS's plain default. A few honest differences: it's a web terminal, so inline images (iTerm-style) aren't shown, and ⌘T/⌘W/⌘N are Studio's own keys (⌥⌘T new terminal, ⌥⌘N new workspace) rather than tabs and windows.

## Sharing with a teammate

- **Sessions tab → Share link** on a conversation, or the **link icon** on a workspace in the sidebar. The link is copied.
- Send it to a teammate. They paste it in their Studio's **Shared** tab → **Open**.
- Conversations are continued in *their* Claude on *their* computer. Workspaces are watched live (view-only unless you allow typing). Links need phone access to be on, expire after 7 days, and can be turned off in the Shared tab.

## Updating, and moving

Download the new version and drag it over the old one in Applications. Your workspaces and Claude history live in `~/.studio-cli` and `~/.claude` and are kept. To uninstall, drag **Studio CLI** to the Trash.
