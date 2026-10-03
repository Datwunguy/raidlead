# RaidLead Companion

A small always-running tray app that keeps your WoW addon data and RaidLead
account in sync -- the same kind of thing Discord or Steam are, not a
scheduled script. It logs in on its own (a one-time browser approval, not a
stored password -- RaidLead has no separate password at all, every account
is Battle.net-based) and talks to RaidLead directly from then on:

- **Export**: watches the addon's SavedVariables file and uploads captured
  loot straight to your RaidLead account whenever it changes (which only
  happens after a `/reload` or logout in-game -- WoW doesn't flush that file
  live mid-raid).
- **Sync**: polls your team's published roster/raid plan every minute and
  writes it into every character's SavedVariables as soon as it changes.

There's no bridge folder and nothing to click on the website's Loot tab
anymore -- logging in once here is the entire setup. See
`sql/2026_09_companion_auth.sql` and `api/companion.js` at the repo root for
the server side of the login handshake.

## Login

Click **Log In** in Settings. This opens your default browser to a RaidLead
page asking you to approve the request (you'll go through your normal
Battle.net login there first if you aren't already signed in on the
website), and Settings shows a six-character code to type on that page.
The link alone can't approve anything, so a login link someone else sends
you can't connect their Companion to your account. Once approved, this app
receives its own long-lived access token automatically -- no folder to
pick. That token is encrypted at rest via Electron's `safeStorage`
(OS-backed, e.g. Windows DPAPI), the same protection your browser gives
saved website passwords; if Windows can't encrypt it, the login isn't
saved at all rather than stored as plain text. **Log Out** signs this PC out
on RaidLead too, the same as removing it under Connected Devices.

If your account belongs to more than one RaidLead team, a picker appears
after login so you can choose which one to sync -- most accounts only have
one and never see this.

You can revoke a device's access at any time from the website (Account menu
→ My Profile → Connected Devices) without needing to be at that computer --
useful if a laptop is lost or a device is no longer trusted.

## Update notifications

Deliberately notify-only, not auto-download/auto-install -- silently pulling
and running a new binary in the background is a much bigger trust ask than a
plain "hey, a newer version exists" notification, and this project already
leans toward minimal, inspectable behavior. When a newer version is found, a
native OS notification appears; clicking it opens the download page in the
browser. Nothing is downloaded or installed without the person doing it
themselves.

**Releasing a new version:**
1. Bump `"version"` in `package.json`, run `npm run dist` (admin terminal --
   see below).
2. Create a GitHub Release tagged with that version and upload
   `dist/RaidLead Companion Setup <version>.exe`, renamed to
   `RaidLead-Companion-Setup.exe` (the filename must stay exactly that,
   every release, since the site and the update notification both link to
   the stable `.../releases/latest/download/RaidLead-Companion-Setup.exe`
   URL rather than a version-specific one).
3. Update the `"version"` field in `public/updates/version.json` to match --
   that file is the only thing existing installs check against, so a
   release isn't "live" for update notifications until it's updated too.

The installer is never committed to this repo or deployed with the site --
at 100MB+ it's over both GitHub's and Vercel's per-file limits, so it only
ever exists as a GitHub Release asset.

## Why this exists instead of the old bridge-folder / `.bat`/Task Scheduler setup

The original design routed everything through a browser-picked "bridge
folder," because a browser's File System Access API categorically refuses
access to anything under `Program Files` (where WoW normally lives), so a
website could never talk to the real SavedVariables files directly. This app
was never actually subject to that restriction -- it's a native desktop app,
same as WoW itself, and always could read/write there directly (see
`wowPaths.js`). The bridge folder existed purely because this app had no way
to authenticate to RaidLead's backend on its own; the browser's already-
logged-in session was standing in as a relay. Giving this app its own login
(above) removes the need for that relay entirely.

Before *that*, an even older approach used a `.bat` / Windows Task Scheduler
/ hidden-`wscript.exe` script, which turned out to be fragile in ways only
found by testing against a real machine, not from reading the code:

- Antivirus quietly deleting the downloaded `.ps1`/`.vbs` files.
- Windows' Controlled Folder Access silently blocking those file types from
  even being created if the bridge folder was on the Desktop.
- A previously-used Task Scheduler task name becoming permanently
  unregisterable ("Access is denied") for reasons unrelated to actual
  permissions.

A normal always-running app avoids all three categorically: there's no
scheduled task to register, no hidden-window trick (a tray app just doesn't
have a console to begin with), and "an app that starts with Windows" is
about as unremarkable to antivirus as software gets.

## Run it

```bash
npm install
npm start
```

First run: open Settings (tray icon, or the window that opens
automatically) and click **Log In**. That's it -- the app finds your WoW
install on its own, on any drive, and which WoW account is yours is
re-detected automatically every time, so there's nothing to pick. Settings
shows the folder it found (and whether the RaidLead addon is in place);
**Change...** picks a different one -- any folder in or above the install
works.

**What it looks at to find WoW:** Battle.net's entry for World of Warcraft in
Windows' installed-programs list (its install folder -- the same thing
Windows Settings -> Apps shows), and, failing that, whether a
`World of Warcraft` folder exists in a few usual places on each drive. Then
only RaidLead's own save files inside WoW's `WTF` folder. Nothing else on
the PC is read, and the folder path never leaves it -- what goes to
RaidLead is loot records, the team id, and (at login) the PC's name.

"Start automatically when Windows starts" is on by default -- turn it off in
Settings if you'd rather launch it manually.

## Packaging

`npm run dist` (electron-builder) produces an installer for distributing
this to whoever's actually running it. `assets/icon.png`/`assets/icon.ico`
are the RaidLead Discord icon (`raidleaddiscordicon.jpg` at the repo root,
converted via Jimp/png-to-ico) -- the `.ico` is what `build.win.icon` points
at for the installer/exe icon, since a plain PNG renders blurry there. An
unsigned `.exe` can still draw a SmartScreen prompt on first run -- code
signing would remove that, but is a separate cost/setup decision, not
something this app can route around on its own.

`build/installer.nsh` (a custom NSIS hook electron-builder picks up
automatically) force-closes any already-running copy of the app the moment
the installer starts, via `taskkill /f`. electron-builder's own default
behavior tries a gentler close-then-kill first, but in practice that still
left a process behind that had to be killed by hand in Task Manager before
install could proceed -- this app has no unsaved state worth a graceful
shutdown for (everything's already on disk or safely re-fetched next
launch), so skipping straight to a forced kill is the more reliable choice.
