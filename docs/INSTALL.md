# Install Studio CLI on your Mac

Your own terminals, your own Claude, on your own computer. No code, no Terminal commands.

## 1. Download

Get the right file (ask whoever sent you this where to find it):

- **Apple chip** (any Mac from late 2020 on): `Studio CLI-…-arm64.dmg`
- **Intel Mac**: `Studio CLI-…-x64.dmg`

Not sure? Apple menu → **About This Mac**. If it says *Chip: Apple M…* it's the Apple one; if it says *Processor: Intel*, it's the Intel one.

## 2. Install

Open the downloaded file and drag **Studio CLI** onto **Applications**.

## 3. Open it the first time

Until the app is signed with a paid Apple developer certificate, macOS asks you to approve it once:

1. Open **Studio CLI** from Applications. macOS says it can't check it for malware. Click **Done** (not "Move to Trash").
2. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to *Studio CLI*. Enter your Mac password.
3. Click **Open**. You won't be asked again.

(Prefer Terminal? `xattr -dr com.apple.quarantine "/Applications/Studio CLI.app"` does the same thing.)

Studio asks whether to open at login. Say yes if you want your phone to always be able to reach this computer.

## 4. Claude

Studio runs *your own* Claude Code. If you don't have it yet, install it from https://claude.com/claude-code and sign in once in any Studio terminal by running `claude`. Your Claude login and history stay on your computer.

## 5. Use it from your phone or iPad

You'll be sent a long **invite code** that starts with `studio-invite:`. It's like a password, so keep it private.

1. In Studio, click the settings icon (bottom left) → **Phone & remote access**.
2. Paste the code and press **Connect**.
3. Open the address it shows on your phone or iPad and sign in with your work email (you'll get an emailed code).

Only you can open that address. Your computer has to be on and awake. Studio keeps it from idle-sleeping while it's connected. It can't stay reachable with the lid closed on battery.

## Sharing with a teammate

- **Sessions tab → Share link** on a conversation, or the **link icon** on a workspace in the sidebar. The link is copied.
- Send it to a teammate. They paste it in their Studio's **Shared** tab → **Open**.
- Conversations are continued in *their* Claude on *their* computer. Workspaces are watched live (view-only unless you allow typing). Turn a link off any time in the Shared tab.

## Updating, and moving

Download the new file and drag the app over the old one in Applications. Your workspaces and Claude history live in `~/.studio-cli` and `~/.claude` and are kept. To uninstall, drag **Studio CLI** to the Trash.
