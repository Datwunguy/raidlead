# RaidLead Companion

A small always-running tray app that replaces the `.bat` / Windows Task
Scheduler / hidden-`wscript.exe` setup in `../public/RaidLead Docs/` with a
normal background app -- the same kind of thing Discord or Steam are, not a
scheduled script. It does **exactly** what `RaidLeadBridge.ps1` does, just
continuously instead of once every 5 minutes via a scheduled task:

- **Export**: watches the addon's SavedVariables file and writes
  `loot-export.json` into the bridge folder whenever it changes (which only
  happens after a `/reload` or logout in-game -- WoW doesn't flush that file
  live mid-raid).
- **Import**: watches the bridge folder's `roster-import.json` (written by
  the website) and writes it into every character's SavedVariables as soon
  as it appears.

**It needs no login or sync key**, and has exactly one narrow network access:
checking `raidlead.vercel.app/updates/version.json` every few hours to see if
a newer version exists (see `src/updater.js`). Everything else -- loot
export, roster import -- is pure local file I/O, exactly like the PowerShell
script it replaces. The website's browser-based Connect Bridge Folder / Sync
Now flow is unchanged; this app just makes sure the local file conversion
happens automatically and reliably in the background, without a scheduled
task or hidden console window.

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

## Why this exists instead of the `.bat`/Task Scheduler setup

That approach turned out to be fragile in ways only found by testing against
a real machine, not from reading the code:

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
automatically), browse to your WoW AddOns folder (the one you copied
`RaidLead` into), and browse to your `RaidLead Docs` bridge folder (the same
one connected on the website's Loot tab). That's it -- which WoW account is
yours is re-detected automatically every time, same as the PowerShell
script, so there's nothing to pick.

"Start automatically when Windows starts" is on by default -- turn it off in
Settings if you'd rather launch it manually.

## Packaging

`npm run dist` (electron-builder) produces an installer for distributing
this to whoever's actually running it. `assets/icon.png` is currently a 1x1
placeholder; swap in real branding art before shipping a build to anyone. An
unsigned `.exe` can still draw a SmartScreen prompt on first run -- code
signing would remove that, but is a separate cost/setup decision, not
something this app can route around on its own.
