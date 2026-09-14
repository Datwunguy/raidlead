# RaidLead Docs

A plain data folder — nothing runs from inside it. It exists because Chrome/
Edge categorically refuse to let a website access anything under
`Program Files` (where WoW installs by default), so RaidLead's browser-based
sync can't reach your addon's saved data directly. The **RaidLead Companion**
app mirrors data between your real WoW folder and **this folder** instead,
and the website only ever touches this folder — never your WoW install
directly.

## Where to put this folder

**Put it in your Documents folder.** Not the Desktop — Windows' built-in
ransomware protection (Controlled Folder Access) treats Desktop as
protected and can silently block files from being created there. Not
inside `Program Files`/`Program Files (x86)` either — that's the one place
a website can never be granted access to.

## Use it

1. Put this whole folder in Documents (see above).
2. Download and install **RaidLead Companion** from the site's Loot tab —
   it's the small app that actually keeps this folder in sync with your
   WoW addon. Point it at your WoW AddOns folder and at this folder in its
   Settings.
3. Go to RaidLead's Loot tab, click **Connect Bridge Folder**, and select
   *this* folder (wherever you put it).

From there it's automatic: the Companion app watches for new loot and
writes it here as soon as it appears in-game, and picks up a freshly
published roster from the website within moments of it landing here. No
scripts to run, nothing to remember before or after a raid.
