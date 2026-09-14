# RaidLead (WoW addon)

Mirrors your RaidLead Raid Planner roster in-game with a live in-group/missing
checklist, and records boss loot (+ tier-relevant BoEs) for RaidLead's Loot
tab. The addon itself never talks to the network (no WoW addon can) — the
bridge to RaidLead's server is the **WoW Sync** box on the site's Loot tab,
via the small **RaidLead Companion** desktop app (see `../companion/`). See
the note on why a local helper app is needed at all, below.

This folder (`addon/RaidLead/`) is packaged together with a plain data folder
into one downloadable zip — `public/RaidLead-Download.zip`, rebuilt via
`scripts/build-download-zip.ps1` whenever either source folder changes —
that's what's linked from the site, so a real user never needs to know this
repo exists. It contains two top-level folders:

- **`RaidLead`** — this addon. Copy it into your WoW `Interface/AddOns/`
  directory, so you end up with `Interface/AddOns/RaidLead/RaidLead.toc`.
- **`RaidLead Docs`** — a plain data folder (no scripts in it) plus its own
  README. Put this folder **in your Documents folder** — not the Desktop
  (Windows' ransomware protection can silently block files from being
  created there) and not inside Program Files (the one place a website can
  never be granted access to). It's what lets the addon, RaidLead Companion,
  and the website read/write data back and forth; the addon captures loot
  fine without it, but nothing gets in or out of the game without it.

RaidLead Companion (`../companion/`) is the app that actually keeps
`RaidLead Docs` in sync with your WoW addon — download and install it
separately from the site's Loot tab (built via `npm run dist` in that
folder, producing `public/RaidLead-Companion-Setup.exe`). It replaced an
earlier PowerShell-script-plus-Task-Scheduler approach that turned out to be
too fragile in practice (antivirus flagging the scripts, Windows blocking
them on Desktop, orphaned scheduled tasks surviving even after being
"removed") — a normal always-running app avoids that whole class of problem.

## Before it does anything useful

1. Download and extract the zip (from the site's Loot tab, or
   `public/RaidLead-Download.zip` in this repo). Place the two folders as
   described above.
2. Download and install **RaidLead Companion** from the site's Loot tab. In
   its Settings, point it at your WoW AddOns folder and at **RaidLead Docs**.
   It finds your WoW account on its own — nothing to answer — and runs
   quietly in the background from then on (starts with Windows by default).
3. On RaidLead's **Loot tab**, click **Connect Bridge Folder** and select
   the **RaidLead Docs** folder, wherever you put it.
4. Click **Sync Now**. This queues your published Raid Planner roster for
   Companion to pick up (and uploads any loot it already pulled out of WoW).
5. Within moments, the roster lands in WoW's real files — `/reload` in-game
   to see it.
6. `/raidlead` (or click the minimap icon) opens the window — **Roster** and
   **Loot** tabs at the top.

No key, password, or account to link — the browser sync uses whatever
RaidLead account you're already logged into on the site. RaidLead Companion
needs no login either; it never makes a network request of any kind, only
copies files on your own PC (see the comment at the top of `companion/src/sync.js`
for exactly what it reads/writes).

**Why a local helper app is needed at all:** Chrome/Edge categorically refuse
to let a website access anything under `Program Files` — which is exactly
where Battle.net installs WoW by default — so the browser can never reach the
addon's save data directly. RaidLead Companion mirrors data between the real
WoW folder and the RaidLead Docs folder instead (wherever the user put it);
the website only ever touches that folder.

## Roster vs. Loot tabs, and getting data back out

The **Roster** tab is the mirrored plan + live in/out checklist described
above. The **Loot** tab shows everything captured *this session* (item ->
recipient, newest first) so you can see at a glance that it's working
without tabbing out to the website.

Capturing loot needs no folder access at all — the addon collects it live,
in memory, the whole time you're playing, same as any other addon reading
game events. Folder access only matters for the separate step of getting
that data **out** to RaidLead's server, and that's inherently limited by one
fact that no UI can work around: **no WoW addon can make a network call,
ever** — not on `/reload`, not on logout, not under any circumstance. So the
upload always happens through the browser, and the browser can only read
what WoW has already written to disk — by way of RaidLead Companion and the
RaidLead Docs folder, since it can't reach WoW's own save location directly.

The good news: WoW flushes SavedVariables to disk on **either** `/reload`
**or** a normal logout/exit (not just `/reload`) — so if you just log out
normally at the end of the night, your loot is already saved and ready for
the website to pick up. The **Prepare Loot for Sync** button on the Loot tab
exists for when you don't want to wait for that: it forces an immediate
`ReloadUI()` (with a confirmation popup explaining what it does) so this
session's data is on disk right now, before you go sync it on the site.

## Known things that need a real client to verify/tune

- **`## Interface:`** in `RaidLead.toc` needs to match your current client
  version, or WoW will refuse to load the addon (or flag it "out of date" —
  tick "Load out of date AddOns" as a stopgap). Check any other installed
  addon's `.toc` for the current number, or watch for Blizzard's own
  out-of-date warning.
- **Loot capture** (`Loot.lua`) is built on `CHAT_MSG_LOOT`, a long-standing
  chat event that reports every raid member's Personal Loot, not just your
  own — that mechanism is solid. Whether the client's Group Loot History
  panel would be a cleaner primary source is still an open question; if it
  turns out to be, that's the file to extend.
- **`RaidLead.TIER_TOKEN_ITEM_IDS`** (top of `Loot.lua`) starts empty. Fill
  it in with this tier's tier-token item IDs (Wowhead has them at the start
  of a tier) or tier-token detection won't flag anything.
- **`minTrackedItemLevel`** (`/raidlead ilvl <number>`, default 636 in
  `Core.lua`) is the floor for capturing non-boss BoEs. Bump it at the start
  of each new raid tier to match the current Champion track.
- The roster panel's layout math (`UI/RosterFrame.lua`) hasn't been seen
  rendered in a real client yet — expect to nudge spacing once you've
  actually looked at it in-game.
- Only one person needs this addon (whoever's tracking loot/roster for the
  raid) and to visit the Loot tab to sync — it's not meant to be installed
  raid-wide.
- The browser-based sync needs Chrome or Edge (Firefox/Safari don't
  implement the File System Access API) and re-verifies folder permission on
  every Sync click, since browsers require a fresh user gesture for that —
  the WoW-side of the pipeline (RaidLead Companion) runs fully in the
  background, but the browser-side click is still required for its own
  security model.
- **Minimap icon** (`UI/MinimapButton.lua`) is a small hand-rolled one, not
  the usual LibDBIcon community library — embedding third-party code we
  couldn't run/verify felt riskier than a plain, well-understood
  drag-to-reposition frame. `/raidlead minimap` toggles hiding it. Its icon
  and the addon's list icon (`## IconTexture` in the `.toc`) both use
  `Icon.png`, converted from `raidleaddiscordicon.jpg` — not yet confirmed
  PNG renders correctly as a custom UI texture in-game (should be fine on
  modern retail, but if it shows blank/a question mark, that means it
  needs converting to `.tga` or `.blp` instead).
