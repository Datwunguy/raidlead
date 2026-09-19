# RaidLead (WoW addon)

Mirrors your RaidLead Raid Night roster in-game with a live in-group/missing
checklist, and records boss loot (+ tier-relevant BoEs) for RaidLead's Loot
tab. The addon itself never talks to the network (no WoW addon can) — the
**RaidLead Companion** desktop app (see `../companion/`) reads this addon's
saved data and talks to RaidLead's server directly, using its own login. See
the note on why a local helper app is needed at all, below.

This folder (`addon/RaidLead/`) is packaged into one downloadable zip —
`public/RaidLead-Download.zip`, rebuilt via `scripts/build-download-zip.ps1`
whenever it changes — that's what's linked from the site, so a real user
never needs to know this repo exists. Copy the extracted `RaidLead` folder
into your WoW `Interface/AddOns/` directory, so you end up with
`Interface/AddOns/RaidLead/RaidLead.toc`.

RaidLead Companion (`../companion/`) is the app that actually reads this
addon's data and keeps RaidLead in sync — download and install it separately
from the site's Loot tab (built via `npm run dist` in that folder, producing
`public/RaidLead-Companion-Setup.exe`, published as a GitHub Release since
it's too large to commit or deploy directly). It replaced an earlier
browser-based "bridge folder" relay (itself a replacement for an even older
PowerShell-script-plus-Task-Scheduler approach) once it got its own login and
no longer needed the browser as a go-between — see the note below.

## Before it does anything useful

1. Download and extract the zip (from the site's Loot tab, or
   `public/RaidLead-Download.zip` in this repo). Copy `RaidLead` into your
   AddOns folder as described above.
2. Download and install **RaidLead Companion** from the site's Loot tab. In
   its Settings, click **Log In** — this opens your browser to approve the
   request (you'll sign in with Battle.net there first if you aren't
   already). Also point it at your WoW AddOns folder; which WoW account is
   yours is found automatically from there.
3. That's it. Companion runs quietly in the background from then on (starts
   with Windows by default), uploading loot and pulling your published
   roster on its own — no folder to connect, no button to remember to click.
4. `/reload` in-game after publishing a new roster to see it land.
5. `/raidlead` (or click the minimap icon) opens the window — **Roster** and
   **Loot** tabs at the top.

**Why a local helper app is needed at all:** Chrome/Edge categorically refuse
to let a website access anything under `Program Files` — which is exactly
where Battle.net installs WoW by default — so a browser can never reach the
addon's save data directly. RaidLead Companion doesn't have that restriction
(it's a native app, same as WoW itself) and reads the real WoW folder
directly, then talks to RaidLead's server itself using the login from step 2
above — no browser involved in the sync at all anymore.

## Roster vs. Loot tabs, and getting data back out

The **Roster** tab is the mirrored plan + live in/out checklist described
above. The **Loot** tab shows everything captured *this session* (item ->
recipient, newest first) so you can see at a glance that it's working
without tabbing out to the website.

Capturing loot needs no folder access at all — the addon collects it live,
in memory, the whole time you're playing, same as any other addon reading
game events. WoW only flushes that in-memory data to the SavedVariables file
Companion reads on **either** `/reload` **or** a normal logout/exit, so a
raid's loot shows up shortly after anyone with the addon does one of those —
no manual step required. If you don't want to wait, the Loot tab's
**Prepare Loot for Sync** button just triggers that same `/reload` on demand.

## Known things that need a real client to verify/tune

- **`## Interface:`** in `RaidLead.toc` needs to match your current client
  version, or WoW will refuse to load the addon (or flag it "out of date" —
  tick "Load out of date AddOns" as a stopgap). Check any other installed
  addon's `.toc` for the current number, or watch for Blizzard's own
  out-of-date warning.
- **Loot capture** (`Loot.lua`) has two independent paths: Personal Loot via
  `CHAT_MSG_LOOT` (long-standing, solid) and Group Loot (Need/Greed roll) via
  the `C_LootHistory` API, added later and flagged in that file's header as
  needing live-client verification — test it in a 5-man with Group Loot set
  as the loot method before trusting it in a real raid.
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
  raid) and RaidLead Companion running — it's not meant to be installed
  raid-wide.
- **Minimap icon** (`UI/MinimapButton.lua`) is a small hand-rolled one, not
  the usual LibDBIcon community library — embedding third-party code we
  couldn't run/verify felt riskier than a plain, well-understood
  drag-to-reposition frame. `/raidlead minimap` toggles hiding it. Its icon
  and the addon's list icon (`## IconTexture` in the `.toc`) both use
  `Icon.png`, converted from `raidleaddiscordicon.jpg` — not yet confirmed
  PNG renders correctly as a custom UI texture in-game (should be fine on
  modern retail, but if it shows blank/a question mark, that means it
  needs converting to `.tga` or `.blp` instead).
