
// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
const STATE = {
  config:       null,
  players:      [],
  rosterRankFilter: 'all', // 'all' | 'main' | 'alt' -- which characters the Roster tab shows/computes stats over
  seasonsListLoadedFor: null, // teamId the season-history dropdown was last populated for -- avoids refetching on every renderRoster()
  scores:       [],
  bossNames:    [],
  zoneId:       null,
  zoneName:     '—',
  detectedZone: null,
  guildId:      null,
  teamId:       null,
  teams:        [],     // every team this account belongs to: [{teamId, teamName, role, guildId, guildName, guildServer}]
  addTeamMode:  false,  // true while the Settings screen is being used to add a sibling team
  myRole:       null,   // 'owner' | 'officer' | 'member' | 'viewer'
  raidPlanMode:      'view',      // 'view' | 'edit'
  raidPlanPublished: false,       // true when plan is published
  scoreDifficulty:   'mythic',    // 'lfr' | 'normal' | 'heroic' | 'mythic'
  teamName:          null,         // team name from DB
  scoreView:         'performance', // performance | firstkill | survival | oppoparse | mitigation
  scoreRoleFilter:   'all',         // 'all' | 'tank' | 'heal' | 'dps'
  scoreSortCol:      'best',        // 'best' | 'median' | a boss name -- always sorted highest-to-lowest
  scoreShowRaw:      false,         // false = show parse %, true = show raw DPS/HPS (per-boss cells only)
  scoresDifficulty:  null,          // difficulty STATE.scores was fetched/loaded for
  survivorMap:       {},            // per-player per-boss survival % from guild reports
  survivorFetched:   false,         // whether survival data has been fetched
  survivorMapDifficulty:   null,    // difficulty STATE.survivorMap was fetched/loaded for
  mitigationMap:     {},            // per-player per-boss mitigation % from guild reports
  mitigationFetched: false,          // whether mitigation data has been fetched
  mitigationMapDifficulty: null,    // difficulty STATE.mitigationMap was fetched/loaded for
  claimedCharacter:  null,           // the first character this logged-in account has claimed (back-compat; see claimedCharacters for the full list)
  claimedCharacters: [],             // every character this logged-in account has claimed on the active team (Main + Alt(s))
  attendanceActingAs: null,          // which of claimedCharacters attendance is currently being marked for
  attendanceExtraDays: [],           // one-off raid nights, array of 'YYYY-MM-DD' strings
  attendanceMarks:     [],           // [{character_name, raid_date, status}]
  attendanceMonth:     new Date(new Date().getFullYear(), new Date().getMonth(), 1), // first-of-month Date being viewed
  attendanceLoaded:    false,
  plannerDate:         null,         // 'YYYY-MM-DD' string for the raid night currently being planned
  plannerSwaps:        [],           // [{id, boss, outName, inName}] boss-by-boss swaps against the published roster
  progressDifficulty:  'mythic',     // 'normal' | 'heroic' | 'mythic' for the Progress tab
  progressCache:       {},           // per raidSlug+difficulty cached response from /api/raiderio
  progressRaidSlug:    null,         // null = current raid (auto-detected from WCL zone); otherwise a past tier's slug
  progressRaidsList:   null,         // cached /api/raiderio?action=listRaids response, fetched once per session
};

// ── Global fetch wrapper: automatically adds credentials for all /api/ calls ──
const _origFetch = window.fetch.bind(window);
window.fetch = function(url, opts = {}) {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    opts = { ...opts, credentials: 'include' };
    // Remove any stale Authorization header — auth is now cookie-based
    if (opts.headers) {
      const h = { ...opts.headers };
      delete h['Authorization'];
      delete h['authorization'];
      opts.headers = h;
    }
  }
  return _origFetch(url, opts);
};


// ─────────────────────────────────────────────
//  PERSISTENCE — localStorage + URL params
// ─────────────────────────────────────────────
const STORAGE_KEY  = 'raidlead_config';
const SESSION_KEY  = 'raidlead_session_data';
const SCORES_KEY   = 'raidlead_scores';
// Returns a localStorage key scoped to the current difficulty
// Per team: an account on two teams must never see one team's cached
// scores on the other (same zone, same difficulty).
function scoresKey() { return SCORES_KEY + '_' + (STATE.teamId || 'none') + '_' + (STATE.scoreDifficulty || 'mythic'); }

// Score caches from before they were per team -- dropped once, since they
// can't say which team they belong to.
(function dropSharedScoreCaches() {
  try {
    Object.keys(localStorage)
      .filter(k => /^raidlead_(scores_(lfr|normal|heroic|mythic)|mitigation_\d+_\w+|survival_\d+_\w+)$/.test(k))
      .forEach(k => localStorage.removeItem(k));
  } catch (e) {}
})();
const ZONE_BAN_KEY = 'raidlead_zone_dismissed'; // tracks which zones user already dismissed

function saveScores(scores, bossNames, zoneId) {
  try {
    localStorage.setItem(scoresKey(), JSON.stringify({ scores, bossNames, zoneId, fetchedAt: Date.now() }));
  } catch(e) {}
}

function clearCachedScores() {
  try { localStorage.removeItem(scoresKey()); } catch(e) {}
}

function getDismissedZone() {
  try { return parseInt(localStorage.getItem(ZONE_BAN_KEY)) || 0; } catch(e) { return 0; }
}

function setDismissedZone(zoneId) {
  try { localStorage.setItem(ZONE_BAN_KEY, zoneId); } catch(e) {}
}

function formatTimeAgo(ts) {
  if (!ts) return 'never';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function saveConfig(config) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch(e) {}
}

function loadSavedConfig() {
  // 1. URL params first — shareable link takes priority
  const params = new URLSearchParams(window.location.search);
  if (params.get('guild')) {
    return {
      guild:      params.get('guild')      || '',
      server:     params.get('server')     || '',
      region:     params.get('region')     || 'us',
      difficulty: params.get('difficulty') || 'mythic',
      wclUrl:     params.get('wclUrl')     || '',
      wclTeamId:  params.get('wclTeamId') || null,
      zoneId:     parseInt(params.get('zoneId')) || null,
    };
  }
  // 2. Fall back to localStorage
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch(e) { return null; }
}

function generateShareUrl(config) {
  const base   = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({
    guild:      config.guild,
    server:     config.server,
    region:     config.region,
    difficulty: config.difficulty,
    wclUrl:     config.wclUrl,
    wclTeamId:  config.wclTeamId || '',
    zoneId:     config.zoneId,
  });
  return base + '?' + params.toString();
}

function copyShareUrl() {
  const url = generateShareUrl(STATE.config);
  navigator.clipboard.writeText(url).then(() => {
    showToast('Share link copied to clipboard!', 'success');
  }).catch(() => {
    prompt('Copy this link:', url);
  });
}

// Auth-aware page initialization
// Safety net for the boot loading screen -- if something unexpected hangs
// or throws partway through the boot sequence below (before it reaches any
// showXScreen() call), don't leave the user staring at a spinner forever
// with no way out.
setTimeout(() => {
  const el = document.getElementById('boot-loading-screen');
  if (el && el.style.display !== 'none') {
    const stuck = document.getElementById('boot-loading-stuck');
    if (stuck) stuck.style.display = 'block';
  }
}, 15000);

window.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);

  // Wire up raid-day-chip toggles in both setup forms
  initRaidDayChips();

  // Build the mobile hamburger nav from the real .nav-btn tabs
  initMobileNav();

  // Back from Battle.net sign-in (?bnet_sync=started|no_permission)
  readBnetSyncParam();

  // Handle a Next Season survey link (?survey=<teamId>) -- before the
  // invite handler, which resets the URL
  checkSurveyParam();

  // Handle pending invite link
  checkInviteParam();

  // Handle a RaidLead Companion pairing link (?companion-pair=<code>)
  checkCompanionPairParam();

  // Handle the "Connect to Discord" OAuth redirect result
  const discordConnected   = urlParams.get('discord_connected');
  const discordConnectErr  = urlParams.get('discord_connect_error');
  if (discordConnected || discordConnectErr) {
    window.history.replaceState({}, '', '/');
    if (discordConnected) {
      setTimeout(() => showToast('Discord connected!', 'success'), 300);
    } else if (discordConnectErr) {
      setTimeout(() => showToast('Discord connect failed: ' + discordConnectErr, 'error'), 300);
    }
  }

  // Handle auth errors from Battle.net callback. Someone who's still signed
  // in (e.g. they cancelled Blizzard's permission screen from the Connect
  // prompt) stays signed in; only a failed sign-in goes to the login screen.
  const authError = urlParams.get('auth_error');
  if (authError) window.history.replaceState({}, '', '/');

  // Kick off the active-team lookup concurrently with the session check right
  // below -- both re-authenticate independently via the session cookie
  // server-side, so nothing actually requires waiting for one before
  // starting the other. Awaited later, once we know there's no pending
  // invite (which needs fresh post-join data instead and ignores this).
  // Cuts a full network round trip off every normal boot.
  const activeGuildDataPromise = fetchActiveGuildData().catch(() => null);

  // Verify session via cookie — retry once to handle timing after OAuth redirect
  let sessionAccount = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 300));
      const sessResp = await fetch('/api/auth?action=session');
      if (sessResp.ok) {
        const sessData = await sessResp.json();
        if (sessData.account) { sessionAccount = sessData.account; break; }
      }
    } catch(e) {}
  }
  if (!sessionAccount) {
    if (authError) {
      const banner = document.getElementById('auth-error-banner');
      if (banner) {
        banner.textContent = 'Sign in failed: ' + authError.replace(/_/g, ' ') + '. Please try again.';
        banner.style.display = 'block';
      }
    }
    showLoginScreen();
    return;
  }
  if (authError) {
    clearBnetSyncPending();
    setTimeout(() => showToast(authError === 'access_denied' ? 'Battle.net connection cancelled' : "Couldn't sync with Battle.net. Try again later.", 'error'), 300);
  }
  AUTH.session = { id: sessionAccount.id, battletag: sessionAccount.battletag, bnetSynced: !!sessionAccount.wow_characters_synced_at, bnetSync: sessionAccount.wow_sync || null };

  // Show battletag in header immediately
  if (sessionAccount.battletag) {
    document.getElementById('account-battletag').textContent  = sessionAccount.battletag;
    document.getElementById('dropdown-battletag').textContent = sessionAccount.battletag;
    document.getElementById('account-menu').style.display = 'flex';
  }

  // Unawaited -- shows its own confirm modal asynchronously if there's a
  // pending Companion pairing; never blocks the rest of boot.
  checkPendingCompanionPair();

  // Check for pending invite FIRST — before checking saved config
  // This ensures first-time invite users skip guild setup entirely.
  // pendingInvite is just the team's join code (see checkInviteParam) --
  // join-guild resolves it server-side, so there's nothing to trust from
  // localStorage here beyond "try this code once."
  const pendingInvite = localStorage.getItem('raidlead_pending_invite');
  if (pendingInvite) {
    localStorage.removeItem('raidlead_pending_invite');
    try {
      const joinResp = await fetch('/api/auth?action=join-guild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ joinCode: pendingInvite }),
      });
      const joinData = await joinResp.json();
      if (!joinResp.ok) throw new Error(joinData.error || 'That invite is no longer valid.');
      if (joinData.role) applyRolePermissions(joinData.role);

      // Fetch fresh team data to populate config, teamId, and claimedCharacter
      const freshData = await fetchGuildFromDB(joinData.teamId);
      if (!freshData || !freshData.team) throw new Error('Joined, but could not load team data.');
      applyGuildData(freshData);

      try { await loadRosterFromDB(); } catch(e) {}

      showDashboard(freshData);
      showToast(joinWelcomeMessage(), 'success');
      checkAndAdvanceSeason();
      return;
    } catch(e) {
      showToast(e.message || 'Could not use that invite link.', 'error');
    }
  }

  // Supabase is always the source of truth — this awaits the lookup already
  // kicked off above (typically already settled by now, since it's been
  // running in parallel with the session check this whole time), falling
  // back to localStorage for offline/share-link flows, or setup if nothing
  // found at all.
  const guildData = await activeGuildDataPromise;

  if (guildData && guildData.team) {
    applyGuildData(guildData);
    await loadRosterFromDB();


    showDashboard(guildData);
    updateRosterTitle();
    // Pre-load attendance data so marks are available immediately on any tab
    loadAttendanceData();
    checkAndAdvanceSeason(); // silent, best-effort -- never blocks the dashboard
    return;
  }

  // Fall back to localStorage config (share-link or pre-DB flow)
  const saved = loadSavedConfig();
  if (saved && saved.guild) {
    STATE.config   = saved;
    applyGameRules(saved.game);
    // Restore wclTeamId from localStorage if not in saved config
    if (!STATE.config.wclTeamId) {
      STATE.config.wclTeamId = localStorage.getItem('raidlead_wcl_team_id') || null;
    }
    STATE.zoneId   = saved.zoneId;
    STATE.zoneName = saved.zoneName || '—';

    try {
      if (!saved.wclUrl) {
        try {
          const detected = await detectCurrentZone();
          if (detected && detected.id !== saved.zoneId && getDismissedZone() !== detected.id) {
            STATE.detectedZone = detected;
          }
        } catch(e) {}
      }

      await loadRosterFromDB();
      showDashboard();
      loadCachedScores();
    } catch(e) {
      showGuildSetup();
    }
  } else {
    // Truly new user — no guild in DB or localStorage
    showLandingChoice();
  }
});

const CLASS_COLORS = {
  'death knight':'#C41E3A','demon hunter':'#A330C9','druid':'#FF7C0A',
  'evoker':'#33937F','hunter':'#AAD372','mage':'#69CCF0','monk':'#00FCB8',
  'paladin':'#F48CBA','priest':'#FFFFFF','rogue':'#FFF468','shaman':'#446AE3',
  'warrior':'#C79C6E','warlock':'#9482C9',
};

// "sargeras" or "twisting-nether" -> "Sargeras" / "Twisting Nether" -- for
// display and for pre-filling/blurring server-name inputs. Mirrors
// lib/serverSlug.js's serverDisplayFromSlug on the backend.
function titleCaseServer(raw) {
  return String(raw || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── The active team's WoW version (public/games.js): classes, specs, raid
// buffs and utility, difficulties and raid sizes, tier token groups, and
// where its data lives. Retail until a team loads; applyGameRules() switches
// it whenever a team's data is applied. ──
const GAMES_API = window.RAIDLEAD_GAMES;
let GAME = GAMES_API.gameFor('retail');
// Every class's specs and the raid role each fills, in this version.
let CLASS_SPECS = GAME.specs;

// A difficulty of this version by key ("mythic", "heroic25", "raid40"),
// or its default: { key, label, wcl (WCL difficulty id), size? }.
function difficultyInfo(key) {
  return GAME.difficulties.find(d => d.key === key)
    || GAME.difficulties.find(d => d.key === GAME.defaultDifficulty) || GAME.difficulties[0];
}

// Does anyone in `players` provide this raid buff/utility? A provider can
// need a spec (Moonkin Aura: Balance druids); someone with no spec on file
// counts when their role is that spec's.
function playerHasSpec(p, spec) {
  if (p.spec) return p.spec === spec;
  const role = (CLASS_SPECS[p.class] || []).find(([name]) => name === spec)?.[1];
  return !!role && role === (['heal', 'healer'].includes(p.role) ? 'heal' : p.role);
}
const providerPresent = (pr, players) => players.some(p => p.class === pr.class && (!pr.spec || playerHasSpec(p, pr.spec)));
const buffCovered = (b, players) => b.providers.some(pr => providerPresent(pr, players));
const providerLabel = pr => (pr.spec ? `${pr.spec} ${titleCaseClass(pr.class)}` : titleCaseClass(pr.class));

// What a buff/utility pill shows. Covered: the buff, and who's bringing it.
// Missing: the class to bring (Retail's single-class buffs), or the buff and
// everyone who could bring it (Classic's shared ones).
function buffPill(b, players) {
  const present = b.providers.filter(pr => providerPresent(pr, players));
  if (present.length) {
    const classes = [...new Set(present.map(pr => pr.class))];
    return { covered: true, color: CLASS_COLORS[classes[0]] || '#888', title: b.name, sub: classes.map(c => c.toUpperCase()).join(' · ') };
  }
  const simple = b.providers.length === 1 && !b.providers[0].spec;
  return simple
    ? { covered: false, color: null, title: b.providers[0].class.toUpperCase(), sub: '' }
    : { covered: false, color: null, title: b.name, sub: b.providers.map(providerLabel).join(' / ') };
}

// "Oceanic" is a RaidLead-only region choice (it only changes which Raider.io
// rankings pool the Progress tab compares against) -- Oceanic realms are
// still part of Blizzard's/WCL's "us" game region, so WCL queries need the
// real Blizzard region code, never "oceanic" itself.
function toWclRegion(region) {
  return region === 'oceanic' ? 'us' : region;
}

function setScoreDifficulty(diff, btn) {
  STATE.scoreDifficulty = diff;
  document.querySelectorAll('#difficulty-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  if (STATE.scoreView === 'mitigation') {
    STATE.mitigationMap           = {};
    STATE.mitigationFetched       = false;
    STATE.mitigationMapDifficulty = diff;
    const loaded = loadCachedMitigation();
    if (!loaded) {
      document.getElementById('scores-table-wrap').innerHTML = '<div class="empty-state"><div class="empty-state-icon">🛡</div><h3>No ' + difficultyInfo(diff).label.toUpperCase() + ' Mitigation Data</h3><p>Click "Refresh Scores" to fetch mitigation data.</p></div>';
    }
    return;
  }

  if (STATE.scoreView === 'survival') {
    // Reset survival data when difficulty changes and try to load cached version
    STATE.survivorMap           = {};
    STATE.survivorFetched       = false;
    STATE.survivorMapDifficulty = diff;
    const loaded = loadCachedSurvival();
    if (!loaded) {
      document.getElementById('scores-table-wrap').innerHTML = '<div class="empty-state"><div class="empty-state-icon">🛡</div><h3>No ' + difficultyInfo(diff).label.toUpperCase() + ' Survival Data</h3><p>Click "Refresh Scores" to fetch survival data.</p></div>';
    }
    return;
  }

  STATE.scores           = [];
  STATE.bossNames        = [];
  STATE.scoresDifficulty = diff;
  const loaded = loadCachedScores();
  if (!loaded) {
    document.getElementById('scores-table-wrap').innerHTML = '<div class="empty-state"><div class="empty-state-icon">📊</div><h3>No ' + difficultyInfo(diff).label.toUpperCase() + ' Scores</h3><p>Click "Fetch Scores" to load ' + difficultyInfo(diff).label.toUpperCase() + ' data from Warcraft Logs.</p></div>';
    document.getElementById('scores-timestamp').textContent = '';
  }
}

// ─────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────
function showSetup() {
  document.getElementById('setup-screen').style.display       = 'flex';
  document.getElementById('dashboard').style.display          = 'none';
  document.getElementById('login-screen').style.display       = 'none';
  document.getElementById('guild-setup-screen').style.display = 'none';
  document.getElementById('main-nav').style.display           = 'none';
  document.getElementById('guild-badge').style.display        = 'none';
  const _shareBtnSetup = document.getElementById('share-btn');
  if (_shareBtnSetup) _shareBtnSetup.style.display = 'none';

  document.getElementById('cancel-btn').style.display = STATE.config ? 'block' : 'none';
  document.getElementById('load-btn').disabled = false;
  setStatus('', '');

  const addTeamRow   = document.getElementById('add-team-row');
  const multiTeamRow = document.getElementById('multi-team-row');
  const guildIdFieldIds = ['inp-guild', 'inp-server', 'inp-region'];

  if (STATE.addTeamMode) {
    document.getElementById('setup-heading').textContent = 'Add a Team';
    document.getElementById('setup-subheading').textContent =
      `Creates a new, independent team under ${STATE.config?.guild || 'this guild'} — its own roster, join code, and WCL setup. You'll be its owner.`;
    document.getElementById('load-btn').textContent = 'Create Team';
    if (addTeamRow) addTeamRow.style.display = 'none';
    // The "Multiple Teams?" question doesn't apply here -- adding a 2nd team already
    // answers it. Hide the question/radios but keep the row itself visible so its
    // nested Team Name input (required by submitAddTeam) is reachable.
    ['multi-team-label', 'multi-team-yes-label', 'multi-team-no-label', 'settings-team-note']
      .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    const settingsTeamLabel = document.getElementById('settings-team-label');
    if (settingsTeamLabel) settingsTeamLabel.style.display = 'block';
    const settingsTeamRow = document.getElementById('settings-team-row');
    if (settingsTeamRow) settingsTeamRow.style.display = 'flex';
    const addTeamWclRow = document.getElementById('settings-wcl-team-row');
    if (addTeamWclRow) addTeamWclRow.style.display = 'block';

    // Guild identity is shared and fixed here -- pre-fill and lock it
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    set('inp-guild',  STATE.config?.guild);
    set('inp-server', titleCaseServer(STATE.config?.server));
    set('inp-region', STATE.config?.region);
    guildIdFieldIds.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = true; });

    // Team-specific fields start blank -- this is a brand new team, with no
    // zone until WCL credentials are connected and detection runs.
    set('inp-wcl-team', '');
    set('inp-team', '');
    setRaidDaysOn('inp-raid-days', []);
    return;
  }

  // Not in Add-a-Team mode -- make sure the question/radios (possibly hidden by a
  // previous Add-a-Team visit) are back to their normal state.
  ['multi-team-label', 'multi-team-yes-label', 'multi-team-no-label']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });
  const settingsTeamLabelReset = document.getElementById('settings-team-label');
  if (settingsTeamLabelReset) settingsTeamLabelReset.style.display = 'none';

  guildIdFieldIds.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
  document.getElementById('setup-heading').textContent = 'Configure Your Guild';
  document.getElementById('setup-subheading').textContent = 'Enter your guild details to get started. You only need to do this once.';
  document.getElementById('load-btn').textContent = STATE.config ? 'Save Changes' : 'Load Guild';
  if (addTeamRow)   addTeamRow.style.display   = STATE.config ? 'grid' : 'none';
  if (multiTeamRow) multiTeamRow.style.display = '';

  // Pre-populate with current config
  if (STATE.config) {
    const s = STATE.config;
    const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
    set('inp-guild',    s.guild);
    set('inp-server',   titleCaseServer(s.server));
    set('inp-region',   s.region);
    const gameNote = document.getElementById('settings-game-note');
    if (gameNote) gameNote.textContent = `Game: ${GAME.label}${GAME.beta ? ' (launches November 4)' : ''}`;
    const wclLink = document.getElementById('wcl-clients-link');
    if (wclLink && GAME.sources.wclHost) {
      wclLink.href = `https://${GAME.sources.wclHost}.warcraftlogs.com/api/clients/`;
      wclLink.textContent = `${GAME.sources.wclHost}.warcraftlogs.com/api/clients`;
    }

    set('inp-wcl-team',  s.wclTeamId);
    set('inp-discord-guild', STATE.discordGuildId);
    renderDiscordConnectStatus();
    set('inp-wcl-client-id', s.wclClientId);
    renderWclCredsStatus();
    renderWowauditKeyStatus();
    setRaidDaysOn('inp-raid-days', s.raidDays);

    // Pre-populate team name if set
    const currentTeamName = STATE.teamName;
    if (currentTeamName && currentTeamName !== 'Main Team') {
      const yesRadio = document.querySelector('input[name="inp-multi-team"][value="yes"]');
      if (yesRadio) { yesRadio.checked = true; toggleSettingsTeam(yesRadio); }
      set('inp-team', currentTeamName);
    } else {
      const noRadio = document.querySelector('input[name="inp-multi-team"][value="no"]');
      if (noRadio) { noRadio.checked = true; toggleSettingsTeam(noRadio); }
    }
  }
}

function cancelSetup() {
  STATE.addTeamMode = false;
  ['inp-guild', 'inp-server', 'inp-region'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = false;
  });
  document.getElementById('setup-screen').style.display  = 'none';
  document.getElementById('dashboard').style.display     = 'block';
  document.getElementById('main-nav').style.display      = 'flex';
  document.getElementById('guild-badge').style.display   = 'flex';
  applyRolePermissions(localStorage.getItem('raidlead_my_role') || 'member');

}

// Switches the Settings screen into "add a sibling team" mode (locked guild
// identity, blank team-specific fields) -- reachable from an existing team's
// own settings, as a shortcut equivalent to hitting "already exists" during
// Create Guild and choosing to make a new team.
function showAddTeamScreen() {
  STATE.addTeamMode = true;
  showSetup();
}

async function submitAddTeam() {
  const teamName  = document.getElementById('inp-team').value.trim();
  const wclTeamId = document.getElementById('inp-wcl-team').value.trim() || null;
  const raidDays  = getRaidDaysFrom('inp-raid-days');

  if (!teamName) {
    setStatus('Please fill in Team Name.', 'error');
    return;
  }

  setStatus('Creating team...', 'loading');
  document.getElementById('load-btn').disabled = true;

  try {
    const resp = await fetch('/api/guild?action=addTeam', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, teamName, wclTeamId, raidDays }),
    });
    const data = await resp.json();

    if (!resp.ok) throw new Error(data.error || 'Failed to create team');

    STATE.addTeamMode = false;
    ['inp-guild', 'inp-server', 'inp-region'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });
    showToast(`Team "${teamName}" created! Switching to it now.`, 'success');
    await switchActiveTeam(data.team.id);
  } catch(e) {
    setStatus('Error: ' + e.message, 'error');
    document.getElementById('load-btn').disabled = false;
  }
}

// Wire up raid-day-chip click toggles for any chip container on the page
function initRaidDayChips() {
  document.querySelectorAll('.raid-day-chip').forEach(chip => {
    if (chip.dataset.wired) return;
    chip.dataset.wired = '1';
    chip.addEventListener('click', () => {
      const cb = chip.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      chip.classList.toggle('active', cb.checked);
    });
  });
}

function getRaidDaysFrom(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  return [...container.querySelectorAll('input[type="checkbox"]:checked')].map(cb => parseInt(cb.value));
}

function setRaidDaysOn(containerId, days) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const daySet = new Set((days || []).map(d => parseInt(d)));
  container.querySelectorAll('.raid-day-chip').forEach(chip => {
    const cb = chip.querySelector('input[type="checkbox"]');
    const isOn = daySet.has(parseInt(cb.value));
    cb.checked = isOn;
    chip.classList.toggle('active', isOn);
  });
}

async function loadGuild() {
  if (STATE.addTeamMode) return submitAddTeam();
  const guild      = document.getElementById('inp-guild').value.trim();
  const server     = document.getElementById('inp-server').value.trim();
  const region     = document.getElementById('inp-region').value;
  const difficulty = STATE.config?.difficulty || GAME.defaultDifficulty;
  const wclTeamId  = document.getElementById('inp-wcl-team').value.trim() || null;
  const multiTeam  = document.querySelector('input[name="inp-multi-team"]:checked')?.value === 'yes';
  const teamName   = (multiTeam ? document.getElementById('inp-team')?.value.trim() : '') || 'Main Team';
  const raidDays   = getRaidDaysFrom('inp-raid-days');

  if (!guild || !server) {
    setStatus('Please fill in Guild Name and Server.', 'error'); return;
  }

  // zoneId/zoneName are no longer settable here -- they're auto-detected in
  // the background (checkAndAdvanceSeason) and left untouched by this form.
  STATE.config = { ...STATE.config, guild, server, region, difficulty, wclTeamId, raidDays };

  setStatus('Saving...', 'loading');
  document.getElementById('load-btn').disabled = true;

  try {
    // Update this team's (and, since it's shared, the guild's) settings.
    const resp = await fetch('/api/guild?action=update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, guild, server, region, teamName, wclTeamId, raidDays }),
    });
    const data = await resp.json();

    if (!resp.ok) throw new Error(data.error || 'Failed to save changes');
    // Persist updated config to localStorage so refresh picks it up immediately
    localStorage.setItem('raidlead_config', JSON.stringify(STATE.config));
    STATE.teamName = data.team?.name || teamName;
    await loadRosterFromDB();
    saveConfig(STATE.config);
    showDashboard();
    updateRosterTitle();
    showToast('Guild settings saved!', 'success');
  } catch(e) {
    setStatus('Error: ' + e.message, 'error');
    document.getElementById('load-btn').disabled = false;
  }
}

function setStatus(msg, type='') {
  const el = document.getElementById('setup-status');
  el.textContent = msg;
  el.className = 'status-msg ' + type;
}

// ─────────────────────────────────────────────
//  ROSTER — read from the characters table (the source of truth; officers
//  add/edit/remove directly, and/or use "Import from WowAudit" to bulk-add).
//  Item level is fetched separately (loadRosterIlvls below) and never
//  blocks this -- see there for why.
// ─────────────────────────────────────────────
async function loadRosterFromDB(force) {
  const url = `/api/roster?action=list&teamId=${encodeURIComponent(STATE.teamId)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Could not load the roster.');
  STATE.players = data.players || [];

  // Item level comes from live Raider.io lookups, which can be slow or
  // occasionally degraded (this app has hit real Raider.io outages before)
  // -- fire this in the background rather than await it, so the roster
  // itself (name/class/role, all from our own DB) never has to wait on an
  // external service just to appear. Callers that already re-render after
  // loadRosterFromDB will show ilvl as "—" for a moment, then this fills it
  // in and re-renders the Roster tab if it's the one currently showing.
  loadRosterIlvls(force);
}

async function loadRosterIlvls(force) {
  if (!STATE.teamId) return;
  try {
    const url = `/api/roster?action=listIlvl&teamId=${encodeURIComponent(STATE.teamId)}` + (force ? '&force=true' : '');
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) return;
    const ilvls = data.ilvls || {};
    STATE.players.forEach(p => { if (p.name in ilvls) p.ilvl = ilvls[p.name]; });
    if (document.getElementById('tab-roster')?.classList.contains('active')) renderRoster();
  } catch (e) { /* ilvl just stays at 0/placeholder -- not critical */ }
}

async function importFromWowaudit() {
  if (!STATE.config?.hasWowauditKey) return showWowauditKeyPrompt();
  const btn = document.getElementById('wowaudit-import-btn');
  if (btn) { btn.textContent = 'Importing...'; btn.disabled = true; }
  try {
    const resp = await fetch('/api/wowaudit?action=import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId }),
    });
    const data = await resp.json();
    if (data.wowauditNotConfigured) {
      // The key was cleared since this page loaded (e.g. by another officer).
      STATE.config.hasWowauditKey = false;
      renderWowauditKeyStatus();
      return showWowauditKeyPrompt();
    }
    if (!resp.ok) throw new Error(data.error || 'Import failed');

    await loadRosterFromDB(true);
    renderRoster();
    loadFlexData();
    showToast(`Imported ${data.imported} character${data.imported === 1 ? '' : 's'} from WowAudit!`, 'success');
    loadOfficerNudge();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.textContent = '⬇ Import from WowAudit'; btn.disabled = false; }
  }
}

// No WowAudit key yet: say what's needed, and take them to where it goes.
function showWowauditKeyPrompt() {
  document.getElementById('wowaudit-key-modal').classList.add('open');
}

function closeWowauditKeyPrompt(goToSettings) {
  document.getElementById('wowaudit-key-modal').classList.remove('open');
  if (!goToSettings) return;
  showSetup();
  const help  = document.getElementById('wowaudit-key-help');
  const input = document.getElementById('inp-wowaudit-key');
  if (help) help.open = true;
  if (input) setTimeout(() => {
    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    input.focus({ preventScroll: true });
  }, 50);
}

// ── ADD/EDIT/REMOVE CHARACTER MODAL (officers only) ──
let CHARACTER_MODAL_EDIT_ID     = null;
let CHARACTER_MODAL_ORIGINAL_NAME = null;
let CHARACTER_MODAL_JOIN_SOURCE  = null; // 'recruit' when opened from Team Management > Recruits (for Join Order)

function populateClassDropdown(selectId, selected) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = GAME.classes.map(c =>
    `<option value="${c}">${c.replace(/\b\w/g, ch => ch.toUpperCase())}</option>`
  ).join('');
  if (selected) sel.value = selected;
}

// Spec options for a class; the role always follows the spec. Picks the given
// spec, else the first one filling `fallbackRole`, else the class's first.
function populateSpecDropdown(cls, selectedSpec, fallbackRole) {
  const sel = document.getElementById('cm-spec');
  if (!sel) return;
  const specs = CLASS_SPECS[cls] || [];
  const pick = canonicalSpecFor(cls, selectedSpec)
    || specs.find(([, role]) => role === fallbackRole)?.[0] || specs[0]?.[0] || '';
  sel.innerHTML = specs.map(([name]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  sel.value = pick;
  updateSpecRoleLabel();
}

const SPEC_ROLE_NAMES = { tank: 'Tank', heal: 'Healer', melee: 'Melee', ranged: 'Ranged' };

// The role the chosen class + spec fills.
function characterModalRole() {
  const cls = document.getElementById('cm-class')?.value;
  const spec = document.getElementById('cm-spec')?.value;
  return (CLASS_SPECS[cls] || []).find(([name]) => name === spec)?.[1] || null;
}

function updateSpecRoleLabel() {
  const el = document.getElementById('cm-role-label');
  const role = characterModalRole();
  if (el) el.textContent = role ? `· ${SPEC_ROLE_NAMES[role]}` : '';
}

// ── Name suggestions (Raider.io search) as an officer types a character name ──
const NAME_SEARCH = { timer: null, seq: 0, results: [], active: -1 };

function onCharacterNameInput() {
  clearTimeout(NAME_SEARCH.timer);
  const term = document.getElementById('cm-name').value.trim();
  NAME_SEARCH.seq++; // anything still in flight is now out of date
  if (term.length < 2) return hideNameSuggestions();
  NAME_SEARCH.timer = setTimeout(() => searchCharacterNames(term), 300);
}

async function searchCharacterNames(term) {
  const seq = ++NAME_SEARCH.seq;
  try {
    const data = await recruitingApi('searchCharacters', { term });
    if (seq !== NAME_SEARCH.seq) return; // they kept typing
    NAME_SEARCH.results = data.results || [];
    NAME_SEARCH.active = -1;
    renderNameSuggestions();
  } catch (e) {
    hideNameSuggestions(); // no suggestions -- typing the name still works
  }
}

function renderNameSuggestions() {
  const el = document.getElementById('cm-name-suggestions');
  if (!el) return;
  const list = NAME_SEARCH.results;
  if (!list.length || document.activeElement?.id !== 'cm-name') return hideNameSuggestions();
  el.innerHTML = list.map((c, i) => {
    const onRoster = (STATE.players || []).some(p => p.name.toLowerCase() === c.name.toLowerCase() && p.server === c.realmSlug);
    return `<button type="button" class="name-suggest-item${i === NAME_SEARCH.active ? ' active' : ''}" role="option"
      onmousedown="event.preventDefault()" onclick="pickNameSuggestion(${i})">
      <span class="name-suggest-name" style="color:${CLASS_COLORS[c.class] || 'var(--text)'};">${escapeHtml(c.name)}</span>
      <span class="name-suggest-realm">${escapeHtml(c.realmName)}${c.class ? ' · ' + escapeHtml(c.class.replace(/\b\w/g, ch => ch.toUpperCase())) : ''}</span>
      ${onRoster ? '<span class="recruit-badge on-roster">On roster</span>' : ''}
    </button>`;
  }).join('');
  el.style.display = 'block';
}

function hideNameSuggestions() {
  const el = document.getElementById('cm-name-suggestions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  NAME_SEARCH.active = -1;
}

function onCharacterNameKey(event) {
  const n = NAME_SEARCH.results.length;
  const open = document.getElementById('cm-name-suggestions')?.style.display === 'block';
  if (!open || !n) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    NAME_SEARCH.active = (NAME_SEARCH.active + (event.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderNameSuggestions();
  } else if (event.key === 'Enter' && NAME_SEARCH.active >= 0) {
    event.preventDefault();
    pickNameSuggestion(NAME_SEARCH.active);
  } else if (event.key === 'Escape') {
    hideNameSuggestions();
  }
}

// Fills name, server, and class from the pick, then their spec from Raider.io.
function pickNameSuggestion(i) {
  const c = NAME_SEARCH.results[i];
  if (!c) return;
  hideNameSuggestions();
  NAME_SEARCH.seq++;
  document.getElementById('cm-name').value = c.name;
  document.getElementById('cm-server').value = c.realmName;
  if (c.class && CLASS_COLORS[c.class]) {
    document.getElementById('cm-class').value = c.class;
    populateSpecDropdown(c.class, null, characterModalRole());
  }
  checkCharacterRename();
  fillCharacterFromRaiderio(c.name, c.realmName, true);
}

// Like Add Recruit: class and spec come from Raider.io (the spec they last
// logged out in). Both stay editable -- someone may raid as another spec, the
// way Scootoot shows Elemental but heals. Runs once per name + realm.
const CHARACTER_LOOKUP = { key: null };
const characterLookupKey = (name, realm) => `${name}|${realm}`.toLowerCase();

async function fillCharacterFromRaiderio(name, realm, force) {
  const key = characterLookupKey(name, realm);
  if (!force && CHARACTER_LOOKUP.key === key) return;
  CHARACTER_LOOKUP.key = key;
  const msg = document.getElementById('cm-msg');
  msg.textContent = 'Looking them up on Raider.io...';
  msg.className = 'status-msg loading';
  try {
    const { summary } = await recruitingApi('lookupCharacter', { name, realm });
    if (CHARACTER_LOOKUP.key !== key) return; // they changed the name or realm since
    if (!summary) {
      msg.textContent = `${name} isn't on Raider.io for ${realm} -- check the spelling and realm, or set their class and spec by hand.`;
      msg.className = 'status-msg';
      return;
    }
    // Raider.io's spelling (capitals, accents), and their current name after a rename.
    document.getElementById('cm-name').value = summary.name;
    document.getElementById('cm-server').value = summary.realmName;
    CHARACTER_LOOKUP.key = characterLookupKey(summary.name, summary.realmName);
    checkCharacterRename();
    if (summary.class && CLASS_COLORS[summary.class]) {
      document.getElementById('cm-class').value = summary.class;
      populateSpecDropdown(summary.class, summary.spec, summary.role);
    }
    const renamed = summary.renamedFrom ? ` (renamed from ${formerCharacterText(summary.renamedFrom)})` : '';
    msg.textContent = summary.spec
      ? `Raider.io: ${summary.spec} ${titleCaseClass(summary.class)}${renamed}. If they raid as another spec, change it above.`
      : `Found ${summary.name} on Raider.io${renamed} -- pick their spec above.`;
    msg.className = 'status-msg';
  } catch (e) {
    if (CHARACTER_LOOKUP.key === key) { msg.textContent = ''; msg.className = 'status-msg'; }
  }
}

// Typed by hand: look them up once both boxes are filled -- only when adding;
// editing keeps what's on file.
function lookupTypedCharacter() {
  if (CHARACTER_MODAL_EDIT_ID) return;
  const name = document.getElementById('cm-name').value.trim();
  const realm = document.getElementById('cm-server').value.trim();
  if (name.length >= 2 && realm) fillCharacterFromRaiderio(name, realm);
}

function openAddCharacterModal() {
  CHARACTER_MODAL_EDIT_ID = null;
  CHARACTER_MODAL_JOIN_SOURCE = null;
  CHARACTER_MODAL_ORIGINAL_NAME = null;
  document.getElementById('character-modal-title').textContent = 'Add Character';
  populateClassDropdown('cm-class');
  populateSpecDropdown(document.getElementById('cm-class').value, null, 'ranged');
  hideNameSuggestions();
  CHARACTER_LOOKUP.key = null;
  document.getElementById('cm-name').value = '';
  document.getElementById('cm-server').value = titleCaseServer(STATE.config?.server);
  document.getElementById('cm-rank').value = 'Main';
  document.getElementById('cm-msg').textContent = '';
  document.getElementById('cm-rename-warning').style.display = 'none';
  document.getElementById('cm-remove-btn').style.display = 'none';
  document.getElementById('cm-guild-section').style.display = 'block';
  resetAddFromGuildPanel();
  document.getElementById('character-modal').classList.add('open');
}

function openEditCharacterModal(characterId) {
  const player = STATE.players.find(p => p.id === characterId);
  if (!player) return;
  CHARACTER_MODAL_EDIT_ID = characterId;
  CHARACTER_MODAL_ORIGINAL_NAME = player.name;
  document.getElementById('character-modal-title').textContent = 'Edit Character';
  populateClassDropdown('cm-class', player.class);
  // Their saved spec; characters from before specs were stored get one matching their role.
  populateSpecDropdown(player.class, player.spec, ['heal', 'healer'].includes(player.role) ? 'heal' : player.role);
  hideNameSuggestions();
  document.getElementById('cm-name').value = player.name;
  document.getElementById('cm-server').value = player.serverDisplay || player.server || '';
  document.getElementById('cm-rank').value = player.rank || 'Main';
  document.getElementById('cm-msg').textContent = '';
  document.getElementById('cm-rename-warning').style.display = 'none';
  document.getElementById('cm-remove-btn').style.display = 'inline-block';
  document.getElementById('cm-guild-section').style.display = 'none';
  resetAddFromGuildPanel();
  document.getElementById('character-modal').classList.add('open');
}

function closeCharacterModal() {
  document.getElementById('character-modal').classList.remove('open');
}

// Renaming a character orphans its historical attendance rows (tracked by
// name, no foreign key) -- warn, don't block.
function checkCharacterRename() {
  const warning = document.getElementById('cm-rename-warning');
  if (!warning) return;
  const nameNow = document.getElementById('cm-name').value.trim();
  warning.style.display = (CHARACTER_MODAL_EDIT_ID && nameNow && nameNow !== CHARACTER_MODAL_ORIGINAL_NAME) ? 'block' : 'none';
}

async function saveCharacterModal() {
  const name   = document.getElementById('cm-name').value.trim();
  const cls    = document.getElementById('cm-class').value;
  const spec   = document.getElementById('cm-spec').value;
  const role   = characterModalRole();
  const server = document.getElementById('cm-server').value.trim();
  const rank   = document.getElementById('cm-rank').value;
  const msg    = document.getElementById('cm-msg');

  if (!name || !server) {
    msg.textContent = 'Name and server are required.';
    msg.className   = 'status-msg error';
    return;
  }

  msg.textContent = 'Saving...';
  msg.className   = 'status-msg loading';
  try {
    const action = CHARACTER_MODAL_EDIT_ID ? 'updateCharacter' : 'addCharacter';
    const body = CHARACTER_MODAL_EDIT_ID
      ? { teamId: STATE.teamId, characterId: CHARACTER_MODAL_EDIT_ID, name, class: cls, server, spec, role, rank }
      : { teamId: STATE.teamId, name, class: cls, server, spec, role, rank, joinSource: CHARACTER_MODAL_JOIN_SOURCE };

    const resp = await fetch(`/api/roster?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to save character');

    closeCharacterModal();
    await loadRosterFromDB(true);
    renderRoster();
    loadFlexData();
    if (!CHARACTER_MODAL_EDIT_ID) invalidateJoinOrder(); // a new Main joined the end of the order
    loadOfficerNudge();
    showToast(CHARACTER_MODAL_EDIT_ID ? 'Character updated!' : 'Character added!', 'success');
  } catch (e) {
    msg.textContent = e.message;
    msg.className   = 'status-msg error';
  }
}

async function removeCharacterFromModal() {
  if (!CHARACTER_MODAL_EDIT_ID) return;
  if (!confirm(`Remove ${CHARACTER_MODAL_ORIGINAL_NAME} from the roster? Their loot/attendance history is kept, and this can be undone by an officer re-adding them.`)) return;

  const msg = document.getElementById('cm-msg');
  msg.textContent = 'Removing...';
  msg.className   = 'status-msg loading';
  try {
    const resp = await fetch('/api/roster?action=removeCharacter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, characterId: CHARACTER_MODAL_EDIT_ID }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to remove character');

    closeCharacterModal();
    await loadRosterFromDB(true);
    renderRoster();
    loadFlexData();
    invalidateJoinOrder();
    showToast('Character removed.', 'success');
  } catch (e) {
    msg.textContent = e.message;
    msg.className   = 'status-msg error';
  }
}

// ── ADD FROM GUILD: pick a character straight off the guild's real Blizzard
// roster instead of typing one in by hand (see api/roster.js's guildRoster/
// guildCharacterSpec actions, and lib/battleNet.js). Fetched once per page
// session and cached in memory -- opening the panel again just re-filters
// what's already loaded, no extra network call. ──
let GUILD_ROSTER_DATA     = null;  // [{name, class, level, rank, realmSlug}] once loaded, else null
let GUILD_ROSTER_FILTERED = [];    // whatever's currently rendered, indexed for click handlers
let GUILD_SPEC_CACHE      = {};    // characterName -> spec string (session-level, avoids re-fetching)
let GUILD_SEARCH_DEBOUNCE = null;
let GUILD_RENDER_TOKEN    = 0;     // bumped on every render so a slow spec fetch can't overwrite a newer search's rows

// Mirrors api/discord.js's normalizeName -- strips combining accent marks so
// "Häzey" / "Hazëy" / "Hazey" all match the same search term, same as the
// Discord bot's character lookup already does server-side.
function normalizeNameClient(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function resetAddFromGuildPanel() {
  document.getElementById('cm-guild-panel').style.display = 'none';
  document.getElementById('cm-guild-toggle-btn').textContent = '🔍 Add From Guild';
  document.getElementById('cm-guild-search').value = '';
  document.getElementById('cm-guild-results').innerHTML = '';
  document.getElementById('cm-guild-status').textContent = '';
}

function toggleAddFromGuild() {
  const panel = document.getElementById('cm-guild-panel');
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? 'block' : 'none';
  document.getElementById('cm-guild-toggle-btn').textContent = opening ? '🔍 Hide Guild Search' : '🔍 Add From Guild';
  if (opening && GUILD_ROSTER_DATA === null) loadGuildRosterPanel();
  else if (opening) filterGuildRosterResults();
}

async function loadGuildRosterPanel() {
  const status = document.getElementById('cm-guild-status');
  status.textContent = 'Loading guild roster from Blizzard...';
  try {
    const resp = await fetch(`/api/roster?action=guildRoster&teamId=${encodeURIComponent(STATE.teamId)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load guild roster');
    GUILD_ROSTER_DATA = data.members || [];
    if (data.error) {
      status.textContent = data.error;
    } else {
      status.textContent = '';
      filterGuildRosterResults();
    }
  } catch (e) {
    GUILD_ROSTER_DATA = [];
    status.textContent = 'Error: ' + e.message;
  }
}

function filterGuildRosterResults() {
  if (!GUILD_ROSTER_DATA) return;
  const raw = document.getElementById('cm-guild-search').value.trim();
  const rawLower  = raw.toLowerCase();
  const normed    = normalizeNameClient(raw);

  let matches = raw
    ? GUILD_ROSTER_DATA.filter(m =>
        m.name.toLowerCase().includes(rawLower) || normalizeNameClient(m.name).includes(normed))
    : GUILD_ROSTER_DATA.slice();
  matches.sort((a, b) => a.name.localeCompare(b.name));

  const total = matches.length;
  const shown = matches.slice(0, 25);
  GUILD_ROSTER_FILTERED = shown;
  GUILD_RENDER_TOKEN++;
  renderGuildResults(shown, total, GUILD_RENDER_TOKEN);
}

function renderGuildResults(list, total, token) {
  const results = document.getElementById('cm-guild-results');
  const status  = document.getElementById('cm-guild-status');

  if (list.length === 0) {
    results.innerHTML = '';
    status.textContent = GUILD_ROSTER_DATA.length === 0 ? 'No guild roster data available.' : 'No matches.';
    return;
  }

  // Exact match (name + realm), never accent-normalized -- accent variants
  // like Häzey/Hazëy are genuinely different characters, so only the one
  // whose name is byte-identical to what's already on this team's roster
  // should be flagged. Realm matters too: a guild's members can be spread
  // across its whole connected-realm group, so two different characters
  // named the same thing can legitimately exist on different realms.
  const activeKeys = new Set(STATE.players.map(p => `${p.name.trim().toLowerCase()}|${(p.server || '').toLowerCase()}`));

  results.innerHTML = list.map((m, idx) => {
    const alreadyOn = activeKeys.has(`${m.name.trim().toLowerCase()}|${(m.realmSlug || '').toLowerCase()}`);
    return `<div class="guild-roster-row" onclick="pickGuildCharacter(${idx})">
      <span>
        <span class="guild-roster-row-name">${escapeHtml(m.name)}</span>
        <span class="guild-roster-row-meta" id="cm-guild-spec-${idx}">${escapeHtml(m.class || 'Unknown')}</span>
      </span>
      ${alreadyOn ? '<span class="guild-roster-row-tag">Already on roster</span>' : ''}
    </div>`;
  }).join('');

  status.textContent = total > list.length
    ? `Showing ${list.length} of ${total} -- refine your search to narrow it down.`
    : `${total} match${total === 1 ? '' : 'es'}.`;

  clearTimeout(GUILD_SEARCH_DEBOUNCE);
  GUILD_SEARCH_DEBOUNCE = setTimeout(() => enrichVisibleSpecs(list, token), 300);
}

// Active spec isn't in the roster response -- fetched lazily, only for
// whatever's currently visible, and only after typing pauses for 300ms so
// fast typing doesn't fire a burst of requests for rows about to disappear.
// The token check guards against a slow response landing after a newer
// search has already replaced these rows.
async function enrichVisibleSpecs(list, token) {
  await Promise.all(list.map(async (m, idx) => {
    const cacheKey = `${m.name}|${m.realmSlug || ''}`;
    let spec = GUILD_SPEC_CACHE[cacheKey];
    if (spec === undefined) {
      try {
        const resp = await fetch(`/api/roster?action=guildCharacterSpec&teamId=${encodeURIComponent(STATE.teamId)}&characterName=${encodeURIComponent(m.name)}&realmSlug=${encodeURIComponent(m.realmSlug || '')}`);
        const data = await resp.json();
        spec = resp.ok ? (data.spec || null) : null;
      } catch (e) { spec = null; }
      GUILD_SPEC_CACHE[cacheKey] = spec;
    }
    if (token !== GUILD_RENDER_TOKEN || !spec) return;
    const el = document.getElementById(`cm-guild-spec-${idx}`);
    if (el) el.textContent = `${m.class || ''} — ${spec}`;
  }));
}

function pickGuildCharacter(idx) {
  const m = GUILD_ROSTER_FILTERED[idx];
  if (!m) return;
  document.getElementById('cm-name').value = m.name;
  if (m.class) {
    document.getElementById('cm-class').value = m.class.toLowerCase();
    populateSpecDropdown(m.class.toLowerCase(), GUILD_SPEC_CACHE[`${m.name}|${m.realmSlug || ''}`], characterModalRole());
  }
  document.getElementById('cm-server').value = titleCaseServer(m.realmSlug) || titleCaseServer(STATE.config?.server);
  document.getElementById('cm-guild-panel').style.display = 'none';
  document.getElementById('cm-guild-toggle-btn').textContent = '🔍 Add From Guild';
  const msg = document.getElementById('cm-msg');
  msg.textContent = `Selected ${m.name} from the guild roster -- check their Spec and Rank, then Save.`;
  msg.className = 'status-msg';
}

// ─────────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────────
function updateRosterTitle() {
  const el = document.getElementById('roster-team-name');
  if (!el) return;
  const name = STATE.teamName;
  // Only show if it's not the default "Main Team"
  if (name && name !== 'Main Team') {
    el.textContent = '– ' + name;
    el.style.display = 'inline';
  } else {
    el.textContent = '';
  }
}

function joinWelcomeMessage() {
  return `Welcome to ${STATE.config?.guild || 'the team'}!`;
}

// `guildData`: this team's data, when the caller has just loaded it -- skips
// fetching it again. Without it (offline fallback, settings save), it's fetched.
function showDashboard(guildData = null) {
  hideBootLoader();
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('dashboard').style.display    = 'block';
  document.getElementById('main-nav').style.display     = 'flex';
  document.getElementById('guild-badge').style.display  = 'flex';

  document.getElementById('badge-guild').textContent  = STATE.config.guild;
  document.getElementById('badge-server').textContent = titleCaseServer(STATE.config.server);
  document.getElementById('login-screen').style.display       = 'none';
  document.getElementById('guild-setup-screen').style.display = 'none';
  document.getElementById('landing-choice-screen').style.display = 'none';
  document.getElementById('join-guild-screen').style.display  = 'none';
  document.getElementById('account-menu').style.display       = 'flex';
  if (AUTH.session?.battletag) {
    document.getElementById('account-battletag').textContent  = AUTH.session.battletag;
    document.getElementById('dropdown-battletag').textContent = AUTH.session.battletag;
  }

  // Restore non-authoritative IDs only until Supabase responds.
  // Role-based UI is applied from DB data, not cached browser state.
  const cachedTeamId  = localStorage.getItem('raidlead_team_id');
  const cachedGuildId = localStorage.getItem('raidlead_guild_id');
  if (!STATE.teamId && cachedTeamId)   STATE.teamId  = cachedTeamId;
  if (!STATE.guildId && cachedGuildId) STATE.guildId = cachedGuildId;

  if (!guildData) loadFlexData(); // with fresh data, it's loaded once below
  renderRoster();
  renderPlannerChecklist();
  renderPlannerRoster();

  const cached = loadCachedScores();
  if (cached && cached.zoneId === STATE.zoneId) {
    STATE.scores    = cached.scores;
    STATE.bossNames = cached.bossNames;
    updateScoresFetchBtn(cached.fetchedAt);
  }

  // Fetch guild/role/teamId from Supabase (unless the caller just did)
  (guildData ? Promise.resolve(guildData) : fetchActiveGuildData()).then(async data => {
    if (data && data.team) {
      applyGuildData(data);
      updateRosterTitle();
      loadMySurvey(); // Next Season survey banner, now that role + team are fresh
      loadOfficerNudge(); // owners of a team with no officers yet
      setTimeout(checkBnetPrompt, 600); // accounts that haven't shared their WoW characters yet
      if (STATE.config?.wclTeamId) localStorage.setItem('raidlead_wcl_team_id', STATE.config.wclTeamId);
      if (STATE.teamId) {
        loadFlexData();
        (async () => {
          // Attendance (incl. extra raid nights) must be loaded before computing the
          // next upcoming raid date, since extra nights factor into that calculation.
          if (!STATE.attendanceLoaded) {
            await loadAttendanceData();
          }
          if (!STATE.plannerDate) {
            STATE.plannerDate = nextUpcomingRaidDate();
          }
          // That date's plan -- NOT the most-recently-published plan overall,
          // which could be for a raid night that's already passed. Through
          // loadPlanForDate, which clears the previous plan first: after a
          // team switch, a team with no plan yet used to keep showing the
          // other team's swaps and PUBLISHED badge.
          await loadPlanForDate(STATE.plannerDate, { attendanceFresh: true });
          updatePlannerDateLabel();
        })();
      }
    } else if (STATE.config && STATE.config.guild) {
      // A saved local config with no matching team_members row -- can only
      // happen for a pre-database config that never actually completed
      // joining/creating a team in Supabase. This used to silently re-join
      // by guild name+server (defaulting to an assumed 'owner' role even on
      // failure), which both re-opened the access-control gap join-guild
      // now closes and, on failure, left the UI showing owner controls that
      // every real API call would then 403 on. Send them through setup
      // instead of guessing.
      showToast("Couldn't find your team -- please set up your guild or join one.", 'error');
      showLandingChoice();
    }
  });
}

// ─────────────────────────────────────────────
//  ATTENDANCE
// ─────────────────────────────────────────────

function attendanceDateStr(d) {
  // Local YYYY-MM-DD (avoid UTC shift issues from toISOString)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadAttendanceData() {
  if (!STATE.teamId) {
    console.warn('[Attendance] loadAttendanceData called before STATE.teamId was set — skipping');
    return;
  }
  console.log('[Attendance] loading for teamId:', STATE.teamId);
  const wrap = document.getElementById('attendance-calendar-wrap');
  try {
    const resp = await fetch('/api/members?action=getAttendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load attendance');
    STATE.attendanceExtraDays = data.extraDays || [];
    STATE.attendanceMarks     = data.marks     || [];
    STATE.attendanceLoaded    = true;
    console.log('[Attendance] loaded — marks:', STATE.attendanceMarks.length, '| extra days:', STATE.attendanceExtraDays.length);
    renderAttendanceCalendar();
  } catch(e) {
    console.error('[Attendance] load error:', e.message);
    if (wrap) wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><h3>Couldn't load attendance</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function changeAttendanceMonth(delta) {
  const d = new Date(STATE.attendanceMonth);
  d.setMonth(d.getMonth() + delta);
  STATE.attendanceMonth = d;
  renderAttendanceCalendar();
}

function isRaidDay(date) {
  const weekday = date.getDay();
  const recurring = (STATE.config?.raidDays || []).includes(weekday);
  const dateStr = attendanceDateStr(date);
  const extra = (STATE.attendanceExtraDays || []).includes(dateStr);
  return recurring || extra;
}

// Only relevant once an account has claimed more than one character (a Main
// and Alt(s)) -- attendance is inherently per-character (raid slots are),
// so someone with multiple claims needs to say which one they're marking.
// Hidden entirely for the common single-claim case.
function renderAttendanceCharacterPicker() {
  const wrap   = document.getElementById('attendance-acting-as');
  const select = document.getElementById('attendance-acting-as-select');
  if (!wrap || !select) return;

  const chars = STATE.claimedCharacters || [];
  if (chars.length <= 1) {
    wrap.style.display = 'none';
    STATE.attendanceActingAs = chars[0]?.name || null;
    return;
  }

  if (!STATE.attendanceActingAs || !chars.some(c => c.name === STATE.attendanceActingAs)) {
    STATE.attendanceActingAs = chars[0].name;
  }
  select.innerHTML = chars.map(c =>
    `<option value="${escapeHtml(c.name)}" ${c.name === STATE.attendanceActingAs ? 'selected' : ''}>${escapeHtml(c.name)}${c.rank ? ' (' + escapeHtml(c.rank) + ')' : ''}</option>`
  ).join('');
  wrap.style.display = 'flex';
}

function setAttendanceActingAs(name) {
  STATE.attendanceActingAs = name;
  renderAttendanceCalendar();
}

function renderAttendanceCalendar() {
  const wrap = document.getElementById('attendance-calendar-wrap');
  if (!wrap) return;

  renderAttendanceCharacterPicker();

  const viewMonth = STATE.attendanceMonth;
  const year  = viewMonth.getFullYear();
  const month = viewMonth.getMonth();

  const monthLabel = document.getElementById('attendance-month-label');
  if (monthLabel) {
    monthLabel.textContent = viewMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay(); // 0=Sun
  const daysInMonth   = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayStr = attendanceDateStr(today);

  const myChar = STATE.attendanceActingAs || STATE.claimedCharacter;
  const myUnavailableDates = new Set(
    (STATE.attendanceMarks || [])
      .filter(m => m.character_name === myChar && m.status === 'unavailable')
      .map(m => m.raid_date)
  );

  const weekdayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    .map(d => `<div class="attendance-weekday-label">${d}</div>`).join('');

  let cells = '';
  for (let i = 0; i < startWeekday; i++) cells += `<div class="attendance-day blank"></div>`;

  const isOfficerView = ['owner', 'officer'].includes(STATE.myRole);

  for (let day = 1; day <= daysInMonth; day++) {
    const cellDate = new Date(year, month, day);
    const dateStr  = attendanceDateStr(cellDate);
    const raidDay  = isRaidDay(cellDate);
    const isExtraNight = (STATE.attendanceExtraDays || []).includes(dateStr);
    const unavailable = myUnavailableDates.has(dateStr);

    // Names of teammates marked unavailable on this date (visible to everyone, useful context)
    const unavailNames = (STATE.attendanceMarks || []).filter(m => m.raid_date === dateStr && m.status === 'unavailable').map(m => m.character_name);
    const unavailCount = unavailNames.length;

    let classes = 'attendance-day';
    if (raidDay) classes += ' raid-day';
    if (unavailable) classes += ' unavailable';
    if (dateStr === todayStr) classes += ' today';

    const clickAttr = raidDay && myChar ? `onclick="toggleMyAttendance('${dateStr}')"` : '';
    const tag = unavailable ? 'Unavailable' : (raidDay ? 'Raid Night' : '');
    const countBadge = (raidDay && unavailCount > 0) ? `<div class="attendance-day-count" title="Out: ${unavailNames.join(', ')}">${unavailCount} out</div>` : '';
    // Officers can remove one-off extra raid nights directly from the calendar
    const removeBtn = (isExtraNight && isOfficerView)
      ? `<div class="attendance-day-remove" title="Remove this raid night" onclick="event.stopPropagation(); removeRaidNightFromCalendar('${dateStr}')">&times;</div>`
      : '';

    cells += `<div class="${classes}" ${clickAttr} title="${raidDay && !myChar ? 'Claim a character to mark attendance' : ''}">
      ${removeBtn}
      <div class="attendance-day-num">${day}</div>
      ${tag ? `<div class="attendance-day-tag">${tag}</div>` : ''}
      ${countBadge}
    </div>`;
  }

  wrap.innerHTML = `<div class="attendance-calendar">${weekdayLabels}${cells}</div>`;
}

async function toggleMyAttendance(dateStr) {
  const myChar = STATE.attendanceActingAs || STATE.claimedCharacter;
  if (!myChar || !STATE.teamId) return;
  const currentlyUnavailable = (STATE.attendanceMarks || [])
    .some(m => m.character_name === myChar && m.raid_date === dateStr && m.status === 'unavailable');

  // Optimistic update
  if (currentlyUnavailable) {
    STATE.attendanceMarks = STATE.attendanceMarks.filter(m => !(m.character_name === myChar && m.raid_date === dateStr));
  } else {
    STATE.attendanceMarks.push({ character_name: myChar, raid_date: dateStr, status: 'unavailable' });
  }
  renderAttendanceCalendar();

  try {
    const resp = await fetch('/api/members?action=markAttendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId: STATE.teamId,
        characterName: myChar,
        raidDate: dateStr,
        unavailable: !currentlyUnavailable,
      }),
    });
    if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to save');
  } catch(e) {
    console.error('[Attendance] save failed:', e.message);
    showToast('Could not save attendance: ' + e.message, 'error');
    STATE.attendanceLoaded = false;
    loadAttendanceData();
  }
}

// ── Raid Schedule modal ──
function openRaidScheduleModal() {
  setRaidDaysOn('rsm-raid-days', STATE.config?.raidDays || []);
  initRaidDayChips();
  document.getElementById('raid-schedule-modal').classList.add('open');
}
function closeRaidScheduleModal() {
  document.getElementById('raid-schedule-modal').classList.remove('open');
}
async function saveRaidSchedule() {
  const raidDays = getRaidDaysFrom('rsm-raid-days');
  try {
    const resp = await fetch('/api/guild?action=setRaidSchedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, raidDays }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to save schedule');
    STATE.config.raidDays = raidDays;
    saveConfig(STATE.config);
    closeRaidScheduleModal();
    renderAttendanceCalendar();
    showToast('Raid schedule updated', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function saveDiscordGuildId() {
  const discordGuildId = document.getElementById('inp-discord-guild').value.trim();
  const statusEl = document.getElementById('discord-guild-status');
  statusEl.textContent = 'Saving...';
  statusEl.className   = 'status-msg loading';
  try {
    const resp = await fetch('/api/guild?action=setDiscordGuildId', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, discordGuildId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to save');
    STATE.discordGuildId = data.discordGuildId;
    renderDiscordConnectStatus();
    statusEl.textContent = 'Saved!';
    statusEl.className   = 'status-msg success';
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'status-msg'; }, 3000);
  } catch(e) {
    statusEl.textContent = 'Error: ' + e.message;
    statusEl.className   = 'status-msg error';
  }
}

function renderDiscordConnectStatus() {
  const el = document.getElementById('discord-connect-status');
  if (!el) return;
  el.innerHTML = STATE.discordGuildId
    ? `<span style="color:#5865F2;">🔗 Connected</span> <span style="color:var(--text-mute);">(Server ID: ${escapeHtml(STATE.discordGuildId)})</span>`
    : '<span style="color:var(--text-mute);">Not connected yet.</span>';
}

function renderWclCredsStatus() {
  const el = document.getElementById('wcl-creds-status');
  if (!el) return;
  el.innerHTML = STATE.config?.hasWclCredentials
    ? `<span style="color:#1EFF00;">✓ Connected</span> <span style="color:var(--text-mute);">(Client ID: ${escapeHtml(STATE.config.wclClientId || '')})</span>`
    : '<span style="color:#ff6b6b;">Not connected — WCL Scores won\'t work until this is set up.</span>';
}

async function saveWclCredentials() {
  const wclClientId     = document.getElementById('inp-wcl-client-id').value.trim();
  const wclClientSecret = document.getElementById('inp-wcl-client-secret').value.trim();
  const msg = document.getElementById('wcl-creds-msg');

  if (!wclClientId && !wclClientSecret && STATE.config?.hasWclCredentials) {
    if (!confirm('Clear the saved WCL credentials? WCL Scores will stop working for this guild until new ones are added.')) return;
  }

  msg.textContent = 'Saving...';
  msg.className   = 'status-msg loading';
  try {
    const resp = await fetch('/api/guild?action=setWclCredentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, wclClientId, wclClientSecret }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to save WCL credentials');

    STATE.config.hasWclCredentials = !data.cleared;
    STATE.config.wclClientId       = data.cleared ? null : wclClientId;
    document.getElementById('inp-wcl-client-secret').value = '';
    renderWclCredsStatus();
    msg.textContent = data.cleared ? 'Cleared.' : 'Saved!';
    msg.className   = 'status-msg success';
  } catch(e) {
    msg.textContent = e.message;
    msg.className   = 'status-msg error';
  }
}

function renderWowauditKeyStatus() {
  const el = document.getElementById('wowaudit-key-status');
  if (!el) return;
  el.innerHTML = STATE.config?.hasWowauditKey
    ? `<span style="color:#1EFF00;">✓ Connected</span> <span style="color:var(--text-mute);">— the Import button on the Roster tab is ready to use.</span>`
    : '<span style="color:var(--text-mute);">Not connected — you can still manage the roster by hand, or add a key to import from WowAudit instead.</span>';
}

async function saveWowauditKey(confirmDuplicateWowauditKey) {
  const wowauditApiKey = document.getElementById('inp-wowaudit-key').value.trim();
  const msg = document.getElementById('wowaudit-key-msg');

  if (!wowauditApiKey && STATE.config?.hasWowauditKey) {
    if (!confirm('Clear the saved WowAudit API key? The "Import from WowAudit" button will stop working until a new one is added.')) return;
  }

  msg.textContent = 'Saving...';
  msg.className   = 'status-msg loading';
  try {
    const resp = await fetch('/api/guild?action=setWowauditApiKey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, wowauditApiKey, confirmDuplicateWowauditKey: !!confirmDuplicateWowauditKey }),
    });
    const data = await resp.json();

    if (resp.status === 409 && data.error === 'WOWAUDIT_KEY_DUPLICATE') {
      const wantsToContinue = confirm(`${data.message}\n\nClick OK to save anyway.\nClick Cancel to stop and double-check.`);
      if (wantsToContinue) return saveWowauditKey(true);
      msg.textContent = 'Not saved -- check the key.';
      msg.className   = 'status-msg';
      return;
    }

    if (!resp.ok) throw new Error(data.error || 'Failed to save WowAudit API key');

    STATE.config.hasWowauditKey = !data.cleared;
    document.getElementById('inp-wowaudit-key').value = '';
    renderWowauditKeyStatus();
    updateWowauditImportBtn();
    msg.textContent = data.cleared ? 'Cleared.' : 'Saved!';
    msg.className   = 'status-msg success';
  } catch(e) {
    msg.textContent = e.message;
    msg.className   = 'status-msg error';
  }
}

// Builds the Discord bot-authorization URL. Whoever opens this needs "Manage Server"
// on the target Discord server to actually complete adding the bot; the redirect back
// to our callback is resolved via the one-time state token, not a RaidLead session.
async function buildDiscordConnectUrl() {
  const resp = await fetch('/api/guild?action=beginDiscordConnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: STATE.teamId }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Failed to start Discord connection');
  const redirectUri = window.location.origin + '/api/discord-connect-callback';
  const params = new URLSearchParams({
    client_id:     data.discordApplicationId,
    scope:         'bot applications.commands',
    permissions:   '0',
    redirect_uri:  redirectUri,
    response_type: 'code', // required for Discord to actually redirect back to us with guild_id -- without it, it just shows its own static "authorized" page and stops
    state:         data.state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function beginDiscordConnect() {
  const msg = document.getElementById('discord-connect-msg');
  msg.textContent = 'Preparing...';
  msg.className   = 'status-msg loading';
  try {
    const url = await buildDiscordConnectUrl();
    msg.textContent = '';
    msg.className   = 'status-msg';
    window.open(url, '_blank');
  } catch(e) {
    msg.textContent = 'Error: ' + e.message;
    msg.className   = 'status-msg error';
  }
}

async function copyDiscordConnectLink() {
  const msg = document.getElementById('discord-connect-msg');
  msg.textContent = 'Generating link...';
  msg.className   = 'status-msg loading';
  try {
    const url = await buildDiscordConnectUrl();
    await navigator.clipboard.writeText(url);
    msg.textContent = "Link copied! It's valid for 15 minutes -- send it to whoever manages your Discord server.";
    msg.className   = 'status-msg success';
  } catch(e) {
    msg.textContent = 'Error: ' + e.message;
    msg.className   = 'status-msg error';
  }
}

// ── Add Raid Night modal ──
function openAddRaidNightModal() {
  document.getElementById('arn-date').value = '';
  document.getElementById('add-raidnight-modal').classList.add('open');
}
function closeAddRaidNightModal() {
  document.getElementById('add-raidnight-modal').classList.remove('open');
}
async function submitAddRaidNight() {
  const dateVal = document.getElementById('arn-date').value;
  if (!dateVal) { showToast('Pick a date first', 'error'); return; }
  try {
    const resp = await fetch('/api/members?action=addRaidNight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, raidDate: dateVal }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to add raid night');
    if (!STATE.attendanceExtraDays.includes(dateVal)) STATE.attendanceExtraDays.push(dateVal);
    closeAddRaidNightModal();
    renderAttendanceCalendar();
    showToast('Raid night added: ' + dateVal, 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function removeRaidNightFromCalendar(dateStr) {
  if (!confirm(`Remove the raid night on ${dateStr}? Any attendance marks for that date will remain but the day will no longer be flagged as a raid night.`)) return;
  try {
    const resp = await fetch('/api/members?action=removeRaidNight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, raidDate: dateStr }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to remove raid night');
    STATE.attendanceExtraDays = (STATE.attendanceExtraDays || []).filter(d => d !== dateStr);
    renderAttendanceCalendar();
    showToast('Raid night removed: ' + dateStr, 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.querySelector('.nav-btn[data-tab="' + name + '"]')?.classList.add('active');
  updateMobileNavActive(name);

  // Data that loaded while another tab was showing (item levels after a team
  // switch, flex roles) only redraws the Roster if it's visible -- so draw it
  // fresh whenever it's opened.
  if (name === 'roster') renderRoster();

  // Always load the published plan from DB when switching to planner
  // so every user sees the same roster regardless of device/localStorage
  if (name === 'planner' && STATE.teamId) {
    const initPlanner = () => {
      if (!STATE.plannerDate) STATE.plannerDate = nextUpcomingRaidDate();
      updatePlannerDateLabel();
      if (STATE.raidPlanMode !== 'edit') {
        loadPlanForDate(STATE.plannerDate);
      }
    };

    if (!STATE.attendanceLoaded) {
      loadAttendanceData().then(initPlanner);
    } else {
      initPlanner();
    }
  }

  // Load attendance data when switching to the Attendance tab
  if (name === 'attendance') {
    if (!STATE.attendanceLoaded) {
      loadAttendanceData();
    } else {
      renderAttendanceCalendar(); // already loaded — just re-render
    }
  }

  // Show zone banner on scores tab if a newer zone was detected and not yet dismissed
  if (name === 'scores') {
    const banner = document.getElementById('zone-banner');
    if (STATE.detectedZone && banner && getDismissedZone() !== STATE.detectedZone.id) {
      document.getElementById('zone-banner-msg').textContent =
        `Zone ${STATE.detectedZone.id} (${STATE.detectedZone.name}) is available. You are currently using Zone ${STATE.zoneId}.`;
      banner.style.display = 'block';
    }
  }

  if (name === 'progress') {
    loadProgressTab();
  }

  if (name === 'team') {
    loadTeamTab();
  }

  if (name === 'loot') {
    loadLootTab();
  }

  if (name === 'resources') {
    renderResources();
  }
}

// ─────────────────────────────────────────────
//  PROGRESS TAB — world-wide boss kill counts via Raider.io, by
//  difficulty and the team's configured region.
// ─────────────────────────────────────────────
function setProgressDifficulty(diff, btn) {
  STATE.progressDifficulty = diff;
  document.querySelectorAll('#progress-difficulty-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadProgressTab();
}

// Switches to a past raid tier ('' means back to the current/auto-detected one).
function setProgressRaid(slug) {
  STATE.progressRaidSlug = slug || null;
  loadProgressTab();
}

function progressCacheKey() {
  return (STATE.progressRaidSlug || 'current') + '_' + STATE.progressDifficulty;
}

// Populates the raid-tier dropdown once per session from the guild's own
// Raider.io progression history, so past tiers are viewable without anyone
// needing to know or type a raid's slug.
async function loadProgressRaidsList() {
  const select = document.getElementById('progress-raid-select');
  if (!select) return;

  if (!STATE.progressRaidsList) {
    let raidsResult = null;
    try {
      const resp = await fetch(`/api/raiderio?action=listRaids&teamId=${encodeURIComponent(STATE.teamId)}`);
      const data = await resp.json();
      // A Raider.io outage (RAIDERIO_UNAVAILABLE) must NOT be cached as a
      // permanent empty list -- that's what made the dropdown "go away" for
      // the rest of the session even after Raider.io recovered. Only a
      // genuine successful response sticks; a failure just retries next
      // time this tab is opened.
      if (resp.ok && data.reason !== 'RAIDERIO_UNAVAILABLE') raidsResult = data.raids || [];
    } catch (e) { /* leave raidsResult null so this retries next time */ }

    if (raidsResult === null) { select.style.display = 'none'; return; }
    STATE.progressRaidsList = raidsResult;
  }

  const raids = STATE.progressRaidsList;
  if (!raids || raids.length === 0) { select.style.display = 'none'; return; }

  // Group into <optgroup>s by expansion, preserving the order expansions
  // arrived in (current expansion first, then progressively older ones).
  const expansionOrder = [];
  const raidsByExpansion = {};
  raids.forEach(r => {
    const exp = r.expansion || 'Other';
    if (!raidsByExpansion[exp]) { raidsByExpansion[exp] = []; expansionOrder.push(exp); }
    raidsByExpansion[exp].push(r);
  });

  select.innerHTML = expansionOrder.map(exp => `
    <optgroup label="${escapeHtml(exp)}">
      ${raidsByExpansion[exp].map(r => `<option value="${escapeHtml(r.slug)}">${escapeHtml(r.name)}</option>`).join('')}
    </optgroup>
  `).join('');
  if (STATE.progressRaidSlug) select.value = STATE.progressRaidSlug;
  select.style.display = 'inline-block';
}

async function loadProgressTab() {
  const content = document.getElementById('progress-content');
  const subtitle = document.getElementById('progress-subtitle');

  // World rankings, pulls, and comps are Retail's (Raider.io); every other
  // version shows boss kills per raid and difficulty/size.
  if (!GAME.sources.raiderio?.rankings) return loadProgressKills();

  loadProgressRaidsList();

  // The current-raid flow depends on a detected WCL zone; a specific past
  // tier (picked from the dropdown) doesn't need one at all.
  if (!STATE.progressRaidSlug && !STATE.config?.zoneName) {
    document.getElementById('progress-raid-name').textContent = '';
    subtitle.textContent = '';
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🗺</div>
        <h3>Progress isn't set up yet</h3>
        <p>The current raid is detected from your WCL zone. Open the WCL Scores tab once (or set a WCL Guild Progress URL in Guild Settings) so a zone is on file, then come back here.</p>
        <button class="btn-primary" style="margin-top:12px;" onclick="showSetup()">Go to Guild Settings</button>
      </div>`;
    return;
  }

  const cacheKey = progressCacheKey();
  const cached = STATE.progressCache[cacheKey];
  if (cached) {
    renderProgress(cached);
    return;
  }

  content.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Loading Progress...</div></div>';

  try {
    let url = `/api/raiderio?action=progress&teamId=${encodeURIComponent(STATE.teamId)}&difficulty=${STATE.progressDifficulty}`;
    if (STATE.progressRaidSlug) url += `&raidSlug=${encodeURIComponent(STATE.progressRaidSlug)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load progress data');
    STATE.progressCache[cacheKey] = data;
    renderProgress(data);
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><h3>Couldn't load progress</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

async function loadProgressKills() {
  const content = document.getElementById('progress-content');
  document.getElementById('progress-raid-name').textContent = STATE.config?.zoneName || '';
  document.getElementById('progress-subtitle').textContent = GAME.sources.raiderio
    ? `Boss kills from Raider.io's Classic site`
    : `Boss kills from your Warcraft Logs reports`;
  const cacheKey = 'kills';
  if (STATE.progressCache[cacheKey]) return renderProgressKills(STATE.progressCache[cacheKey]);
  content.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Loading Progress...</div></div>';
  try {
    const resp = await fetch(`/api/raiderio?action=progressKills&teamId=${encodeURIComponent(STATE.teamId)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load progress');
    STATE.progressCache[cacheKey] = data;
    renderProgressKills(data);
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><h3>Couldn't load progress</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

// Each raid: bosses killed per difficulty/size ("25 H 4/14").
function renderProgressKills(data) {
  const content = document.getElementById('progress-content');
  if (data.wclNotConfigured) { content.innerHTML = wclNotConnectedHtml(); return; }
  if (!data.raids?.length) {
    content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🗺</div><h3>No boss kills yet</h3><p>${escapeHtml(data.message || 'Nothing recorded for this guild yet.')}</p></div>`;
    return;
  }
  content.innerHTML = data.raids.map(r => ({ ...r, totalBosses: Number(r.totalBosses) || 0,
      kills: (r.kills || []).map(k => ({ label: String(k.label), killed: Number(k.killed) || 0 })) })).map(r => `
    <div class="progress-kills-raid">
      <div class="progress-kills-name">${escapeHtml(r.name)}${r.totalBosses ? `<span class="recruit-sub"> · ${r.totalBosses} bosses</span>` : ''}</div>
      <div class="progress-kills-row">${(r.kills || []).map(k => {
        const pct = r.totalBosses ? Math.round((k.killed / r.totalBosses) * 100) : 0;
        return `<div class="progress-kills-cell${k.killed ? ' has-kills' : ''}">
          <div class="progress-kills-label">${escapeHtml(k.label)}</div>
          <div class="progress-kills-count">${k.killed}/${r.totalBosses || '?'}</div>
          <div class="progress-kills-bar"><div style="width:${pct}%;"></div></div>
        </div>`;
      }).join('')}</div>
    </div>`).join('')
    + (data.profileUrl ? `<div class="recruit-links" style="margin-top:8px;"><a href="${escapeHtml(data.profileUrl)}" target="_blank" rel="noopener noreferrer">Guild on Raider.io</a></div>` : '');
}

// Bypasses the session cache and re-fetches live from Raider.io -- normally
// unnecessary (nothing here is stale within a session, there's just no
// automatic polling), but useful right after a big guild kill.
function refreshProgressTab() {
  STATE.progressCache = {};
  STATE.progressRaidsList = null;
  loadProgressTab();
}

function renderProgress(data) {
  const content = document.getElementById('progress-content');
  const subtitle = document.getElementById('progress-subtitle');

  if (!data.configured) {
    document.getElementById('progress-raid-name').textContent = '';
    subtitle.textContent = '';
    const isOutage = data.reason === 'RAIDERIO_UNAVAILABLE';
    const isRateLimited = data.reason === 'RAIDERIO_RATE_LIMITED';
    const title = isRateLimited ? "Raider.io is rate-limiting us" : isOutage ? "Raider.io is having issues" : "Progress isn't available yet";
    const icon = (isRateLimited || isOutage) ? '⏳' : '🗺';
    const message = isRateLimited
      ? "We're sending Raider.io more requests than it wants right now, so it's temporarily throttling us. This isn't a configuration problem -- it should clear up on its own in a few minutes."
      : isOutage
        ? "Raider.io's servers are temporarily unavailable, so we can't pull rankings right now. This is on their end, not RaidLead -- try again in a few minutes."
        : data.reason === 'RAID_NOT_FOUND'
          ? `Couldn't match your zone ("${escapeHtml(data.zoneName || STATE.config?.zoneName || '')}") to a raid on Raider.io yet. This should resolve once Raider.io has indexed the current tier.`
          : 'The current raid is detected from your WCL zone. Open the WCL Scores tab once (or set a WCL Guild Progress URL in Guild Settings) so a zone is on file, then come back here.';
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon}</div>
        <h3>${title}</h3>
        <p>${message}</p>
        ${(!isRateLimited && !isOutage && data.reason !== 'RAID_NOT_FOUND') ? `<button class="btn-primary" style="margin-top:12px;" onclick="showSetup()">Go to Guild Settings</button>` : ''}
      </div>`;
    return;
  }

  document.getElementById('progress-raid-name').textContent = data.raidName ? '– ' + data.raidName : '';
  subtitle.textContent = `Guilds that have defeated each boss on ${data.difficulty.toUpperCase()}, region: ${(data.region || '').toUpperCase()}`;

  // Keep the raid dropdown in sync even when this load was in "current raid"
  // (auto-detected) mode -- now that Raider.io has told us exactly which
  // slug that resolved to, the dropdown should show it as selected too.
  if (data.raidSlug) {
    STATE.progressRaidSlug = data.raidSlug;
    const raidSelect = document.getElementById('progress-raid-select');
    if (raidSelect && raidSelect.querySelector(`option[value="${CSS.escape(data.raidSlug)}"]`)) {
      raidSelect.value = data.raidSlug;
    }
  }

  content.innerHTML = '';

  // Stashed for the bracket selector / boss-row-click handlers below, which
  // fire well after this initial render and need the same data to re-render
  // against.
  STATE.progressData = data;
  STATE.progressCompBossSlug = data.currentBossSlug;
  data.pullsLoaded = false; // avg pulls always come from loadProgressPulls -- see renderBossList

  // ── Your Guild summary ──
  const yourCard = document.createElement('div');
  yourCard.style.cssText = `
    background: var(--bg2); border: 1px solid var(--gold-dim); border-radius: 6px;
    padding: 14px 16px; margin-bottom: 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  `;
  if (data.yourGuild) {
    yourCard.innerHTML = `
      <div>
        <div style="font-size:15px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:var(--gold);">Your Guild</div>
        <div style="font-size:13px; color:var(--text-mute); margin-top:2px;">Per Raider.io's last crawl of your guild</div>
      </div>
      <div style="display:flex; align-items:center; gap:20px;">
        ${data.yourGuild.regionRank ? `
          <div style="text-align:right;">
            <div style="font-size:18px; font-weight:700; color:var(--text);">#${data.yourGuild.regionRank.toLocaleString()}</div>
            <div style="font-size:10px; font-weight:500; color:var(--text-mute); text-transform:uppercase; letter-spacing:1px;">Region Rank</div>
          </div>
        ` : ''}
        <div style="font-size:22px; font-weight:700; color:var(--gold);">${data.yourGuild.killed}/${data.yourGuild.totalBosses} <span style="font-size:13px; font-weight:600; color:var(--text-mute); text-transform:uppercase;">${data.difficulty}</span></div>
      </div>
    `;
  } else {
    yourCard.innerHTML = `
      <div>
        <div style="font-size:15px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:var(--gold);">Your Guild</div>
        <div style="font-size:13px; color:var(--text-mute); margin-top:2px;">Raider.io hasn't recorded a kill for your guild in this raid yet.</div>
      </div>
    `;
  }
  content.appendChild(yourCard);

  // Populated a moment later by loadProgressComposition() below, once its
  // background fetch resolves -- kept as an empty placeholder here so the
  // rest of the tab never waits on it (up to 20 extra Raider.io calls).
  // Click any boss row below to switch which one this shows.
  const compCard = document.createElement('div');
  compCard.id = 'progress-comp-card';
  content.appendChild(compCard);

  // ── Avg Pulls bracket selector -- defaults to whichever 50-guild bracket
  // this guild's own rank falls in. Deliberately keyed off regionRank, not
  // worldRank: the rankedGuilds list progressPulls slices brackets from
  // comes from instance-rankings scoped to this team's own region (see the
  // "region: US" wording in the subtitle above), so a rank position within
  // it only lines up with the guild's REGION rank -- worldRank comes from a
  // genuinely different, all-regions-combined Raider.io pool (verified live:
  // instance-rankings?region=world mixes in EU/CN/etc guilds that never
  // appear in the region=us list), and using it here picked a bracket that
  // didn't match the guild's real position in this data at all. ──
  const bracketRow = document.createElement('div');
  bracketRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:14px; flex-wrap:wrap;';
  const defaultBracketStart = progressDefaultBracketStart(data.yourGuild?.regionRank);
  bracketRow.innerHTML = `
    <span style="font-size:11px; color:var(--text-mute); text-transform:uppercase; letter-spacing:1px;">Avg Pulls vs:</span>
    <select id="progress-pulls-bracket" class="themed-select" onchange="onProgressPullsBracketChange()">
      ${progressPullsBracketOptions(data.yourGuild?.regionRank).map(o =>
        `<option value="${o.start}" ${o.start === defaultBracketStart ? 'selected' : ''}>${o.label}</option>`
      ).join('')}
    </select>
    <span id="progress-pulls-bracket-note" style="font-size:11px; color:var(--text-mute);"></span>
  `;
  content.appendChild(bracketRow);

  const list = document.createElement('div');
  list.id = 'progress-boss-list';
  list.style.cssText = 'display:flex; flex-direction:column; gap:10px;';
  content.appendChild(list);
  renderBossList(data);

  loadProgressComposition(data);
  loadProgressPulls(data, defaultBracketStart);
}

// Rebuilds just the boss rows (not Your Guild / the comp card / the bracket
// selector) -- called on initial render, after a bracket change updates
// avgPulls/pullSampleSize, and after clicking a row to re-target the comp
// card, so all three stay in sync without re-fetching everything.
function renderBossList(data) {
  const list = document.getElementById('progress-boss-list');
  if (!list) return;
  const killedCount = data.yourGuild ? data.yourGuild.killed : 0;

  list.innerHTML = '';
  data.bosses.forEach((boss, i) => {
    const youKilled = i < killedCount;
    const isCompTarget = boss.slug === STATE.progressCompBossSlug;
    const row = document.createElement('div');
    row.className = 'progress-boss-row';
    row.style.borderColor = isCompTarget ? 'var(--accent)' : (youKilled ? 'var(--gold-dim)' : 'var(--border)');
    row.title = 'Click to see the recommended comp for this boss';
    row.onclick = () => loadProgressComposition(data, boss.slug);
    row.innerHTML = `
      <div class="progress-boss-rank">${i + 1}</div>
      ${/^https:\/\//.test(boss.iconUrl || '') ? `<img class="progress-boss-icon" src="${escapeHtml(boss.iconUrl)}" alt="">` : ''}
      <div class="progress-boss-name">
        <span class="progress-boss-name-text">${escapeHtml(boss.name)}</span>
        ${youKilled ? `<span title="Your guild has killed this boss" style="color:var(--gold); font-size:13px; flex-shrink:0;">✓</span>` : ''}
        ${youKilled && boss.yourRegionRank ? `<span class="progress-boss-region-pill" title="Your guild's region rank for this boss">Region #${boss.yourRegionRank.toLocaleString()}</span>` : ''}
      </div>
      <div class="progress-boss-stats">
        <div class="progress-boss-stat" style="color:var(--gold);">
          ${boss.guildsDefeated.toLocaleString()}
          <div class="progress-boss-stat-label">guilds</div>
        </div>
        ${!data.pullsLoaded ? `
          <div class="progress-boss-stat">
            <div class="spinner" style="width:12px; height:12px; border-width:2px; display:inline-block;"></div>
          </div>
        ` : boss.pullSampleSize > 0 ? `
          <div class="progress-boss-stat" style="color:var(--text);" title="Averaged from ${boss.pullSampleSize} guilds in this bracket that share a real pull count">
            ${boss.avgPulls.toLocaleString()}
            <div class="progress-boss-stat-label">avg pulls</div>
          </div>
        ` : ''}
      </div>
    `;
    list.appendChild(row);
  });
}

// 50-guild brackets, 1-50 through 951-1000 -- see PULLS_BRACKET_SIZE in
// api/raiderio.js (must match).
const PROGRESS_PULLS_BRACKET_SIZE = 50;
const PROGRESS_PULLS_BRACKET_COUNT = 20;

// The bracket a given region rank actually falls in, with no upper bound --
// a guild ranked 4,200th on a brutal new tier is real and shouldn't get
// clamped to whatever the standard dropdown list happens to cover.
function progressRankBracketStart(regionRank) {
  return Math.floor((regionRank - 1) / PROGRESS_PULLS_BRACKET_SIZE) * PROGRESS_PULLS_BRACKET_SIZE + 1;
}

function progressDefaultBracketStart(regionRank) {
  if (!regionRank || regionRank < 1) return 1;
  return progressRankBracketStart(regionRank);
}

// Always offers the standard top-1000 brackets (useful as a fixed comparison
// point regardless of your own rank), plus -- if your guild's rank falls
// outside that range -- one extra option for the bracket it's actually in,
// inserted in order and clearly marked, so the dropdown's default selection
// always matches a real option instead of silently falling back to the
// browser's "first option" behavior for a start value nothing lists.
function progressPullsBracketOptions(regionRank) {
  const opts = [];
  for (let i = 0; i < PROGRESS_PULLS_BRACKET_COUNT; i++) {
    const start = i * PROGRESS_PULLS_BRACKET_SIZE + 1;
    const end = start + PROGRESS_PULLS_BRACKET_SIZE - 1;
    opts.push({ start, label: `Rank ${start}-${end}` });
  }
  const maxStandardStart = (PROGRESS_PULLS_BRACKET_COUNT - 1) * PROGRESS_PULLS_BRACKET_SIZE + 1;
  if (regionRank && regionRank > maxStandardStart + PROGRESS_PULLS_BRACKET_SIZE - 1) {
    const start = progressRankBracketStart(regionRank);
    const end = start + PROGRESS_PULLS_BRACKET_SIZE - 1;
    opts.push({ start, label: `Rank ${start}-${end}` });
  }
  return opts;
}

function onProgressPullsBracketChange() {
  const select = document.getElementById('progress-pulls-bracket');
  const rankStart = parseInt(select?.value, 10);
  if (!STATE.progressData || !rankStart) return;
  loadProgressPulls(STATE.progressData, rankStart);
}

// Backgrounded like composition below -- one extra Raider.io call, but no
// reason to make the initial render (or a bracket switch) wait on it.
async function loadProgressPulls(data, rankStart) {
  const note = document.getElementById('progress-pulls-bracket-note');
  if (note) note.textContent = 'Loading...';
  // Shows a spinner per boss row (see renderBossList) instead of leaving
  // whatever bracket's numbers were already there -- otherwise switching
  // brackets to a similar average can look like nothing happened.
  data.pullsLoaded = false;
  renderBossList(data);
  try {
    const url = `/api/raiderio?action=progressPulls&teamId=${encodeURIComponent(STATE.teamId)}` +
      `&raidSlug=${encodeURIComponent(data.raidSlug)}&difficulty=${encodeURIComponent(data.difficulty)}` +
      `&region=${encodeURIComponent(data.region)}&rankStart=${rankStart}`;
    const resp = await fetch(url);
    const pullsData = await resp.json();
    if (!resp.ok) throw new Error(pullsData.error || 'Failed to load pull counts');

    // Still looking at the same raid tier this was fetched for?
    if (STATE.progressRaidSlug && STATE.progressRaidSlug !== data.raidSlug) return;

    const pullsBySlug = pullsData.pullsBySlug || {};
    data.bosses.forEach(boss => {
      const p = pullsBySlug[boss.slug];
      boss.avgPulls       = p ? p.avgPulls   : null;
      boss.pullSampleSize = p ? p.sampleSize : 0;
    });
    data.pullsLoaded = true;
    renderBossList(data);
    if (note) note.textContent = pullsData.rateLimited
      ? 'Raider.io is rate-limiting us right now -- try again shortly'
      : pullsData.bracketSize ? `${pullsData.bracketSize} guilds in this bracket` : 'No guilds found in this bracket';
  } catch (e) {
    data.pullsLoaded = true; // stop showing spinners -- boss.pullSampleSize is still 0/undefined, so rows just show nothing
    renderBossList(data);
    if (note) note.textContent = '';
  }
}

// Background-loads the "Recommended Comp" card, defaulting to the current
// tier's next unkilled boss (see currentBossSlug from the progress
// response) but re-targetable to any boss by clicking its row in the list
// below (see renderBossList) -- fired after renderProgress() already
// finished, never blocking it, since this costs up to compSampleSize extra
// Raider.io calls (one per sampled guild's kill roster) versus the single
// call everything else above needed.
async function loadProgressComposition(data, bossSlugOverride) {
  const card = document.getElementById('progress-comp-card');
  if (!card) return;
  const bossSlug = bossSlugOverride || data.currentBossSlug;
  if (!bossSlug) { card.innerHTML = ''; return; }

  const isPlanningAhead = bossSlug !== data.currentBossSlug;
  STATE.progressCompBossSlug = bossSlug;
  renderBossList(data); // re-render now so the clicked row highlights immediately

  const bossInfo = data.bosses.find(b => b.slug === bossSlug);
  card.innerHTML = `
    <div style="background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; margin-bottom: 18px; display: flex; align-items: center; gap: 12px;">
      <div class="spinner" style="width:20px; height:20px; border-width:2px; flex-shrink:0;"></div>
      <div style="font-size:13px; color:var(--text-mute);">Loading recommended comp for ${escapeHtml(bossInfo?.name || 'this boss')}...</div>
    </div>
  `;

  try {
    const url = `/api/raiderio?action=progressComposition&teamId=${encodeURIComponent(STATE.teamId)}` +
      `&raidSlug=${encodeURIComponent(data.raidSlug)}&bossSlug=${encodeURIComponent(bossSlug)}` +
      `&difficulty=${encodeURIComponent(data.difficulty)}&region=${encodeURIComponent(data.region)}`;
    const resp = await fetch(url);
    const compData = await resp.json();
    if (!resp.ok) throw new Error(compData.error || 'Failed to load composition');

    // Still the same Progress view the user is looking at, and still the
    // same boss they clicked (a rapid second click would've moved this on)?
    if (!document.getElementById('progress-comp-card')) return;
    if (STATE.progressRaidSlug && STATE.progressRaidSlug !== data.raidSlug) return;
    if (STATE.progressCompBossSlug !== bossSlug) return;

    const subtitleTail = isPlanningAhead
      ? ' — click any boss above to preview its comp'
      : ' — your next boss (click any boss above to plan ahead)';

    if (!compData.composition) {
      const noDataMessage = compData.rateLimited
        ? `Raider.io is rate-limiting us right now, so we couldn't pull a recommended comp for ${escapeHtml(bossInfo?.name || 'this boss')}. Try again shortly.`
        : `Not enough guilds share composition data for ${escapeHtml(bossInfo?.name || 'this boss')} yet to show a recommended comp.${subtitleTail}`;
      card.innerHTML = `
        <div style="background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; margin-bottom: 18px;">
          <div style="font-size:13px; color:var(--text-mute);">${noDataMessage}</div>
        </div>
      `;
      return;
    }

    const c = compData.composition;
    const pill = (label, value, color) => `
      <div style="text-align:center;">
        <div style="font-size:22px; font-weight:700; color:${color};">${value}</div>
        <div style="font-size:10px; font-weight:500; color:var(--text-mute); text-transform:uppercase; letter-spacing:1px;">${label}</div>
      </div>
    `;
    card.innerHTML = `
      <div style="background: var(--bg2); border: 1px solid var(--gold-dim); border-radius: 6px; padding: 14px 16px; margin-bottom: 18px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;">
        <div>
          <div style="font-size:15px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:var(--gold);">Recommended Comp</div>
          <div style="font-size:13px; color:var(--text-mute); margin-top:2px;">
            ${escapeHtml(bossInfo?.name || '')} — averaged from ${compData.sampleSize} of the top ${compData.sampleOf} world guilds${subtitleTail}
          </div>
        </div>
        <div style="display:flex; gap:20px;">
          ${pill('Tanks', c.tank, '#C79C6E')}
          ${pill('Healers', c.healer, '#1EFF00')}
          ${pill('Melee', c.melee, '#FF8000')}
          ${pill('Ranged', c.ranged, '#69CCF0')}
        </div>
      </div>
    `;
  } catch (e) {
    card.innerHTML = '';
  }
}

// ─────────────────────────────────────────────
//  RESOURCES — static directory of helpful external sites, grouped by
//  category. Each entry is { name, url, description }; categories with no
//  entries yet just show a placeholder instead of an empty section.
// ─────────────────────────────────────────────
const RESOURCES = {
  'Guild Analytics': [
    { name: 'Warcraft Logs',          url: 'https://www.warcraftlogs.com/',                          description: 'Review and compare dps/healer logs. Track guild progress and rankings.' },
    { name: 'WoW Progression Stats',  url: 'https://progstats.io/',                                  description: 'Paste your warcraftlogs progress url for analysis of your progress.' },
    { name: 'Warcraft Recorder',      url: 'https://warcraftrecorder.com/',                          description: 'Capture povs from multiple different raiders to watch and review.' },
    { name: 'WoW Analyzer',           url: 'https://wowanalyzer.com/',                                description: 'Upload a report and get character analysis for boss fights.' },
    { name: 'Wipefest',               url: 'https://www.wipefest.gg/?gameVersion=warcraft-live',      description: 'Upload a report and get analysis for how well players did mechanics.' },
  ],
  'Raid Planning': [
    { name: 'Viserio Cooldowns',            url: 'https://wowutils.com/viserio-cooldowns',    description: 'Plan raid assignments, healer/tank/dps cooldowns, pull CDs from logs.' },
    { name: 'Raid Leader Exchange Discord', url: 'https://discord.com/invite/rlexchange',     description: 'Really smart people discussing boss strats.' },
    { name: 'Raid Strats',                  url: 'https://raidstrats.gg/',                    description: 'Create visual plans for bosses.' },
  ],
  'Class/Spec Info': [
    { name: 'Wowhead',    url: 'https://www.wowhead.com/',           description: 'Spec specific guides: BiS gear, rotations, consumables, stats, etc.' },
    { name: 'Icy Veins',  url: 'https://www.icy-veins.com/wow/',     description: 'Spec specific guides: BiS gear, rotations, consumables, stats, etc.' },
    { name: 'Bloodmallet', url: 'https://bloodmallet.com/',          description: 'Spec specific trinket lists & PI charts.' },
    { name: 'Raidbots',   url: 'https://www.raidbots.com/simbot',    description: 'Sim your character to determine the best gear, gems, and enchants.' },
    { name: 'Lorrgs',     url: 'https://lorrgs.io/',                 description: 'Spec specific CD timings per boss fights.' },
    { name: 'Murlok',     url: 'https://murlok.io/',                 description: 'Spec specific talents for pvp and pve.' },
    { name: 'Archon',     url: 'https://www.archon.gg/wow',          description: 'Spec specific talents for raid & m+ (similar to murlok.io).' },
  ],
  'Recruitment': [
    { name: 'Raider.io',                  url: 'https://raider.io/',                                                              description: 'Manage guild info and recruitment. Look up other guilds and characters. Search for recruits.' },
    { name: 'Recruitment Discord (NA/OC)', url: 'https://discord.com/invite/recruitment-community-na-oc-246097056958119944',      description: 'A discord for all types of recruitment needs.' },
    { name: 'WoW Poacher',                url: 'https://wowpoacher.io/',                                                          description: 'Filter by parse, guild progress, and guild rankings. Find your perfect fit.' },
    { name: 'Guilds of WoW',              url: 'https://guildsofwow.com/',                                                        description: 'Similar to raider.io; manage guild info and search for new recruits.' },
  ],
  'Class Discords': [
    { name: 'Class Discords', url: 'https://www.wowhead.com/discord-servers', description: 'Directory of official class Discord communities, curated by Wowhead.' },
    { name: 'Death Knight',  url: 'https://discord.com/invite/acherus',                description: 'Official Death Knight community Discord.' },
    { name: 'Demon Hunter',  url: 'https://discord.com/invite/felhammer',               description: 'Official Demon Hunter community Discord.' },
    { name: 'Druid',         url: 'https://discord.com/invite/0dWu0WkuetF87H9H',        description: 'Official Druid community Discord.' },
    { name: 'Evoker',        url: 'https://discord.com/invite/JcCFEcmSWD',              description: 'Official Evoker community Discord.' },
    { name: 'Hunter',        url: 'https://discord.com/invite/yqer4BX',                 description: 'Official Hunter community Discord.' },
    { name: 'Mage',          url: 'https://discord.com/invite/WzYCnbg',                 description: 'Official Mage community Discord.' },
    { name: 'Monk',          url: 'https://discord.com/invite/0dkfBMAxzTkWj21F',        description: 'Official Monk community Discord.' },
    { name: 'Paladin',       url: 'https://discord.com/invite/hammerofwrath',           description: 'Official Paladin community Discord.' },
    { name: 'Priest',        url: 'https://discord.com/invite/WarcraftPriests',         description: 'Official Priest community Discord.' },
    { name: 'Rogue',         url: 'https://discord.com/invite/Ravenholdt',              description: 'Official Rogue community Discord.' },
    { name: 'Shaman',        url: 'https://discord.com/invite/0VcupJEQX0HuE5HH',        description: 'Official Shaman community Discord.' },
    { name: 'Warlock',       url: 'https://discord.com/invite/0onXDymd9Wpc2CEu',        description: 'Official Warlock community Discord.' },
    { name: 'Warrior',       url: 'https://discord.com/invite/Skyhold',                 description: 'Official Warrior community Discord.' },
  ],
};

// ─────────────────────────────────────────────
//  COMPANION APP PAIRING — approves a RaidLead Companion app's login
//  request. The Companion app itself calls api/companion.js's startPairing
//  and opens a browser to `?companion-pair=<code>`; everything here is just
//  the confirm screen on this side, followed by a plain POST to
//  approvePairing. The Companion app's own background poll is what actually
//  mints its access token (see api/companion.js's checkPairing) -- nothing
//  in this file ever sees or handles that token.
//
//  This replaced the old bridge-folder/File System Access sync code: the
//  Companion app now talks to RaidLead directly using this login, so there's
//  nothing left for the browser to relay.
// ─────────────────────────────────────────────
// Collapses/expands the Loot tab's WoW Sync setup instructions -- purely a
// display preference, remembered per-browser, nothing meaningful to sync
// anywhere else.
function toggleWowSyncExplainer() {
  const explainer = document.getElementById('wow-sync-explainer');
  const arrow = document.getElementById('wow-sync-toggle-arrow');
  if (!explainer || !arrow) return;
  const collapsed = explainer.style.display !== 'none';
  explainer.style.display = collapsed ? 'none' : '';
  arrow.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
  try { localStorage.setItem('raidlead_wowsync_collapsed', collapsed ? '1' : '0'); } catch(e) {}
}

const COMPANION_PAIR_STORAGE_KEY = 'raidlead_pending_companion_pair';

// Checked at the same point as checkInviteParam(), just before the session
// check. Unlike that invite flow, this deliberately does NOT clear the
// stored code right away -- approving a Companion login needs an explicit
// click, so a stray reload (or just being slow to decide) shouldn't lose
// the code with no way to recover it, since the query param itself is
// already scrubbed from the URL by then.
function checkCompanionPairParam() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('companion-pair');
  if (!code) return;
  window.history.replaceState({}, '', '/');
  try { localStorage.setItem(COMPANION_PAIR_STORAGE_KEY, code); } catch(e) {}
}

// Called once a real session is confirmed. Fetches getPairingInfo (read-only
// -- see api/companion.js for why this is a separate action from the
// Companion app's own consuming checkPairing poll) to show which device is
// asking, then shows the confirm modal.
async function checkPendingCompanionPair() {
  let code;
  try { code = localStorage.getItem(COMPANION_PAIR_STORAGE_KEY); } catch(e) { return; }
  if (!code) return;

  try {
    const resp = await fetch(`/api/companion?action=getPairingInfo&pairingCode=${encodeURIComponent(code)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Invalid pairing code');
    if (data.status !== 'pending') throw new Error('already used');
    showCompanionPairModal(code, data.deviceLabel);
  } catch (e) {
    try { localStorage.removeItem(COMPANION_PAIR_STORAGE_KEY); } catch(err) {}
  }
}

function showCompanionPairModal(pairingCode, deviceLabel) {
  const modal = document.getElementById('companion-pair-modal');
  document.getElementById('companion-pair-device').textContent = deviceLabel || 'Unknown device';
  modal.dataset.pairingCode = pairingCode;
  modal.classList.add('open');
}

// `approve` false covers both an explicit Deny click and just closing the
// modal -- either way the pairing is simply left alone to expire on its
// own (there's no separate "deny" signal the Companion app's poll needs;
// it just keeps seeing "pending" until the 10-minute window runs out).
async function respondToCompanionPair(approve) {
  const modal = document.getElementById('companion-pair-modal');
  const pairingCode = modal.dataset.pairingCode;
  modal.classList.remove('open');
  try { localStorage.removeItem(COMPANION_PAIR_STORAGE_KEY); } catch(e) {}
  if (!approve || !pairingCode) return;

  try {
    const resp = await fetch('/api/companion?action=approvePairing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not approve login');
    showToast('RaidLead Companion connected!', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Connected devices (Settings) — lists/revokes this account's Companion
// app tokens. Revoking immediately blocks that device from calling
// getRosterSync/uploadLoot/getMyTeams again. ──
async function loadConnectedDevices() {
  const listEl = document.getElementById('connected-devices-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="loading-overlay"><div class="spinner"></div></div>';
  try {
    const resp = await fetch('/api/companion?action=listMyTokens');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load connected devices');

    const tokens = data.tokens || [];
    if (tokens.length === 0) {
      listEl.innerHTML = '<div style="font-size:13px; color:var(--text-mute);">No Companion apps connected yet.</div>';
      return;
    }

    listEl.innerHTML = tokens.map(t => `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:var(--bg3); border:1px solid var(--border); border-radius:6px; margin-bottom:8px;">
        <div>
          <div style="font-size:14px; font-weight:700; ${t.revoked_at ? 'color:var(--text-mute); text-decoration:line-through;' : ''}">${escapeHtml(t.device_label || 'Unknown device')}</div>
          <div style="font-size:11px; color:var(--text-mute);">
            ${t.revoked_at ? 'Revoked' : (t.last_used_at ? 'Last used ' + new Date(t.last_used_at).toLocaleString() : 'Never used yet')}
          </div>
        </div>
        ${t.revoked_at ? '' : `<button class="btn-secondary" style="padding:4px 12px; font-size:12px;" onclick="revokeConnectedDevice('${t.id}')">Revoke</button>`}
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="font-size:13px; color:#ff6b6b;">${escapeHtml(e.message)}</div>`;
  }
}

async function revokeConnectedDevice(tokenId) {
  if (!confirm('Revoke this device? It will stop syncing until logged in again.')) return;
  try {
    const resp = await fetch('/api/companion?action=revokeToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to revoke');
    loadConnectedDevices();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ─────────────────────────────────────────────
//  LOOT TAB — fed by the RaidLead WoW addon. Runs are grouped by the
//  addon-generated session_id so a whole non-guild run can be cleaned up
//  in one action; reassign/delete are Officer/Owner-only, matching the
//  server-side guard in api/loot.js.
// ─────────────────────────────────────────────
async function loadLootTab() {
  if (!STATE.teamId) return;
  try {
    const explainer = document.getElementById('wow-sync-explainer');
    const arrow = document.getElementById('wow-sync-toggle-arrow');
    if (explainer && arrow && localStorage.getItem('raidlead_wowsync_collapsed') === '1') {
      explainer.style.display = 'none';
      arrow.style.transform = 'rotate(-90deg)';
    }
  } catch(e) {}
  try {
    // The real roster is STATE.players -- the Guild Roster tab, sourced from
    // the characters table and already loaded before any tab can be viewed
    // (see loadRosterFromDB(), called during the main boot sequence). Not
    // Raid Night's published plan (that's one night's assignment, a
    // subset) and not api/members' claimed-characters list (that omits
    // anyone who hasn't linked an account yet). It has no database id of
    // its own, so resolveCharacterIds ties each name to the character_id
    // tier_token_checks actually persists against.
    const rosterNames = (STATE.players || []).map(p => p.name);
    const [lootData, checksData, idsData] = await Promise.all([
      fetch(`/api/loot?action=get&teamId=${encodeURIComponent(STATE.teamId)}`).then(r => r.json()),
      fetch(`/api/loot?action=getTierChecks&teamId=${encodeURIComponent(STATE.teamId)}`).then(r => r.json()),
      fetch('/api/loot?action=resolveCharacterIds', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: STATE.teamId, names: rosterNames }),
      }).then(r => r.json()),
    ]);
    if (lootData.error) throw new Error(lootData.error);
    // Surface these two explicitly rather than silently defaulting to an
    // empty checklist/roster -- that would look exactly like "the checklist
    // keeps resetting" when it's actually just a failed fetch (e.g. the
    // tier_token_checks table not existing yet in Supabase).
    if (checksData.error) throw new Error('Tier checklist: ' + checksData.error);
    if (idsData.error) throw new Error('Roster: ' + idsData.error);
    STATE.lootDrops = lootData.drops || [];
    STATE.tierCheckedIds = new Set(checksData.checkedCharacterIds || []);
    STATE.teamRosterChars = (STATE.players || [])
      .map(p => ({ id: idsData.ids?.[p.name], name: p.name, class: p.class }))
      .filter(c => c.id); // not yet synced to the characters table -- shouldn't normally happen, but don't render an unpersistable checkbox

    renderTierTracker(STATE.lootDrops);
    renderTierRoster();
    renderLootRuns(STATE.lootDrops, 'loot-runs', null,
      'No loot recorded yet — install the RaidLead addon + companion app to start tracking.');
    renderLootRuns(STATE.lootDrops, 'loot-boe-runs', d => d.is_boe, 'No BoEs recorded yet.');
  } catch (e) {
    const el = document.getElementById('loot-runs');
    if (el) el.innerHTML = `<div style="color:var(--text-mute); font-size:13px;">Error loading loot: ${escapeHtml(e.message)}</div>`;
  }
}

function setLootSubTab(name, btn) {
  document.querySelectorAll('#loot-subtab-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  ['tier', 'boe', 'history'].forEach(n => {
    const el = document.getElementById('loot-subtab-' + n);
    if (el) el.style.display = n === name ? '' : 'none';
  });
}

function renderTierTracker(drops) {
  const el = document.getElementById('loot-tier-tracker');
  if (!el) return;

  const tokensByHolder = {};
  drops.filter(d => d.is_tier_token).forEach(d => {
    const holder = d.current_holder_name || 'Unknown';
    tokensByHolder[holder] = (tokensByHolder[holder] || 0) + 1;
  });

  const names = Object.keys(tokensByHolder).sort();
  el.innerHTML = `
    <div class="section-title" style="font-size:14px; margin-bottom:10px;">Recorded by Addon</div>
    ${names.length === 0
      ? '<div style="font-size:12px; color:var(--text-mute);">No tier tokens recorded yet.</div>'
      : `<div style="display:flex; flex-wrap:wrap; gap:8px;">
          ${names.map(name => `
            <div style="background:var(--bg3); border:1px solid var(--border); border-radius:4px; padding:6px 12px; font-size:12px;">
              ${escapeHtml(name)} <span style="color:var(--gold); font-weight:700;">×${tokensByHolder[name]}</span>
            </div>
          `).join('')}
        </div>`}
  `;
}

// Manual "one tier token per member" checklist, split into Cloth/Leather/Mail/
// Plate columns -- separate from renderTierTracker's addon-recorded list above
// since officers need to be able to hand-confirm this regardless of what the
// addon saw (see the schema note on tier_token_checks for why).
function renderTierRoster() {
  const el = document.getElementById('loot-tier-roster');
  if (!el) return;

  const chars = STATE.teamRosterChars || [];
  if (!GAME.tokenGroups) { el.innerHTML = `<div style="font-size:12px; color:var(--text-mute);">${escapeHtml(GAME.label)} has no tier tokens to track.</div>`; return; }
  if (chars.length === 0) {
    el.innerHTML = '<div style="font-size:12px; color:var(--text-mute);">No guild roster yet — add characters on the Roster tab, or import from WowAudit in Guild Settings.</div>';
    return;
  }

  const isOfficer = ['owner', 'officer'].includes(STATE.myRole);
  const checkedIds = STATE.tierCheckedIds || new Set();

  const tokensByName = {};
  (STATE.lootDrops || []).filter(d => d.is_tier_token).forEach(d => {
    if (d.current_holder_name) tokensByName[d.current_holder_name] = (tokensByName[d.current_holder_name] || 0) + 1;
  });

  // Tokens by armor type in Retail, by token group (Conqueror, Champion, ...)
  // in Classic. A version without tier tokens has no checklist.
  const groups = GAME.tokenGroups || [];
  const byArmor = Object.fromEntries(groups.map(g => [g.name, []]));
  chars.forEach(c => {
    const armor = groups.find(g => g.classes.includes((c.class || '').toLowerCase()))?.name;
    if (armor) byArmor[armor].push(c);
  });
  Object.values(byArmor).forEach(list => list.sort((a, b) => (a.name || '').localeCompare(b.name || '')));

  el.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
      <div class="section-title" style="font-size:14px;">Tier Token Checklist</div>
      ${isOfficer ? `<button class="btn-secondary" style="padding:4px 10px; font-size:12px;" onclick="resetTierChecklist()">Reset for New Tier</button>` : ''}
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:14px;">
      ${groups.map(g => g.name).map(armor => `
        <div style="background:var(--bg3); border:1px solid var(--border); border-radius:6px; padding:10px;">
          <div style="font-weight:700; font-size:12px; color:var(--text-mute); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">${escapeHtml(armor)}</div>
          ${byArmor[armor].length === 0 ? '<div style="font-size:11px; color:var(--text-mute);">—</div>' : byArmor[armor].map(c => {
            const checked = checkedIds.has(c.id);
            const color = CLASS_COLORS[(c.class || '').toLowerCase()] || '#fff';
            const recorded = tokensByName[c.name];
            return `
              <label style="display:flex; align-items:center; gap:6px; padding:3px 0; font-size:12px; ${isOfficer ? 'cursor:pointer;' : ''}">
                <input type="checkbox" ${checked ? 'checked' : ''} ${isOfficer ? '' : 'disabled'} ${c.id ? `onchange="toggleTierCheck('${c.id}', this.checked)"` : 'disabled'} />
                <span style="color:${color};">${escapeHtml(c.name)}</span>
                ${recorded ? `<span title="${recorded} tier token drop recorded by the addon" style="color:var(--gold); font-size:11px;">🎁</span>` : ''}
              </label>
            `;
          }).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

async function toggleTierCheck(characterId, checked) {
  try {
    const resp = await fetch('/api/loot?action=setTierCheck', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, characterId, checked }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to update');
    if (checked) STATE.tierCheckedIds.add(characterId); else STATE.tierCheckedIds.delete(characterId);
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
    renderTierRoster();
  }
}

async function resetTierChecklist() {
  if (!confirm('Clear every checked-off tier token for this team? Use this at the start of a new raid tier.')) return;
  try {
    const resp = await fetch('/api/loot?action=resetTierChecks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to reset');
    STATE.tierCheckedIds = new Set();
    renderTierRoster();
    showToast('Tier token checklist reset', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// name -> Blizzard's real in-game color for that upgrade track badge.
const QUALITY_TRACK_COLORS = { Veteran: '#1eff00', Champion: '#0070dd', Hero: '#a335ee', Mythic: '#ff8000' };
const BIND_TYPE_COLORS = { Warbound: 'var(--accent)', 'Warbound Until Equipped': 'var(--accent)', BoE: 'var(--red)' };

function renderLootRuns(drops, targetId, filterFn, emptyMessage) {
  const el = document.getElementById(targetId);
  if (!el) return;

  const isOfficer = ['owner', 'officer'].includes(STATE.myRole);

  const sessions = {};
  drops.forEach(d => {
    if (filterFn && !filterFn(d)) return;
    (sessions[d.session_id] = sessions[d.session_id] || []).push(d);
  });

  const sessionIds = Object.keys(sessions).sort((a, b) => {
    const aTime = sessions[a][0]?.created_at || '';
    const bTime = sessions[b][0]?.created_at || '';
    return bTime.localeCompare(aTime);
  });

  if (sessionIds.length === 0) {
    el.innerHTML = `<div style="font-size:13px; color:var(--text-mute);">${emptyMessage}</div>`;
    return;
  }

  // Deleting a run removes every item from that session, including ones this
  // filtered view isn't showing -- only offer that button on the unfiltered
  // (Loot History) view so it can't be mistaken for "delete just these".
  const allowDeleteRun = !filterFn;

  el.innerHTML = sessionIds.map(sessionId => {
    const items = sessions[sessionId];
    const likelyPug = items.some(d => d.likely_pug);
    const bossCount = new Set(items.map(d => d.boss_name).filter(Boolean)).size;
    const raidDate = items[0]?.raid_date || '?';

    // Group by boss, ordered by each boss's earliest capture within this run
    // -- raw insertion order (by created_at) scatters real gear across boss
    // groups whenever a Group Loot roll resolves slowly, since a
    // late-resolving roll for an earlier boss can land after an
    // instantly-awarded item from a later one. Items with no boss
    // attribution ("Trash") sort last as their own group.
    const bossFirstSeen = {};
    items.forEach((d, i) => {
      const key = d.boss_name || '￿';
      if (!(key in bossFirstSeen)) bossFirstSeen[key] = i;
    });
    const orderedItems = items.slice().sort((a, b) => {
      const ka = a.boss_name || '￿', kb = b.boss_name || '￿';
      return bossFirstSeen[ka] - bossFirstSeen[kb];
    });

    return `
      <div style="background:var(--bg3); border:1px solid ${likelyPug ? 'rgba(196,30,58,0.4)' : 'var(--border)'}; border-radius:6px; padding:14px; margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div>
            <span style="font-weight:700;">${escapeHtml(raidDate)}</span>
            <span style="color:var(--text-mute); font-size:12px; margin-left:8px;">${bossCount} boss${bossCount === 1 ? '' : 'es'} · ${items.length} item${items.length === 1 ? '' : 's'}</span>
            ${likelyPug ? '<span style="margin-left:8px; font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#ff6b6b; border:1px solid rgba(196,30,58,0.4); border-radius:3px; padding:2px 6px;">Likely PUG</span>' : ''}
          </div>
          ${isOfficer && allowDeleteRun ? `<button class="btn-secondary" style="padding:4px 10px; font-size:12px;" onclick="deleteLootRun(${jsAttr(sessionId)})">Delete Run</button>` : ''}
        </div>
        <div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">
          ${orderedItems.map(d => renderLootRow(d, isOfficer)).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function renderLootRow(d, isOfficer) {
  const traded = d.current_holder_name && d.current_holder_name !== d.recipient_name;
  const trackColor = QUALITY_TRACK_COLORS[d.item_quality_track];
  const trackBadge = d.item_quality_track
    ? `<span style="color:${trackColor || 'var(--text-mute)'}; margin-left:6px;">${escapeHtml(d.item_quality_track)}${d.upgrade_level ? ` ${escapeHtml(d.upgrade_level)}/${escapeHtml(d.upgrade_level_max || '?')}` : ''}</span>`
    : '';
  const metaBits = [d.item_slot, d.armor_type].filter(Boolean).join(' · ');
  // bind_type is the real GetItemInfo-reported bind (set on every drop, not
  // just untracked trash BoEs) -- prefer it, and only fall back to the older
  // is_boe heuristic badge for records captured before bind_type existed.
  const bindBadge = d.bind_type
    ? `<span style="color:${BIND_TYPE_COLORS[d.bind_type] || 'var(--text-mute)'}; margin-left:6px;">${escapeHtml(d.bind_type)}</span>`
    : (d.is_boe ? '<span style="color:var(--text-mute); margin-left:6px;">BoE</span>' : '');
  return `
    <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:6px 8px; background:var(--bg2); border-radius:4px;">
      <div>
        <span style="font-weight:600;">${escapeHtml(d.item_name || ('Item ' + d.item_id))}</span>
        ${d.is_tier_token ? '<span style="color:var(--gold); margin-left:6px;">Tier Token</span>' : ''}
        ${bindBadge}
        ${trackBadge}
        <span style="color:var(--text-mute); margin-left:6px;">${escapeHtml(d.boss_name || 'Trash')}</span>
        ${metaBits ? `<span style="color:var(--text-mute); margin-left:6px;">(${escapeHtml(metaBits)})</span>` : ''}
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span>${escapeHtml(d.current_holder_name || '?')}${traded ? ` <span style="color:var(--text-mute);">(was ${escapeHtml(d.recipient_name)})</span>` : ''}</span>
        ${isOfficer ? `
          ${d.bind_type !== 'Soulbound' && d.bind_type !== 'BoE' ? `<button class="btn-secondary" style="padding:2px 8px; font-size:11px;" onclick="setLootBindType(${jsAttr(d.id)},'BoE')" title="The addon's auto-detected bind type can be wrong for Warbound Until Equipped items -- correct it here if you know better.">Mark BoE</button>` : ''}
          ${d.bind_type !== 'Soulbound' && d.bind_type !== 'Warbound Until Equipped' ? `<button class="btn-secondary" style="padding:2px 8px; font-size:11px;" onclick="setLootBindType(${jsAttr(d.id)},'Warbound Until Equipped')" title="The addon's auto-detected bind type can be wrong for Warbound Until Equipped items -- correct it here if you know better.">Mark Warbound</button>` : ''}
          <button class="btn-secondary" style="padding:2px 8px; font-size:11px;" onclick="reassignLootItem(${jsAttr(d.id)})">Reassign</button>
          <button class="btn-secondary" style="padding:2px 8px; font-size:11px; color:#ff6b6b;" onclick="deleteLootItem(${jsAttr(d.id)})">✕</button>
        ` : ''}
      </div>
    </div>
  `;
}

async function reassignLootItem(lootId) {
  const newHolderName = prompt('Character name this item should be credited to:');
  if (!newHolderName) return;
  try {
    const resp = await fetch('/api/loot?action=reassign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, lootId, newHolderName: newHolderName.trim() }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to reassign');
    showToast('Reassigned to ' + newHolderName.trim(), 'success');
    loadLootTab();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// Manual correction for the addon's auto-detected bind type -- GetItemInfo
// can't reliably tell Warbound Until Equipped apart from plain BoE for
// another player's loot, so officers can fix a wrong one here.
async function setLootBindType(lootId, bindType) {
  try {
    const resp = await fetch('/api/loot?action=setBindType', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, lootId, bindType }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to update bind type');
    showToast('Marked as ' + bindType, 'success');
    loadLootTab();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function deleteLootItem(lootId) {
  if (!confirm('Delete this loot record? This cannot be undone.')) return;
  try {
    const resp = await fetch('/api/loot?action=delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, lootId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to delete');
    loadLootTab();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function deleteLootRun(sessionId) {
  if (!confirm('Delete every loot record from this run? This cannot be undone.')) return;
  try {
    const resp = await fetch('/api/loot?action=deleteSession', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, sessionId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to delete run');
    showToast(`Deleted ${data.deleted || 0} record(s)`, 'success');
    loadLootTab();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

function renderResources() {
  const content = document.getElementById('resources-content');
  if (!content) return;
  content.innerHTML = '';

  Object.entries(GAME.resources || RESOURCES).forEach(([category, items]) => {
    const section = document.createElement('div');
    section.style.cssText = 'margin-bottom: 32px;';

    const divider = document.createElement('div');
    divider.style.cssText = `
      font-size: 11px; font-weight: 700; letter-spacing: 3px;
      text-transform: uppercase; color: var(--gold);
      margin-bottom: 16px; padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    `;
    divider.textContent = category;
    section.appendChild(divider);

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:13px; color:var(--text-mute); font-style:italic;';
      empty.textContent = 'Links coming soon.';
      section.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px;';
      items.forEach(item => {
        const card = document.createElement('a');
        card.href = item.url;
        card.target = '_blank';
        card.rel = 'noopener noreferrer';
        card.style.cssText = `
          display: block; background: var(--bg2); border: 1px solid var(--border);
          border-radius: 6px; padding: 14px 16px; text-decoration: none;
          transition: border-color 0.15s;
        `;
        card.onmouseover = () => card.style.borderColor = 'var(--border2)';
        card.onmouseout  = () => card.style.borderColor = 'var(--border)';
        card.innerHTML = `
          <div style="font-weight:700; color:var(--gold); font-size:14px; margin-bottom:4px;">${escapeHtml(item.name)}</div>
          <div style="font-size:12px; color:var(--text-dim); line-height:1.5;">${escapeHtml(item.description)}</div>
        `;
        grid.appendChild(card);
      });
      section.appendChild(grid);
    }

    content.appendChild(section);
  });
}

// ─────────────────────────────────────────────
//  ROSTER RENDER
// ─────────────────────────────────────────────
function setRosterRankFilter(value, btn) {
  STATE.rosterRankFilter = value;
  document.querySelectorAll('#roster-rank-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderRoster();
}

// ── Read-only season history: a picker of past seasons, and (when one's
// selected) that season's roster snapshot, sourced from
// character_membership_periods -- who actually had an open membership
// period during that window, not just who got scheduled into a raid
// night. Loaded once per team, lazily, from renderRoster() below. ──
async function loadSeasonHistoryList() {
  if (STATE.seasonsListLoadedFor === STATE.teamId) return;
  STATE.seasonsListLoadedFor = STATE.teamId;
  try {
    const resp = await fetch('/api/roster?action=getSeasons&teamId=' + encodeURIComponent(STATE.teamId));
    const data = await resp.json();
    if (!resp.ok) return;
    const select = document.getElementById('season-history-select');
    if (!select) return;
    const seasons = (data.seasons || []).filter(s => s.ended_at); // only past (closed) seasons are worth picking -- the current one already has its own option below
    const currentLabel = STATE.zoneName || 'Current';
    select.innerHTML = `<option value="">${escapeHtml(currentLabel)}</option>` +
      seasons.map(s => `<option value="${s.id}">${escapeHtml(s.zone_name)}</option>`).join('');
  } catch(e) { /* best-effort -- dropdown just stays at whatever it last showed */ }
}

async function onSeasonHistoryChange(seasonId) {
  const panel = document.getElementById('season-history-panel');
  const liveEls = ['stat-grid', 'raid-buffs-grid', 'roster-by-role'].map(id => document.getElementById(id));
  if (!seasonId) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    liveEls.forEach(el => { if (el) el.style.display = ''; });
    return;
  }

  liveEls.forEach(el => { if (el) el.style.display = 'none'; });
  panel.style.display = 'block';
  panel.innerHTML = '<div class="loading-overlay"><div class="spinner"></div></div>';

  try {
    const resp = await fetch(`/api/roster?action=getSeasonRoster&teamId=${encodeURIComponent(STATE.teamId)}&seasonId=${encodeURIComponent(seasonId)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load season roster');

    const roster = (data.roster || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    panel.innerHTML = `
      <div style="background:var(--bg2); border:1px solid var(--border); border-radius:6px; padding:16px; margin-bottom:16px;">
        <div style="font-size:11px; color:var(--text-mute); text-transform:uppercase; letter-spacing:1px; margin-bottom:10px;">
          Read-only snapshot &middot; ${escapeHtml(data.season.zone_name)} &middot; ${data.season.started_at} – ${data.season.ended_at}
        </div>
        ${roster.length === 0 ? '<div style="color:var(--text-mute); font-size:13px;">No roster data recorded for this season.</div>' : `
        <div style="display:flex; flex-direction:column; gap:6px;">
          ${roster.map(c => `
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px; padding:6px 10px; background:var(--bg3); border-radius:4px;">
              <span style="color:${CLASS_COLORS[c.class] || 'var(--text)'}; font-weight:600;">${escapeHtml(c.name)}</span>
              <span style="color:var(--text-mute);">${escapeHtml(c.primary_role || '')} &middot; ${escapeHtml(c.rank || 'Main')}</span>
            </div>
          `).join('')}
        </div>`}
      </div>
    `;
  } catch(e) {
    panel.innerHTML = `<div style="color:var(--text-mute); font-size:13px;">Error loading season roster: ${escapeHtml(e.message)}</div>`;
  }
}

// The Roster's Zone card: the raid's name, with its WCL zone ID underneath
// once one's on file (never "Zone null").
function renderZoneCard() {
  const zoneEl = document.getElementById('stat-zone');
  const subEl  = document.getElementById('stat-difficulty');
  if (!zoneEl || !subEl) return;
  const zoneLabel   = STATE.zoneId ? 'Zone ' + STATE.zoneId : '';
  const zoneDisplay = STATE.zoneName && STATE.zoneName !== '—' ? STATE.zoneName : (zoneLabel || '—');
  zoneEl.textContent = zoneDisplay;
  subEl.textContent  = zoneDisplay === zoneLabel ? '' : zoneLabel;
}

function renderRoster() {
  loadSeasonHistoryList();
  const players = STATE.rosterRankFilter === 'all'
    ? STATE.players
    : STATE.players.filter(p => (p.rank || 'Main').toLowerCase() === STATE.rosterRankFilter);

  // Stats
  document.getElementById('stat-total').textContent = players.length;
  renderZoneCard();

  // Avg iLvl, plus the average of just the top 20 / top 10 equipped ilvls --
  // a closer read on raid-ready strength than a whole-roster average, which
  // gets diluted by alts and undergeared members.
  const ilvls = players.filter(p => p.ilvl > 0).map(p => p.ilvl).sort((a, b) => b - a);
  document.getElementById('stat-ilvl').textContent = ilvls.length
    ? (ilvls.reduce((a,b) => a+b, 0) / ilvls.length).toFixed(0)
    : '—';
  const avgOfTopN = n => {
    const top = ilvls.slice(0, n);
    return top.length ? (top.reduce((a,b) => a+b, 0) / top.length).toFixed(0) : '—';
  };
  document.getElementById('stat-ilvl-top20').textContent = avgOfTopN(20);
  document.getElementById('stat-ilvl-top10').textContent = avgOfTopN(10);

  // Raid buffs
  renderRaidBuffs(players);
  renderRaidUtility(players);

  // Roster by role
  const roles = [
    { key: ['tank'],           label: 'TANKS',   color: '#C79C6E' },
    { key: ['heal', 'healer'], label: 'HEALERS', color: '#1EFF00' },
    { key: ['melee'],          label: 'MELEE',   color: '#FF8000' },
    { key: ['ranged'],         label: 'RANGED',  color: '#69CCF0' },
  ];

  const rosterEl = document.getElementById('roster-by-role');
  rosterEl.innerHTML = '';

  document.getElementById('stat-buffs').textContent = GAME.raidBuffs.filter(b => buffCovered(b, players)).length;
  const buffsTotal = document.getElementById('stat-buffs-total');
  if (buffsTotal) buffsTotal.textContent = `of ${GAME.raidBuffs.length} covered`;

  // ── Role sections (flat list, wrapping) ──
  roles.forEach(role => {
    const group = players.filter(p => role.key.includes(p.role));
    if (group.length === 0) return;

    const section = document.createElement('div');
    section.className = 'role-section';
    section.innerHTML = `
      <div class="role-header" style="border-left-color:${role.color};">
        <h3>${role.label}</h3>
        <span class="role-count">${group.length} players</span>
      </div>
      <div class="player-grid" id="grid-${role.label}"></div>
    `;
    rosterEl.appendChild(section);

    const grid = section.querySelector('.player-grid');
    group.sort((a,b) => a.name.localeCompare(b.name)).forEach(player => {
      const color = CLASS_COLORS[player.class] || '#888';
      const card  = document.createElement('div');
      card.className = 'player-card';
      card.style.setProperty('--class-color', color);
      card.innerHTML = `
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">
          <div style="flex:1; min-width:0;">
            <div class="player-name" style="display:flex; align-items:center; gap:6px;">
              ${escapeHtml(player.name)}
              ${player.flex_tank ? `<span title="Flex Tank" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#C79C6E; flex-shrink:0;"></span>` : ''}
              ${player.flex_heal ? `<span title="Flex Healer" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#1EFF00; flex-shrink:0;"></span>` : ''}
              ${player.flex_melee ? `<span title="Flex Melee" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#FF8000; flex-shrink:0;"></span>` : ''}
              ${player.flex_ranged ? `<span title="Flex Ranged" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#69CCF0; flex-shrink:0;"></span>` : ''}
              ${player.can_flex_tank && !player.flex_tank ? `<span title="Can flex Tank (pending)" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#C79C6E; opacity:0.4; flex-shrink:0;"></span>` : ''}
              ${player.can_flex_heal && !player.flex_heal ? `<span title="Can flex Healer (pending)" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#1EFF00; opacity:0.4; flex-shrink:0;"></span>` : ''}
              ${player.can_flex_melee && !player.flex_melee ? `<span title="Can flex Melee (pending)" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#FF8000; opacity:0.4; flex-shrink:0;"></span>` : ''}
              ${player.can_flex_ranged && !player.flex_ranged ? `<span title="Can flex Ranged (pending)" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#69CCF0; opacity:0.4; flex-shrink:0;"></span>` : ''}
            </div>
            <div class="player-meta">
              <span class="player-class">${escapeHtml(player.class)}</span>
              ${player.server ? `<span>·</span><span style="font-size:11px;color:var(--text-mute);">${escapeHtml(player.serverDisplay || player.server)}</span>` : ''}
            </div>
          </div>
          ${player.ilvl ? `<div style="font-size:13px; font-weight:700; color:var(--gold); flex-shrink:0; padding-top:2px;">${Math.round(player.ilvl)}</div>` : ''}
        </div>
      `;
      card.onclick = () => openProfile(player);
      grid.appendChild(card);
    });
  });

  // ── Class breakdown section ──
  const classSection = document.createElement('div');
  classSection.style.cssText = 'margin-top: 32px;';
  const classDivider = document.createElement('div');
  classDivider.style.cssText = `
    font-size: 11px; font-weight: 700; letter-spacing: 3px;
    text-transform: uppercase; color: var(--text-mute);
    margin-bottom: 16px; padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  `;
  classDivider.textContent = 'BY CLASS';
  classSection.appendChild(classDivider);

  // Group all players by class
  const byClass = {};
  players.forEach(p => {
    if (!byClass[p.class]) byClass[p.class] = [];
    byClass[p.class].push(p);
  });

  const classGrid = document.createElement('div');
  classGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px;';

  Object.keys(byClass).sort().forEach(cls => {
    const color   = CLASS_COLORS[cls] || '#888';
    const clsCard = document.createElement('div');
    clsCard.style.cssText = `
      background: var(--bg2);
      border: 1px solid var(--border);
      border-left: 3px solid ${color};
      border-radius: 6px;
      padding: 12px 14px;
    `;

    const clsHeader = document.createElement('div');
    clsHeader.style.cssText = `
      font-size: 10px; font-weight: 700; letter-spacing: 2px;
      text-transform: uppercase; color: ${color};
      margin-bottom: 8px; padding-bottom: 6px;
      border-bottom: 1px solid ${color}33;
    `;
    clsHeader.textContent = cls.toUpperCase() + ' (' + byClass[cls].length + ')';
    clsCard.appendChild(clsHeader);

    const nameWrap = document.createElement('div');
    nameWrap.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';
    byClass[cls].sort((a,b) => a.name.localeCompare(b.name)).forEach(player => {
      const pill = document.createElement('span');
      pill.style.cssText = `
        font-size: 13px; font-weight: 600; color: ${color};
        cursor: pointer; padding: 2px 6px;
        background: ${color}15; border-radius: 3px;
        border: 1px solid ${color}33;
        transition: all 0.15s;
      `;
      pill.textContent = player.name;
      pill.onclick = () => openProfile(player);
      pill.onmouseover = () => pill.style.background = color + '30';
      pill.onmouseout  = () => pill.style.background = color + '15';
      nameWrap.appendChild(pill);
    });
    clsCard.appendChild(nameWrap);
    classGrid.appendChild(clsCard);
  });

  classSection.appendChild(classGrid);
  rosterEl.appendChild(classSection);

  // ── Armor type breakdown section ──
  const ARMOR_TYPES = {
    cloth:   ['mage', 'priest', 'warlock'],
    leather: ['druid', 'rogue', 'monk', 'demon hunter'],
    mail:    ['hunter', 'shaman', 'evoker'],
    plate:   ['warrior', 'paladin', 'death knight'],
  };
  const CLASS_TO_ARMOR = {};
  Object.entries(ARMOR_TYPES).forEach(([armor, classes]) => {
    classes.forEach(cls => { CLASS_TO_ARMOR[cls] = armor; });
  });

  const armorSection = document.createElement('div');
  armorSection.style.cssText = 'margin-top: 32px;';
  const armorDivider = document.createElement('div');
  armorDivider.style.cssText = `
    font-size: 11px; font-weight: 700; letter-spacing: 3px;
    text-transform: uppercase; color: var(--text-mute);
    margin-bottom: 16px; padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  `;
  armorDivider.textContent = 'BY ARMOR TYPE';
  armorSection.appendChild(armorDivider);

  const byArmor = {};
  players.forEach(p => {
    const armor = CLASS_TO_ARMOR[p.class];
    if (!armor) return;
    if (!byArmor[armor]) byArmor[armor] = [];
    byArmor[armor].push(p);
  });

  const armorGrid = document.createElement('div');
  armorGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px;';

  ['cloth', 'leather', 'mail', 'plate'].forEach(armor => {
    if (!byArmor[armor] || byArmor[armor].length === 0) return;
    const color      = '#c8a84b'; // var(--gold)
    const armorCard  = document.createElement('div');
    armorCard.style.cssText = `
      background: var(--bg2);
      border: 1px solid var(--border);
      border-left: 3px solid ${color};
      border-radius: 6px;
      padding: 12px 14px;
    `;

    const armorHeader = document.createElement('div');
    armorHeader.style.cssText = `
      font-size: 10px; font-weight: 700; letter-spacing: 2px;
      text-transform: uppercase; color: ${color};
      margin-bottom: 8px; padding-bottom: 6px;
      border-bottom: 1px solid ${color}33;
    `;
    armorHeader.textContent = armor.toUpperCase() + ' (' + byArmor[armor].length + ')';
    armorCard.appendChild(armorHeader);

    const nameWrap = document.createElement('div');
    nameWrap.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';
    byArmor[armor].sort((a,b) => a.name.localeCompare(b.name)).forEach(player => {
      const clsColor = CLASS_COLORS[player.class] || '#888';
      const pill = document.createElement('span');
      pill.style.cssText = `
        font-size: 13px; font-weight: 600; color: ${clsColor};
        cursor: pointer; padding: 2px 6px;
        background: ${clsColor}15; border-radius: 3px;
        border: 1px solid ${clsColor}33;
        transition: all 0.15s;
      `;
      pill.textContent = player.name;
      pill.onclick = () => openProfile(player);
      pill.onmouseover = () => pill.style.background = clsColor + '30';
      pill.onmouseout  = () => pill.style.background = clsColor + '15';
      nameWrap.appendChild(pill);
    });
    armorCard.appendChild(nameWrap);
    armorGrid.appendChild(armorCard);
  });

  armorSection.appendChild(armorGrid);
  rosterEl.appendChild(armorSection);

  // Other/unknown role players
  const known = roles.flatMap(r => r.key);
  const other = players.filter(p => !known.includes(p.role));
  if (other.length > 0) {
    const section = document.createElement('div');
    section.className = 'role-section';
    section.innerHTML = `
      <div class="role-header">
        <h3>OTHER</h3>
        <span class="role-count">${other.length} players</span>
      </div>
      <div class="player-grid" id="grid-other"></div>
    `;
    rosterEl.insertBefore(section, classSection);
    const grid = section.querySelector('.player-grid');
    other.forEach(player => {
      const color = CLASS_COLORS[player.class] || '#888';
      const card = document.createElement('div');
      card.className = 'player-card';
      card.style.setProperty('--class-color', color);
      card.innerHTML = `<div class="player-name">${escapeHtml(player.name)}</div>`;
      card.onclick = () => openProfile(player);
      grid.appendChild(card);
    });
  }
}

// Renders into the roster tab's grid by default; the Next Season survey's
// projected roster passes its own.
function renderRaidBuffs(players, grid = document.getElementById('raid-buffs-grid'), list = GAME.raidBuffs) {
  if (!grid) return;
  grid.innerHTML = '';
  list.forEach(b => {
    const pill = buffPill(b, players);
    const card = document.createElement('div');
    card.className = 'buff-card';
    card.title = b.providers.map(providerLabel).join(', ');
    const buffInner = pill.covered
      ? `<div class="buff-name" style="color:${pill.color};">${escapeHtml(pill.title)}</div><div class="buff-class" style="color:${pill.color};">${escapeHtml(pill.sub)}</div>`
      : `<div class="buff-name" style="color:var(--text-dim);">${escapeHtml(pill.title)}</div>${pill.sub ? `<div class="buff-class" style="color:var(--text-mute);">${escapeHtml(pill.sub)}</div>` : ''}`;
    card.innerHTML = `
      <div class="buff-indicator ${pill.covered ? 'covered' : 'missing'}"></div>
      <div style="flex:1;">${buffInner}</div>
    `;
    grid.appendChild(card);
  });
}

// Raid Utility: same pills as Raid Buffs (Grip, Gate & Stones, ...), not
// counted in the buff total. Hidden for a version with none.
function renderRaidUtility(players) {
  const section = document.getElementById('raid-utility-section');
  if (section) section.style.display = GAME.raidUtility.length ? '' : 'none';
  renderRaidBuffs(players, document.getElementById('raid-utility-grid'), GAME.raidUtility);
}

async function refreshRoster() {
  const btn = document.getElementById('refresh-btn');
  btn.textContent = '↻ Refreshing...';
  btn.disabled = true;
  try {
    await loadRosterFromDB(true);
    renderRoster();
    loadFlexData();
    showToast('Roster refreshed!', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
  btn.textContent = '↻ Refresh';
  btn.disabled = false;
}

// ─────────────────────────────────────────────
//  WCL SCORES
// ─────────────────────────────────────────────
async function detectCurrentZone() {
  // Query WCL for all zones, find the most recent raid zone
  const query = `
    query {
      worldData {
        zones {
          id
          name
          frozen
        }
      }
    }
  `;
  try {
    const data  = await wclQuery(query, { action: 'wclZones' });
    const zones = data?.data?.worldData?.zones || [];
    // Filter to non-frozen zones (active tiers), take the highest ID.
    // WCL has no live/PTR flag on Zone -- frozen just means "this old
    // tier's rankings are locked for caching," unrelated to test-vs-live
    // status. PTR raids get their own zone entries in this same list with
    // frozen: false (since they're actively being logged) and a literal
    // "(PTR)" suffix on the name (confirmed against WCL's own page titles,
    // e.g. "Mythic Sporefall (PTR)") -- exclude those or a PTR zone would
    // false-positive as "the new season" weeks before it actually ships.
    //
    // WCL's zones list also isn't raid-only -- it's every "zone" on the
    // site (the Zone type's own doc says "a raid, dungeon, arena, etc."),
    // and confirmed live: a Mythic+ season rotation (e.g. "Mythic+ Season
    // 2") shows up in this same list, non-frozen, often with a HIGHER id
    // than the actual current raid since keystone seasons ship on their
    // own cadence. There's no type/category field in the API to filter on
    // (checked WCL's schema directly) -- only the naming convention: these
    // wrapper zones are always named "<Content Type> Season N", which no
    // real raid tier is ever named. Exclude that pattern too.
    const active = zones.filter(z =>
      !z.frozen && !/\(PTR\)/i.test(z.name || '') && !/season\s*\d+/i.test(z.name || ''));
    if (active.length === 0) return null;
    active.sort((a, b) => b.id - a.id);
    return active[0];
  } catch(e) {
    console.warn('Zone auto-detect failed:', e);
    return null;
  }
}

// Silent, automatic season advance -- runs on every officer/owner page
// load, no button, no confirmation. If the PTR-filtered detected zone
// differs from this team's current one, the backend (advanceSeason)
// closes the old season, opens a new one dated from the shared
// global_zone_transitions record, and updates teams.zone_id/zone_name --
// the same season changes for the whole team at once, not per-viewer.
// Fully best-effort: any failure here is silent (this is a background
// sync piggybacking on a page load, never something a user is waiting on).
async function checkAndAdvanceSeason() {
  if (!['owner', 'officer'].includes(STATE.myRole)) return;
  if (!STATE.teamId) return;
  try {
    // Detection now lives entirely server-side (Raider.io primary, WCL
    // fallback -- see api/roster.js's advanceSeason) since it needs to
    // cross-reference the team's own WCL zone list too, not just pick a
    // zone client-side. This call is a no-op most of the time (nothing
    // changed) and always safe to fire on every officer page load.
    const resp = await fetch('/api/roster?action=advanceSeason', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId }),
    });
    const data = await resp.json();
    if (!resp.ok || !(data.changed || data.zoneIdFilled)) return;

    STATE.zoneId   = data.zoneId;
    STATE.zoneName = data.zoneName;
    if (STATE.config) { STATE.config.zoneId = data.zoneId; STATE.config.zoneName = data.zoneName; }
    renderZoneCard();
    // zoneIdFilled: same raid, its WCL zone ID just filled in -- not a new season.
    if (data.changed) showToast('Season started: ' + data.zoneName, 'success');
  } catch(e) { /* silent -- best-effort background sync */ }
}

async function wclQuery(query, options = {}) {
  const action = options.action || 'wclQuery';
  const resp = await fetch('/api/roster?action=' + encodeURIComponent(action), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ teamId: STATE.teamId, query }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'WCL request failed');
  return data;
}

function parseColor(pct) {
  if (pct === 100) return '#E5CC80';
  if (pct >= 96)   return '#E268A8';
  if (pct >= 90)   return '#FF8000';
  if (pct >= 75)   return '#A335EE';
  if (pct >= 50)   return '#0070DD';
  if (pct >= 25)   return '#1EFF00';
  return '#555555';
}

// Mitigation %-only color scale (different bands than the standard parse colors)
function mitigationColor(pct) {
  if (pct === 100)        return '#E5CC80'; // gold
  if (pct >= 91)          return '#E268A8'; // pink
  if (pct >= 71)          return '#FF8000'; // orange
  if (pct >= 46)          return '#A335EE'; // purple
  if (pct >= 26)          return '#0070DD'; // blue
  if (pct >= 11)          return '#1EFF00'; // green
  return '#555555';                          // grey (0-10%)
}

function fetchCurrentScoreView() {
  if (STATE.scoreView === 'survival') return fetchSurvivalData();
  if (STATE.scoreView === 'mitigation') return fetchMitigationData();
  return fetchScores();
}

// Wipes the server-side incremental cache for Survival/Mitigation and reprocesses every
// report from scratch. Needed when a boss got stuck with no data under the old logic
// (e.g. a one-pull kill) -- the cache already marked it "done" past that report, so a
// normal Refresh alone won't go back and pick it up.
function rebuildCurrentScoreCache() {
  const view = STATE.scoreView;
  if (view !== 'survival' && view !== 'mitigation') return;
  if (!confirm('This wipes the cached ' + view + ' data and reprocesses every guild report from scratch. It may take several clicks of "Refresh Scores" to finish on a large report history. Continue?')) return;
  if (view === 'survival') {
    STATE.survivorMap = {};
    fetchSurvivalData(true);
  } else {
    STATE.mitigationMap = {};
    fetchMitigationData(true);
  }
}

// Loads (and caches on STATE) the zone's boss list, needed for First Kill's
// per-boss encounterRankings queries -- re-fetched if missing, or if what's
// cached was for a different zone (e.g. the guild moved to a new tier).
async function ensureZoneBosses(zoneId) {
  if (!STATE.bossIds || STATE.bossIds.length === 0 || STATE.bossIdsZoneId !== zoneId) {
    try {
      const bosses = await fetchZoneBosses(zoneId);
      STATE.bossIds       = bosses.map(b => b.id);
      STATE.bossOrder     = bosses.map(b => b.name);
      STATE.bossIdsZoneId = zoneId;
    } catch(e) { STATE.bossIds = []; STATE.bossOrder = []; }
  }
  return { bossIds: STATE.bossIds || [], bossOrder: STATE.bossOrder || [] };
}

// One character's Performance / Oppo-Parse / First Kill data. All three are
// per-character lookups against WCL's character API -- unlike Survival and
// Mitigation, which are built from the guild's own reports -- so this works
// for anyone, including recruits who've never raided with the guild.
// `char` needs { name, server (slug), role }; everything on it is carried
// through onto the result. Never throws: failures come back as
// result.error. `encounterNames` is the boss list from this character's
// rankings, which the roster table uses to pick its columns.
// `size`: Classic's raid size (10/25, 20/40), part of which rankings to read.
async function fetchCharacterWclScores(char, { zoneId, diffId, size, region, bossIds, bossOrder, verbose = false }) {
  const diffArg    = `difficulty: ${diffId}${size ? `, size: ${size}` : ''}`;
  const isHealer   = ['heal', 'healer'].includes(char.role);
  const metric     = isHealer ? ', metric: hps' : ', metric: dps';
  const oppoMetric = isHealer ? ', metric: dps' : ', metric: hps';
  const serverSlug = char.server.toLowerCase().replace(/\s+/g, '-').replace(/'/g, '').replace(/[^a-z0-9-]/g, '');

  // encounterRankings is also a JSON scalar -- alias one per boss, then sort
  // each boss's kills by startTime to find the first kill.
  const bossAliases = bossIds.map((id, i) =>
    `boss${i}: encounterRankings(encounterID: ${id}, ${diffArg}${metric})`
  ).join(' ');

  const query = `query { characterData { character(name: "${char.name}", serverSlug: "${serverSlug}", serverRegion: "${region}") {
    name
    best: zoneRankings(zoneID: ${zoneId}, ${diffArg}${metric})
    oppo: zoneRankings(zoneID: ${zoneId}, ${diffArg}${oppoMetric})
    ${bossAliases}
  } } }`;

  try {
    const data = await wclQuery(query);
    if (data.errors) {
      console.warn('WCL error for', char.name, JSON.stringify(data.errors));
      return { result: { ...char, error: data.errors[0]?.message || 'API error' }, encounterNames: [] };
    }
    const charData = data?.data?.characterData?.character;
    console.log('WCL result for', char.name, ':', charData ? 'found' : 'not found', '| server:', serverSlug, '| zone:', zoneId);
    if (verbose) console.log('[WCL raw best]', JSON.stringify(charData?.best)?.slice(0, 500));

    if (!charData || !charData.best) {
      return { result: { ...char, error: 'Not found' }, encounterNames: [] };
    }

    const parsejson = v => {
      if (!v) return {};
      if (typeof v === 'object') return v;
      try { return JSON.parse(v); } catch(e) { return {}; }
    };
    const zr           = parsejson(charData.best);
    const oppoZr       = parsejson(charData.oppo);
    const rankings     = zr.rankings || [];
    const oppoRankings = oppoZr.rankings || [];

    const fmt = v => v != null ? parseFloat(v).toFixed(1) : 'N/A';
    // Raw DPS/HPS for a ranking entry -- WCL's field is `bestAmount` (confirmed
    // against warcraftlogs.com's own "Highest DPS/HPS" display).
    const fmtAmount = n => {
      n = parseFloat(n);
      if (isNaN(n)) return null;
      if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n/1e3).toFixed(1) + 'k';
      return n.toFixed(0);
    };
    const rawOf    = r => r?.bestAmount != null ? fmtAmount(r.bestAmount) : null;
    const rawNumOf = r => r?.bestAmount != null ? parseFloat(r.bestAmount) : null;

    // The spec their ranked logs are actually on (most common across
    // bosses; the other metric's rankings if this one has none). Recruits'
    // listed spec comes from Raider.io -- whatever they last logged out in --
    // so Recruits compares the two.
    const specCounts = {};
    const rankedSpecs = list => list.filter(r => r.rankPercent != null && (r.spec || r.bestSpec));
    const specSource  = rankedSpecs(rankings).length ? rankedSpecs(rankings) : rankedSpecs(oppoRankings);
    specSource.forEach(r => { const sp = r.spec || r.bestSpec; specCounts[sp] = (specCounts[sp] || 0) + 1; });
    const loggedSpec = Object.entries(specCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const deaths     = zr.deaths     || 0;
    const totalKills = zr.totalKills || 0;
    const deathPct   = totalKills > 0 ? Math.min(100, ((deaths / totalKills) * 100)).toFixed(1) : 'N/A';

    // First Kill: lowest startTime among each boss's kills = the first kill.
    const firstKillMap = {};
    bossIds.forEach((id, i) => {
      const bossName = bossOrder?.[i];
      if (!bossName) return;
      const enc   = parsejson(charData[`boss${i}`]);
      const kills = enc.ranks || enc.rankings || enc.data || [];
      if (kills.length === 0) return;
      const first = [...kills].sort((a, b) => (a.startTime || 0) - (b.startTime || 0))[0];
      if (first?.rankPercent != null) firstKillMap[bossName] = fmt(first.rankPercent);
    });

    if (verbose) {
      console.log('[FirstKill] bossOrder:', bossOrder);
      console.log('[FirstKill] firstKillMap:', JSON.stringify(firstKillMap));
      // Raw DPS/HPS verification -- check these logged keys for the actual field name
      // if rawMap/oppoRawMap come back empty after deploying.
      console.log('[WCL ranking keys]', rankings[0] ? Object.keys(rankings[0]).join(',') : 'no rankings', '| sample:', JSON.stringify(rankings[0]));
    }

    return {
      result: {
        ...char,
        bestAvg:        fmt(zr.bestPerformanceAverage),
        medianAvg:      fmt(zr.medianPerformanceAverage),
        oppoBestAvg:    fmt(oppoZr.bestPerformanceAverage),
        oppoMedianAvg:  fmt(oppoZr.medianPerformanceAverage),
        deathPct,
        rankingMap:     Object.fromEntries(rankings.map(r => [r.encounter?.name, fmt(r.rankPercent)])),
        oppoRankingMap: Object.fromEntries(oppoRankings.map(r => [r.encounter?.name, fmt(r.rankPercent)])),
        rawMap:         Object.fromEntries(rankings.map(r => [r.encounter?.name, rawOf(r)])),
        oppoRawMap:     Object.fromEntries(oppoRankings.map(r => [r.encounter?.name, rawOf(r)])),
        rawNumMap:      Object.fromEntries(rankings.map(r => [r.encounter?.name, rawNumOf(r)])),
        oppoRawNumMap:  Object.fromEntries(oppoRankings.map(r => [r.encounter?.name, rawNumOf(r)])),
        firstKillMap,
        loggedSpec,
        rankings:       rankings.map(r => fmt(r.rankPercent)),
        error:          null,
      },
      encounterNames: rankings.map(r => r.encounter?.name || 'Unknown'),
    };
  } catch(e) {
    return { result: { ...char, error: e.message }, encounterNames: [] };
  }
}

async function fetchScores() {
  const btn = document.getElementById('fetch-scores-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Fetching...';

  const wrap = document.getElementById('scores-table-wrap');
  wrap.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Fetching scores from Warcraft Logs...</div></div>';

  try {
    const zoneId = STATE.zoneId;
    const { wcl: diffId, size } = difficultyInfo(STATE.scoreDifficulty);
    const region = toWclRegion(STATE.config.region);

    const results    = [];
    const bossNames  = [];

    const { bossIds, bossOrder } = await ensureZoneBosses(zoneId);

    for (const player of STATE.players) {
      const { result, encounterNames } = await fetchCharacterWclScores(player,
        { zoneId, diffId, size, region, bossIds, bossOrder, verbose: results.length === 0 });
      results.push(result);

      // Always update bossNames from player with most kills
      if (encounterNames.length > bossNames.length) {
        bossNames.length = 0;
        encounterNames.forEach(n => bossNames.push(n));
      }

      if (!result.error) await sleep(200);
    }

    STATE.scores           = results;
    STATE.bossNames        = bossNames;
    STATE.scoresDifficulty = STATE.scoreDifficulty;
    saveScores(results, bossNames, STATE.zoneId);
    renderScoresTable('all');
    updateScoresFetchBtn(Date.now());
    // Cache scores to localStorage
    try {
      localStorage.setItem(scoresKey(), JSON.stringify({
        scores:    STATE.scores,
        bossNames: STATE.bossNames,
        zoneId:    STATE.zoneId,
        fetchedAt: Date.now(),
      }));
    } catch(e) {}

    // Save scores to Supabase so all devices/members can see them
    if (STATE.teamId) {
          fetch('/api/roster?action=saveScores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teamId:     STATE.teamId,
          zoneId:     STATE.zoneId,
          scores:     STATE.scores,
          bossNames:  STATE.bossNames,
          fetchedAt:  Date.now(),
          difficulty: STATE.scoreDifficulty || GAME.defaultDifficulty,
        }),
      }).catch(() => {});
    }

    const count = results.filter(r => !r.error).length;
    showToast(`Scores fetched for ${count} of ${STATE.players.length} players.`, 'success');
    updateScoresTimestamp(Date.now());
    const fetchBtn = document.getElementById('fetch-scores-btn');
    if (fetchBtn) fetchBtn.textContent = '↻ Refresh Scores';

  } catch(e) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><h3>Error</h3><p>${escapeHtml(e.message)}</p></div>`;
    showToast('Error: ' + e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = '↻ Refresh Scores';
}

function wclNotConnectedHtml() {
  const isOfficer = ['owner', 'officer'].includes(STATE.myRole);
  if (!GAME.sources.wclHost) {
    return `<div class="empty-state"><div class="empty-state-icon">⏳</div><h3>Warcraft Logs for ${escapeHtml(GAME.label)} is coming</h3>
      <p>WCL Scores turn on once Warcraft Logs supports ${escapeHtml(GAME.label)}. Everything else on RaidLead works now.</p></div>`;
  }
  return `<div class="empty-state">
      <div class="empty-state-icon">🔒</div>
      <h3>Warcraft Logs Not Connected</h3>
      <p>${isOfficer
        ? 'Your guild needs its own Warcraft Logs API credentials before WCL Scores will work.'
        : "Your guild hasn't connected Warcraft Logs API credentials yet — ask an officer to set this up."}</p>
      ${isOfficer ? `
        <div style="display:flex; gap:10px; margin-top:12px;">
          <a class="btn-secondary" style="padding:8px 16px; font-size:13px; text-decoration:none; display:inline-flex; align-items:center;" href="https://${GAME.sources.wclHost}.warcraftlogs.com/api/clients/" target="_blank" rel="noopener noreferrer">Create WCL Credentials ↗</a>
          <button class="btn-primary" onclick="showSetup()">Go to Guild Settings</button>
        </div>
      ` : ''}
    </div>`;
}

function renderScoresTable(roleFilter) {
  const wrap   = document.getElementById('scores-table-wrap');
  const bosses = STATE.bossNames;
  const view   = STATE.scoreView || 'performance';

  if (!STATE.config?.hasWclCredentials) {
    wrap.innerHTML = wclNotConnectedHtml();
    return;
  }

  if (view === 'survival' && !STATE.survivorFetched) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🛡</div><h3>No Survival Data</h3><p>Click "Refresh Scores" to fetch survival data from guild reports.</p></div>';
    return;
  }
  if (view === 'mitigation' && !STATE.mitigationFetched) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">%</div><h3>No Mitigation Data</h3><p>Click "Refresh Scores" to fetch mitigation data from guild reports.</p></div>';
    return;
  }
  if (STATE.scores.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📊</div><h3>No Scores Yet</h3><p>Click "Refresh Scores" to load data.</p></div>';
    return;
  }
  // For survival view, still need players list even if survivorMap is empty
  if (view === 'survival' && STATE.scores.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📊</div><h3>Load Performance scores first</h3><p>Switch to Performance tab and fetch scores, then return to Survival.</p></div>';
    return;
  }

  wrap.innerHTML = buildScoresTableHtml({
    scores:     STATE.scores,
    bossNames:  bosses,
    view,
    sortCol:    STATE.scoreSortCol,
    roleFilter,
    showRaw:    STATE.scoreShowRaw,
  });
}

// The WCL scores table itself, shared by the roster's WCL Scores tab and
// Team Management's recruit scores -- one implementation, so the two can't
// drift apart. Takes its data and sort state as arguments rather than
// reading the roster's STATE fields. `sortHandler` / `nameClick` are the
// names of global functions wired into the header and name-cell onclicks
// (nameClick null = name isn't clickable). Survival/Mitigation still read
// the roster's guild-report maps, so only the roster table passes those views.
function buildScoresTableHtml({ scores, bossNames, view, sortCol: rawSortCol, roleFilter = 'all',
                                sortHandler = 'setScoreSort', showRaw = false, nameClick = 'openProfileByName' }) {
  const bosses = bossNames || [];
  const roleGroups = [
    { keys: ['tank'],                   label: 'TANKS'   },
    { keys: ['heal','healer'],          label: 'HEALERS' },
    { keys: ['melee','ranged','dps'],   label: 'DPS'     },
  ];

  // Sort by whichever column header was last clicked (defaults to 'best'), always
  // highest-to-lowest -- there's no ascending mode, it's not a useful view for this data.
  const sortCol = rawSortCol || 'best';
  const sortFn = (a, b) => {
    const av = getScoreSortValue(a, view, sortCol, showRaw);
    const bv = getScoreSortValue(b, view, sortCol, showRaw);
    if (isNaN(av) && isNaN(bv)) return 0;
    if (isNaN(av)) return 1;  // NaN always sorts to the bottom
    if (isNaN(bv)) return -1;
    return bv - av;
  };
  const sortArrow = col => rawSortCol === col ? ' ▼' : '';

  const nameCell = (p, color) => `
          <td style="width:110px; max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            <div class="player-name-cell">
              <div class="class-dot" style="background:${color};"></div>
              <span style="color:${color}; font-family:'Rajdhani',sans-serif; font-weight:600;${nameClick ? ' cursor:pointer;' : ''}"
                ${nameClick ? `onclick="${nameClick}(${jsAttr(p.name)})"` : ''}>${escapeHtml(p.name)}</span>
            </div>
          </td>
          <td style="color:var(--text-mute); font-family:'Rajdhani',sans-serif;">${escapeHtml(p.serverDisplay || p.server || '—')}</td>`;

  // All views use same layout: summary cols + per-boss cols
  // Performance: Best | Median | per-boss best
  // Survival:    Best | Death% | per-boss best  (death% replaces median)
  // First Kill:  Best | Median | per-boss FIRST kill parse
  // Performance: Best | Median | boss cols
  // Survival:    Death % | boss cols  (no median)
  // First Kill:  Average | boss cols  (no median)
  const showMedian = view === 'performance' || view === 'oppoparse';
  const col1Label  = view === 'survival' ? 'Avg Surv%' : view === 'mitigation' ? 'Avg Mitig%' : 'Average';
  const headerCols = showMedian ? `
    <th style="width:52px; min-width:52px; max-width:52px; text-align:center; cursor:pointer;" onclick="${sortHandler}('best')" title="Sort by ${col1Label === 'Average' ? 'Best' : col1Label}">Best${sortArrow('best')}</th><th class="sep-col"></th>
    <th style="width:52px; min-width:52px; max-width:52px; text-align:center; cursor:pointer;" onclick="${sortHandler}('median')" title="Sort by Median">Median${sortArrow('median')}</th><th class="sep-col"></th>`
  : `<th style="width:52px; min-width:52px; max-width:52px; text-align:center; cursor:pointer;" onclick="${sortHandler}('best')" title="Sort by ${col1Label}">${col1Label}${sortArrow('best')}</th><th class="sep-col"></th>`;

  const bossHeaders = bosses.map(b =>
    `<th style="width:52px; min-width:52px; max-width:52px; overflow:hidden; text-align:center; cursor:pointer;" title="Sort by ${escapeHtml(b)}" onclick="${sortHandler}(${jsAttr(b)})">
      <span style="display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px;">${escapeHtml(b.substring(0,5))}${sortArrow(b)}</span>
    </th>`
  ).join('');

  const extraCols = showMedian ? 2 : 1;
  let html = `<div style="overflow-x:auto;"><table class="scores-table"><thead><tr>
    <th style="width:110px; min-width:110px; max-width:110px;">Player</th>
    <th style="width:75px; min-width:75px; max-width:75px;">Server</th>
    ${headerCols}
    ${bossHeaders}
  </tr></thead><tbody>`;

  roleGroups.forEach(group => {
    let players = scores.filter(p => group.keys.includes(p.role));
    if (roleFilter !== 'all') {
      const filterKeys = { tank:['tank'], heal:['heal','healer'], dps:['melee','ranged','dps'] }[roleFilter] || [];
      if (!group.keys.some(k => filterKeys.includes(k))) return;
    }
    if (players.length === 0) return;
    players = [...players].sort(sortFn);

    const colSpan = 2 + extraCols * 2 + bosses.length;
    html += `<tr class="section-label-row"><td colspan="${colSpan}">── ${group.label} ──</td></tr>`;

    players.forEach(p => {
      const color = CLASS_COLORS[p.class] || '#888';

      // Col 1: Best avg — use oppo fields for Oppo-Parse view
      const bestAvgVal = view === 'oppoparse' ? p.oppoBestAvg : p.bestAvg;
      const bestColor  = bestAvgVal !== 'N/A' && bestAvgVal != null ? parseColor(parseFloat(bestAvgVal)) : '';

      // Col 2: Median (performance/firstkill) or Death % (survival)
      let col2Val, col2Bg, col2Fg;
      if (view === 'survival') {
        // Survival % per boss from guild reports
        const playerSurv = STATE.survivorMap?.[p.name] || {};
        // Average of per-boss averages (matching CSV methodology)
        const survVals   = bosses.map(b => playerSurv[b]).filter(v => v != null && !isNaN(v));
        const avgSurv    = survVals.length > 0
          ? (survVals.reduce((a,b)=>a+b,0)/survVals.length).toFixed(1)
          : null;

        // Color: survival % — higher=better. Use WCL parse colors mapped to 0-100%
        const survColor = v => v == null ? '' : parseColor(parseFloat(v));

        const summaryCols = `
          <td class="score-cell" style="width:52px; background:${survColor(avgSurv)}; color:${survColor(avgSurv) ? '#000' : 'var(--text-mute)'}; font-weight:700; font-size:13px; text-align:center;">${avgSurv != null ? avgSurv + '%' : '—'}</td>
          <td class="sep-col"></td>`;
        const bossCols = bosses.map(bossName => {
          const val = playerSurv[bossName];
          const disp = val != null ? val.toFixed(1) + '%' : 'N/A';
          const bg   = val != null ? survColor(val) : '';
          const fg   = bg ? '#000' : 'var(--text-mute)';
          return `<td class="score-cell" title="${escapeHtml(bossName)}" style="width:52px; min-width:52px; max-width:52px; background:${bg}; color:${fg}; font-family:Rajdhani,sans-serif; font-weight:700; font-size:13px; text-align:center;">${escapeHtml(disp)}</td>`;
        }).join('');
        html += `<tr>${nameCell(p, color)}
          ${summaryCols}${bossCols}
        </tr>`;
        return;
      } else if (view === 'mitigation') {
        const playerMit = STATE.mitigationMap?.[p.name] || {};
        const mitVals   = bosses.map(b => playerMit[b]).filter(v => v != null && !isNaN(v));
        const avgMit    = mitVals.length > 0
          ? (mitVals.reduce((a,b)=>a+b,0)/mitVals.length).toFixed(1)
          : null;
        const mitColor = v => v == null ? '' : mitigationColor(parseFloat(v));
        const summaryCols = `
          <td class="score-cell" style="width:52px; background:${mitColor(avgMit)}; color:${mitColor(avgMit) ? '#000' : 'var(--text-mute)'}; font-weight:700; font-size:13px; text-align:center;">${avgMit != null ? avgMit + '%' : '—'}</td>
          <td class="sep-col"></td>`;
        const bossCols = bosses.map(bossName => {
          const val = playerMit[bossName];
          const disp = val != null ? parseFloat(val).toFixed(1) + '%' : 'N/A';
          const bg   = val != null ? mitColor(val) : '';
          const fg   = bg ? '#000' : 'var(--text-mute)';
          return `<td class="score-cell" title="${escapeHtml(bossName)}" style="width:52px; min-width:52px; max-width:52px; background:${bg}; color:${fg}; font-family:Rajdhani,sans-serif; font-weight:700; font-size:13px; text-align:center;">${escapeHtml(disp)}</td>`;
        }).join('');
        html += `<tr>${nameCell(p, color)}
          ${summaryCols}${bossCols}
        </tr>`;
        return;
      } else if (view === 'firstkill') {
        // Best first kill = highest value among all first kill parses
        // Average of all first kill parses in this player's row
        const fkVals = Object.values(p.firstKillMap || {})
          .map(v => parseFloat(v)).filter(v => !isNaN(v));
        const fkAvg = fkVals.length > 0
          ? (fkVals.reduce((a,b) => a+b, 0) / fkVals.length).toFixed(1)
          : 'N/A';
        const fkAvgColor = fkAvg !== 'N/A' ? parseColor(parseFloat(fkAvg)) : '';

        const summaryCols = `
          <td class="score-cell" style="width:52px; background:${fkAvgColor}; color:${fkAvgColor ? '#000' : 'var(--text-mute)'}; font-weight:700; font-size:13px; text-align:center;">${fkAvg !== 'N/A' ? fkAvg : '—'}</td>
          <td class="sep-col"></td>`;
        // Build boss cols from firstKillMap -- no raw DPS/HPS toggle for this view (see setScoreView)
        const bossCols = bosses.map(bossName => {
          const val = p.firstKillMap?.[bossName] || 'N/A';
          const bg = val !== 'N/A' ? parseColor(parseFloat(val)) : '';
          const fg = bg ? (parseFloat(val) < 25 ? '#fff' : '#000') : 'var(--text-mute)';
          return `<td class="score-cell" title="${escapeHtml(bossName)}" style="width:52px; min-width:52px; max-width:52px; background:${bg}; color:${fg}; font-family:Rajdhani,sans-serif; font-weight:700; font-size:13px; text-align:center;">${escapeHtml(val)}</td>`;
        }).join('');
        // Return early with firstkill-specific row
        html += `<tr>${nameCell(p, color)}
          ${summaryCols}
          ${bossCols}
        </tr>`;
        return; // skip the generic row builder below
      } else if (view === 'oppoparse') {
        col2Val = p.oppoMedianAvg || '—';
        col2Bg  = p.oppoMedianAvg !== 'N/A' && p.oppoMedianAvg != null ? parseColor(parseFloat(p.oppoMedianAvg)) : '';
        col2Fg  = col2Bg ? '#000' : 'var(--text-mute)';
      } else {
        col2Val = p.medianAvg || '—';
        col2Bg  = p.medianAvg !== 'N/A' ? parseColor(parseFloat(p.medianAvg)) : '';
        col2Fg  = col2Bg ? '#000' : 'var(--text-mute)';
      }

      const summaryCols = `
        <td class="score-cell" style="width:52px; background:${bestColor}; color:${bestColor ? '#000' : 'var(--text-mute)'}; font-weight:700; font-size:13px; text-align:center;">${escapeHtml(bestAvgVal || '—')}</td>
        <td class="sep-col"></td>
        <td class="score-cell" style="width:52px; min-width:52px; max-width:52px; background:${col2Bg}; color:${col2Fg}; font-weight:700; font-size:13px; text-align:center;">${escapeHtml(col2Val)}</td>
        <td class="sep-col"></td>`;

      // Per-boss columns: performance/oppoparse = best parse (firstkill returns earlier above)
      const bossCols = bosses.map(bossName => {
        let val, raw;
        if (view === 'oppoparse') {
          val = p.oppoRankingMap?.[bossName] || 'N/A';
          raw = p.oppoRawMap?.[bossName];
        } else {
          val = p.rankingMap?.[bossName] || 'N/A';
          raw = p.rawMap?.[bossName];
        }
        const showVal = showRaw ? (raw || '—') : val;
        const bg = !showRaw && val !== 'N/A' ? parseColor(parseFloat(val)) : '';
        const fg = showRaw ? 'var(--text-dim)' : (bg ? (parseFloat(val) < 25 ? '#fff' : '#000') : 'var(--text-mute)');
        const fw = showRaw ? 400 : 700;
        return `<td class="score-cell" title="${escapeHtml(bossName)}" style="width:52px; min-width:52px; max-width:52px; background:${bg}; color:${fg}; font-family:Rajdhani,sans-serif; font-weight:${fw}; font-size:13px; text-align:center;">${escapeHtml(showVal)}</td>`;
      }).join('');

      if (view !== 'firstkill') {
        html += `<tr>${nameCell(p, color)}
          ${summaryCols}
          ${bossCols}
        </tr>`;
      }
    });
  });

  html += '</tbody></table></div>';
  return html;
}

async function fetchMitigationData(reset) {
  // Guard against overlapping fetches (e.g. an impatient double-click) racing on the
  // same server-side incremental cache row and corrupting it with a partial result.
  if (STATE.mitigationFetchInFlight) { showToast('Already fetching mitigation data — please wait for it to finish.', ''); return; }
  STATE.mitigationFetchInFlight = true;
  const btn = document.getElementById('fetch-scores-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Fetching mitigation...'; }
  const wrap = document.getElementById('scores-table-wrap');
  if (wrap) wrap.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Fetching mitigation data from guild reports...<br><small style="opacity:0.6; text-transform:none; letter-spacing:normal;">This may take multiple fetches</small></div></div>';
  // Anchor to Guild Settings' configured zone (not whatever STATE.zoneId currently
  // holds, which can drift if a newer tier was detected elsewhere in the app) --
  // this must match the zone in the WCL Guild Progress URL for reports/bosses to line up.
  const zoneId = STATE.config?.zoneId || STATE.zoneId;
  if ((!STATE.bossIds || STATE.bossIds.length === 0 || STATE.bossIdsZoneId !== zoneId) && zoneId) {
    try {
      const bosses = await fetchZoneBosses(zoneId);
      STATE.bossIds       = bosses.map(b => b.id);
      STATE.bossOrder     = bosses.map(b => b.name);
      STATE.bossIdsZoneId = zoneId;
    } catch(e) {}
  }
  const guildName  = STATE.config?.guild;
  const serverSlug = (STATE.config?.server || '').toLowerCase().replace(/\s+/g, '-');
  const region     = toWclRegion((STATE.config?.region || 'us').toLowerCase());
  const { wcl: diffId, size } = difficultyInfo(STATE.scoreDifficulty);
  if (!zoneId || !guildName) {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh Scores'; }
    STATE.mitigationFetchInFlight = false;
    showToast('Guild config not ready', 'error'); return;
  }
  try {
    const resp = await fetch('/api/roster?action=getMitigation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guildName, serverSlug, region, zoneId, diffId, size,
        guildTagID:   STATE.config?.wclTeamId || null,
        memberNames:  STATE.players.map(p => p.name),
        validBossIds: STATE.bossIds || [],
        teamId:       STATE.teamId,
        reset:        !!reset,
      }),
    });
    if (!resp.ok) throw new Error((await resp.json()).error || 'Mitigation fetch failed');
    const { mitigationMap, bossNames } = await resp.json();
    console.log('[Mitigation] players:', Object.keys(mitigationMap || {}).length, 'bosses:', bossNames?.length);
    // Merge with existing
    if (STATE.mitigationMap && Object.keys(STATE.mitigationMap).length > 0) {
      for (const [player, bosses] of Object.entries(STATE.mitigationMap)) {
        if (!mitigationMap[player]) mitigationMap[player] = {};
        for (const [boss, val] of Object.entries(bosses)) {
          if (mitigationMap[player][boss] == null) mitigationMap[player][boss] = val;
        }
      }
    }
    STATE.mitigationMap           = mitigationMap || {};
    STATE.mitigationFetched       = true;
    STATE.mitigationMapDifficulty = STATE.scoreDifficulty;
    const mitKey = 'raidlead_mitigation_' + STATE.teamId + '_' + zoneId + '_' + (STATE.scoreDifficulty || GAME.defaultDifficulty);
    try { localStorage.setItem(mitKey, JSON.stringify({ mitigationMap, bossNames, savedAt: Date.now() })); } catch(e) {}
    renderScoresTable('all');
    showToast('Mitigation data loaded', 'success');
  } catch(e) {
    console.error('[Mitigation] error:', e.message);
    showToast('Mitigation fetch error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh Scores'; }
    STATE.mitigationFetchInFlight = false;
  }
}

function loadCachedMitigation() {
  const zoneId = STATE.zoneId;
  const diff   = STATE.scoreDifficulty || GAME.defaultDifficulty;
  const { wcl: diffId, size } = difficultyInfo(diff);
  const key    = 'raidlead_mitigation_' + STATE.teamId + '_' + zoneId + '_' + diff;
  if (STATE.teamId) {
    fetch('/api/roster?action=getMitigationCache&teamId=' + STATE.teamId + '&zoneId=' + (STATE.zoneId||'') + '&diffId=' + diffId + (size ? '&size=' + size : ''))
      .then(r => r.json()).then(data => {
        // The difficulty tab may have changed while this request was in flight --
        // don't clobber whatever the user is looking at now with a stale response.
        if (STATE.scoreDifficulty !== diff) return;
        if (data.mitigationMap && Object.keys(data.mitigationMap).length > 0) {
          const localTs = (() => { try { return JSON.parse(localStorage.getItem(key)||'{}').savedAt||0; } catch(e){ return 0; }})();
          if ((data.savedAt||0) >= localTs) {
            STATE.mitigationMap           = data.mitigationMap;
            STATE.mitigationFetched       = true;
            STATE.mitigationMapDifficulty = diff;
            try { localStorage.setItem(key, JSON.stringify({ mitigationMap: data.mitigationMap, bossNames: data.bossNames, savedAt: data.savedAt })); } catch(e) {}
            renderScoresTable('all');
          }
        }
      }).catch(() => {});
  }
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (cached?.mitigationMap && Object.keys(cached.mitigationMap).length > 0) {
      STATE.mitigationMap           = cached.mitigationMap;
      STATE.mitigationFetched       = true;
      STATE.mitigationMapDifficulty = diff;
      renderScoresTable('all');
      return true;
    }
  } catch(e) {}
  return false;
}

async function fetchSurvivalData(reset) {
  // Guard against overlapping fetches (e.g. an impatient double-click) racing on the
  // same server-side incremental cache row and corrupting it with a partial result.
  if (STATE.survivalFetchInFlight) { showToast('Already fetching survival data — please wait for it to finish.', ''); return; }
  if (!STATE.config?.guild) { showToast('Guild not configured', 'error'); return; }
  STATE.survivalFetchInFlight = true;

  const btn = document.getElementById('fetch-scores-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Fetching survival...';

  // Show loading spinner
  const wrap = document.getElementById('scores-table-wrap');
  if (wrap) wrap.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Fetching survival data from guild reports...<br><small style="opacity:0.6; text-transform:none; letter-spacing:normal;">This may take multiple fetches</small></div></div>';

  // Note: STATE.config.difficulty is the guild's general raid difficulty setting and
  // is NOT what filters survival data -- that's STATE.scoreDifficulty (the LFR/Normal/
  // Heroic/Mythic tab selected above the table), logged explicitly below as diffId.
  console.log('[Survival] zoneId:', STATE.config?.zoneId, '| wclTeamId:', STATE.config?.wclTeamId, '| scoreDifficulty:', STATE.scoreDifficulty, '| teamId:', STATE.teamId);

  // Anchor to Guild Settings' configured zone (not whatever STATE.zoneId currently
  // holds, which can drift if a newer tier was detected elsewhere in the app) --
  // this must match the zone in the WCL Guild Progress URL for reports/bosses to line up.
  const zoneId = STATE.config?.zoneId || STATE.zoneId;

  // Ensure boss IDs are loaded before sending -- re-fetch if cached for a different zone
  if ((!STATE.bossIds || STATE.bossIds.length === 0 || STATE.bossIdsZoneId !== zoneId) && zoneId) {
    try {
      const bosses = await fetchZoneBosses(zoneId);
      STATE.bossIds       = bosses.map(b => b.id);
      STATE.bossOrder     = bosses.map(b => b.name);
      STATE.bossIdsZoneId = zoneId;
      console.log('[Survival] fetched bossIds:', STATE.bossIds);
    } catch(e) { console.warn('[Survival] fetchZoneBosses failed:', e.message); }
  }
  const { wcl: diffId, size } = difficultyInfo(STATE.scoreDifficulty);
  const guildName  = STATE.config?.guild;
  const serverSlug = (STATE.config?.server || '').toLowerCase().replace(/\s+/g, '-');
  const region     = toWclRegion((STATE.config?.region || 'us').toLowerCase());

  if (!zoneId || !guildName) {
    btn.disabled = false;
    btn.textContent = '↻ Refresh Scores';
    STATE.survivalFetchInFlight = false;
    showToast('Guild config not ready — check Guild Settings', 'error');
    return;
  }

  try {
    console.log('[Survival] fetching with:', { guildName, serverSlug, region, zoneId, diffId });
    const resp = await fetch('/api/roster?action=getSurvival', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
      guildName, serverSlug, region, zoneId, diffId, size,
      guildTagID:   STATE.config?.wclTeamId || null,
      memberNames:  STATE.players.map(p => p.name),
      validBossIds: STATE.bossIds || [],
      teamId:       STATE.teamId,
      reset:        !!reset,
    }),
    });
    console.log('[Survival] response status:', resp.status);
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error || 'Survival fetch failed: ' + resp.status);
    }
    const respData = await resp.json();
    console.log('[Survival] response keys:', Object.keys(respData));
    const { survivorMap, bossNames } = respData;
    console.log('[Survival] players:', Object.keys(survivorMap || {}).length, 'bosses:', bossNames?.length);
    // Merge with any existing local cache (in case this was a partial fetch)
    if (STATE.survivorMap && Object.keys(STATE.survivorMap).length > 0) {
      for (const [player, bosses] of Object.entries(STATE.survivorMap)) {
        if (!survivorMap[player]) survivorMap[player] = {};
        for (const [boss, val] of Object.entries(bosses)) {
          if (survivorMap[player][boss] == null) survivorMap[player][boss] = val;
        }
      }
    }

    STATE.survivorMap           = survivorMap || {};
    STATE.survivorFetched       = true;
    STATE.survivorMapDifficulty = STATE.scoreDifficulty;

    // Cache to localStorage
    const survivalCacheKey = 'raidlead_survival_' + STATE.teamId + '_' + zoneId + '_' + STATE.scoreDifficulty;
    try {
      localStorage.setItem(survivalCacheKey,
        JSON.stringify({ survivorMap, bossNames, fetchedAt: Date.now() }));
    } catch(e) {}

    // Save to Supabase so all guild members see it
    fetch('/api/roster?action=saveScores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId:     STATE.teamId,
        zoneId:     STATE.zoneId,
        scores:     [{ name: '_survival_cache_', survivorMap, bossNames }],
        bossNames:  bossNames,
        fetchedAt:  Date.now(),
        difficulty: 'surv_' + (STATE.scoreDifficulty || GAME.defaultDifficulty),
      }),
    }).catch(() => {});

    renderScoresTable('all');
    showToast('Survival data loaded', 'success');
  } catch(e) {
    console.error('[Survival] error:', e.message);
    showToast('Survival fetch error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Refresh Scores';
    STATE.survivalFetchInFlight = false;
  }
}

function loadCachedSurvival() {
  const zoneId = STATE.zoneId;
  const diff   = STATE.scoreDifficulty || GAME.defaultDifficulty;
  const { wcl: diffId, size } = difficultyInfo(diff);
  const key    = 'raidlead_survival_' + STATE.teamId + '_' + zoneId + '_' + diff;

  // Always check Supabase for latest (cross-device sync)
  if (STATE.teamId) {
    fetch(`/api/roster?action=getSurvivalCache&teamId=${STATE.teamId}&zoneId=${STATE.zoneId || ''}&diffId=${diffId}${size ? `&size=${size}` : ''}`)
      .then(r => r.json()).then(data => {
        // The difficulty tab may have changed while this request was in flight --
        // don't clobber whatever the user is looking at now with a stale response.
        if (STATE.scoreDifficulty !== diff) return;
        if (data.survivorMap && Object.keys(data.survivorMap).length > 0) {
          const localTs = (() => { try { return JSON.parse(localStorage.getItem(key) || '{}').savedAt || 0; } catch(e) { return 0; } })();
          if ((data.savedAt || 0) >= localTs) {
            STATE.survivorMap           = data.survivorMap;
            STATE.survivorFetched       = true;
            STATE.survivorMapDifficulty = diff;
            try { localStorage.setItem(key, JSON.stringify({ survivorMap: data.survivorMap, bossNames: data.bossNames, savedAt: data.savedAt })); } catch(e) {}
            renderScoresTable('all');
          }
        }
      }).catch(() => {});
  }

  // Load localStorage immediately for instant display
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (cached?.survivorMap && Object.keys(cached.survivorMap).length > 0) {
      STATE.survivorMap           = cached.survivorMap;
      STATE.survivorFetched       = true;
      STATE.survivorMapDifficulty = diff;
      renderScoresTable('all');
      return true;
    }
  } catch(e) {}
  return false;
}

function setScoreView(view, btn) {
  STATE.scoreView = view;
  STATE.scoreRoleFilter = 'all';
  STATE.scoreSortCol = 'best';
  document.querySelectorAll('#score-view-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const diffWrap = document.getElementById('difficulty-filter-wrap');
  if (diffWrap) diffWrap.style.display = 'flex'; // show for all views

  // Raw DPS/HPS toggle: Performance/Oppo-Parse only -- First Kill's underlying WCL data
  // (per-kill encounterRankings entries) doesn't carry a usable raw amount field.
  const metricToggleWrap = document.getElementById('score-metric-toggle-wrap');
  const showsRawToggle = ['performance', 'oppoparse'].includes(view);
  if (metricToggleWrap) metricToggleWrap.style.display = showsRawToggle ? 'flex' : 'none';
  if (!showsRawToggle) STATE.scoreShowRaw = false;
  // The parse/raw button's active class doesn't live-update while the toggle is hidden
  // on other views -- resync it here so it never shows "Raw" highlighted while
  // STATE.scoreShowRaw (and the data actually rendered) has reverted to parse %.
  const parseBtn = document.getElementById('metric-parse-btn');
  const rawBtn   = document.getElementById('metric-raw-btn');
  if (parseBtn) parseBtn.classList.toggle('active', !STATE.scoreShowRaw);
  if (rawBtn)   rawBtn.classList.toggle('active', STATE.scoreShowRaw);

  // Rebuild Cache only applies to the two views backed by a server-side incremental cache
  const rebuildBtn = document.getElementById('score-rebuild-btn');
  if (rebuildBtn) rebuildBtn.style.display = (view === 'survival' || view === 'mitigation') ? 'inline-block' : 'none';

  // Each view's in-memory data is tagged with the difficulty it was loaded for. The
  // difficulty tab is shared across all views, so switching views after changing
  // difficulty elsewhere (e.g. Mythic Survival -> Performance -> Heroic -> back to
  // Survival) must not leave the old view showing stale data under the new tab.
  if (view === 'survival') {
    if (STATE.survivorMapDifficulty !== STATE.scoreDifficulty) {
      STATE.survivorMap = {};
      STATE.survivorFetched = false;
    }
    if (!STATE.survivorFetched) loadCachedSurvival();
  } else if (view === 'mitigation') {
    if (STATE.mitigationMapDifficulty !== STATE.scoreDifficulty) {
      STATE.mitigationMap = {};
      STATE.mitigationFetched = false;
    }
    if (!STATE.mitigationFetched) loadCachedMitigation();
  } else if (STATE.scoresDifficulty !== STATE.scoreDifficulty) {
    STATE.scores    = [];
    STATE.bossNames = [];
    loadCachedScores();
  }
  renderScoresTable('all');
}

// Click a column header to sort by it -- clicking the same column again flips direction.
function setScoreSort(column) {
  // Always highest-to-lowest -- there's no meaningful use case for ascending here.
  STATE.scoreSortCol = column;
  renderScoresTable(STATE.scoreRoleFilter || 'all');
}

// Toggle per-boss cells between showing the parse percentile or the raw DPS/HPS number.
function setScoreMetricMode(mode) {
  STATE.scoreShowRaw = (mode === 'raw');
  const parseBtn = document.getElementById('metric-parse-btn');
  const rawBtn   = document.getElementById('metric-raw-btn');
  if (parseBtn) parseBtn.classList.toggle('active', mode === 'parse');
  if (rawBtn)   rawBtn.classList.toggle('active', mode === 'raw');
  renderScoresTable(STATE.scoreRoleFilter || 'all');
}

// Returns the numeric value used to sort a given player by a given column, for the
// current score view. `column` is either 'best', 'median', or a boss name. `showRaw`
// defaults to the roster tab's own toggle; the recruit table passes its own.
function getScoreSortValue(player, view, column, showRaw = STATE.scoreShowRaw) {
  const avgOf = obj => {
    const vals = Object.values(obj || {}).map(v => parseFloat(v)).filter(v => !isNaN(v));
    return vals.length > 0 ? vals.reduce((a,b) => a+b, 0) / vals.length : NaN;
  };
  if (column === 'best') {
    if (view === 'oppoparse') return parseFloat(player.oppoBestAvg);
    if (view === 'firstkill') return avgOf(player.firstKillMap);
    if (view === 'survival')  return avgOf(STATE.survivorMap?.[player.name]);
    if (view === 'mitigation') return avgOf(STATE.mitigationMap?.[player.name]);
    return parseFloat(player.bestAvg);
  }
  if (column === 'median') {
    if (view === 'oppoparse') return parseFloat(player.oppoMedianAvg);
    return parseFloat(player.medianAvg);
  }
  // Otherwise: column is a boss name
  // When the Raw DPS/HPS toggle is on, sort by the actual raw amount instead of parse % --
  // the displayed cell shows the raw number, so sorting should match what's on screen.
  if (showRaw && ['performance','oppoparse'].includes(view)) {
    if (view === 'oppoparse') return player.oppoRawNumMap?.[column];
    return player.rawNumMap?.[column];
  }
  if (view === 'oppoparse')  return parseFloat(player.oppoRankingMap?.[column]);
  if (view === 'firstkill')  return parseFloat(player.firstKillMap?.[column]);
  if (view === 'survival')   return parseFloat(STATE.survivorMap?.[player.name]?.[column]);
  if (view === 'mitigation') return parseFloat(STATE.mitigationMap?.[player.name]?.[column]);
  return parseFloat(player.rankingMap?.[column]);
}

// ─────────────────────────────────────────────
//  PLAYER PROFILE
// ─────────────────────────────────────────────
function openProfile(player) {
  CURRENT_PROFILE_PLAYER = player;
  const color    = CLASS_COLORS[player.class] || '#888';
  const scoreData = STATE.scores.find(s => s.name.toLowerCase() === player.name.toLowerCase());

  document.getElementById('modal-name').textContent = player.name;
  document.getElementById('modal-name').style.color = color;
  document.getElementById('modal-sub').style.color = 'var(--text-dim)';
  document.getElementById('modal-sub').textContent  =
    `${player.class.toUpperCase()} · ${(player.role || 'unknown').toUpperCase()} · ${player.server || '—'}`;

  // Set flex controls
  const flexTankEl   = document.getElementById('flex-tank-toggle');
  const flexHealEl   = document.getElementById('flex-heal-toggle');
  const flexMeleeEl  = document.getElementById('flex-melee-toggle');
  const flexRangedEl = document.getElementById('flex-ranged-toggle');
  if (flexTankEl)   flexTankEl.checked   = player.flex_tank   || false;
  if (flexHealEl)   flexHealEl.checked   = player.flex_heal   || false;
  if (flexMeleeEl)  flexMeleeEl.checked  = player.flex_melee  || false;
  if (flexRangedEl) flexRangedEl.checked = player.flex_ranged || false;

  // Show player-declared flex status
  const pftEl = document.getElementById('player-flex-tank-status');
  const pfhEl = document.getElementById('player-flex-heal-status');
  const pfmEl = document.getElementById('player-flex-melee-status');
  const pfrEl = document.getElementById('player-flex-ranged-status');
  if (pftEl) pftEl.textContent = 'Can Flex Tank: ' + (player.can_flex_tank ? '✓ Yes' : 'No');
  if (pfhEl) pfhEl.textContent = 'Can Flex Heal: ' + (player.can_flex_heal ? '✓ Yes' : 'No');
  if (pfmEl) pfmEl.textContent = 'Can Flex Melee: ' + (player.can_flex_melee ? '✓ Yes' : 'No');
  if (pfrEl) pfrEl.textContent = 'Can Flex Ranged: ' + (player.can_flex_ranged ? '✓ Yes' : 'No');
  if (pftEl) pftEl.style.color = player.can_flex_tank   ? '#1EFF00' : 'var(--text-mute)';
  if (pfhEl) pfhEl.style.color = player.can_flex_heal   ? '#1EFF00' : 'var(--text-mute)';
  if (pfmEl) pfmEl.style.color = player.can_flex_melee  ? '#1EFF00' : 'var(--text-mute)';
  if (pfrEl) pfrEl.style.color = player.can_flex_ranged ? '#1EFF00' : 'var(--text-mute)';

  const statsEl = document.getElementById('profile-stats');
  const bossEl  = document.getElementById('boss-breakdown');

  if (!scoreData || scoreData.error) {
    statsEl.innerHTML = `<div class="profile-stat" style="grid-column:1/-1;"><div class="profile-stat-label">Status</div><div class="profile-stat-value" style="font-size:18px; color:var(--text-mute);">No score data — fetch WCL scores first</div></div>`;
    bossEl.innerHTML  = '';
  } else {
    const bestColor   = parseColor(parseFloat(scoreData.bestAvg));
    const medianColor = parseColor(parseFloat(scoreData.medianAvg));

    statsEl.innerHTML = `
      <div class="profile-stat">
        <div class="profile-stat-label">Best Avg</div>
        <div class="profile-stat-value" style="color:${bestColor};">${escapeHtml(scoreData.bestAvg)}</div>
      </div>
      <div class="profile-stat">
        <div class="profile-stat-label">Median Avg</div>
        <div class="profile-stat-value" style="color:${medianColor};">${escapeHtml(scoreData.medianAvg)}</div>
      </div>
      <div class="profile-stat">
        <div class="profile-stat-label">iLvl</div>
        <div class="profile-stat-value" style="color:var(--gold);">${player.ilvl || '—'}</div>
      </div>
    `;

    bossEl.innerHTML = STATE.bossNames.map((boss, i) => {
      const val = scoreData.rankings?.[i] || 'N/A';
      const pct = parseFloat(val);
      const c   = !isNaN(pct) ? parseColor(pct) : 'var(--text-mute)';
      const w   = !isNaN(pct) ? pct : 0;
      return `
        <div class="boss-row">
          <div class="boss-name">${escapeHtml(boss)}</div>
          <div class="boss-bar"><div class="boss-bar-fill" style="width:${w}%; background:${c};"></div></div>
          <div class="boss-parse" style="color:${c};">${escapeHtml(val)}</div>
        </div>
      `;
    }).join('');
  }

  document.getElementById('profile-modal').classList.add('open');
}

function openProfileByName(name) {
  const player = STATE.players.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (player) openProfile(player);
}

function closeProfile() {
  document.getElementById('profile-modal').classList.remove('open');
}

document.getElementById('profile-modal').addEventListener('click', function(e) {
  if (e.target === this) closeProfile();
});

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCachedScores() {
  // Capture the difficulty this call is loading for -- STATE.scoreDifficulty could
  // change before the async Supabase fetch below resolves.
  const requestedDifficulty = STATE.scoreDifficulty || GAME.defaultDifficulty;
  const localFetchedAt = (() => {
    try {
      const cached = localStorage.getItem(scoresKey());
      if (!cached) return 0;
      return JSON.parse(cached)?.fetchedAt || 0;
    } catch(e) { return 0; }
  })();

  // Always check Supabase for newer data (cross-device sync)
  if (STATE.teamId) {
    fetch(`/api/roster?action=getScores&teamId=${STATE.teamId}&zoneId=${STATE.zoneId || ''}&difficulty=${requestedDifficulty}`)
      .then(r => r.json()).then(data => {
        if (!data.scores?.length) return;
        // The difficulty tab may have changed while this request was in flight --
        // don't clobber whatever the user is looking at now with a stale response.
        if (STATE.scoreDifficulty !== requestedDifficulty) return;
        const hasRankingMap   = data.scores.some(s => s.rankingMap);
        const hasFirstKillMap = data.scores.some(s => s.firstKillMap);
        const hasOppoMap      = data.scores.some(s => s.oppoBestAvg !== undefined);
        if (!hasRankingMap || !hasFirstKillMap || !hasOppoMap) {
          console.log('Old score format detected, skipping cache — please refresh scores');
          return;
        }
        // Only update if Supabase is newer than local cache
        if ((data.fetchedAt || 0) >= localFetchedAt) {
          STATE.scores           = data.scores;
          STATE.bossNames        = data.bossNames || [];
          STATE.scoresDifficulty = requestedDifficulty;
          try {
            localStorage.setItem(scoresKey(), JSON.stringify({
              scores: data.scores, bossNames: data.bossNames,
              zoneId: STATE.zoneId, fetchedAt: data.fetchedAt,
            }));
          } catch(e) {}
          renderScoresTable('all');
          updateScoresTimestamp(data.fetchedAt);
          const btn = document.getElementById('fetch-scores-btn');
          if (btn) btn.textContent = '↻ Refresh Scores';
        }
      }).catch(() => {});
  }

  // Also load from localStorage immediately for instant display
  try {
    const cached = localStorage.getItem(scoresKey());
    if (cached) {
      const parsed = JSON.parse(cached);
      const hasRankingMap   = parsed.scores?.some(s => s.rankingMap);
      const hasFirstKillMap = parsed.scores?.some(s => s.firstKillMap);
      const hasOppoMap      = parsed.scores?.some(s => s.oppoBestAvg !== undefined);
      if (parsed.scores?.length > 0 && hasRankingMap && hasFirstKillMap && hasOppoMap && (!parsed.zoneId || parsed.zoneId === STATE.zoneId)) {
        STATE.scores           = parsed.scores;
        STATE.bossNames        = parsed.bossNames || [];
        STATE.scoresDifficulty = requestedDifficulty;
        renderScoresTable('all');
        updateScoresTimestamp(parsed.fetchedAt);
        const btn = document.getElementById('fetch-scores-btn');
        if (btn) btn.textContent = '↻ Refresh Scores';
        return true;
      }
    }
  } catch(e) {}
  return false;
}

function updateScoresTimestamp(fetchedAt) {
  const el = document.getElementById('scores-timestamp');
  if (!el) return;
  if (!fetchedAt) { el.textContent = ''; return; }
  const mins = Math.round((Date.now() - fetchedAt) / 60000);
  if (mins < 1)   el.textContent = 'Fetched just now';
  else if (mins < 60) el.textContent = `Fetched ${mins}m ago`;
  else {
    const hrs = Math.floor(mins / 60);
    el.textContent = `Fetched ${hrs}h ago`;
  }
}

// Update timestamp every minute while page is open
setInterval(() => {
  try {
    const cached = localStorage.getItem(scoresKey());
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.fetchedAt) updateScoresTimestamp(parsed.fetchedAt);
    }
  } catch(e) {}
}, 60000);

function updateScoresFetchBtn(fetchedAt) {
  const btn = document.getElementById('fetch-scores-btn');
  if (!btn) return;
  btn.textContent = fetchedAt ? '↻ Refresh Scores · ' + formatTimeAgo(fetchedAt) : '⚔ Fetch Scores';
  btn.disabled = false;
}

function switchToDetectedZone() {
  if (!STATE.detectedZone) return;
  STATE.zoneId             = STATE.detectedZone.id;
  STATE.zoneName           = STATE.detectedZone.name;
  STATE.config.zoneId      = STATE.detectedZone.id;
  STATE.config.zoneName    = STATE.detectedZone.name;
  STATE.config.wclUrl      = '';
  STATE.detectedZone       = null;
  STATE.scores             = [];
  STATE.bossNames          = [];
  saveConfig(STATE.config);
  clearCachedScores();
  updateScoresFetchBtn(null);
  renderScoresTable('all');
  document.getElementById('zone-banner').style.display = 'none';
  renderZoneCard();
  showToast('Switched to ' + STATE.zoneName + ' (Zone ' + STATE.zoneId + ')', 'success');
}

function dismissZoneBanner() {
  if (STATE.detectedZone) setDismissedZone(STATE.detectedZone.id);
  STATE.detectedZone = null;
  document.getElementById('zone-banner').style.display = 'none';
}

// ─────────────────────────────────────────────
//  RAID NIGHT (internal names still say "planner" -- not user-facing)
// ─────────────────────────────────────────────
const PLANNER_KEY = 'raidlead_planner';

function savePlannerState(selected) {
  // No longer persisting to localStorage — DB is source of truth
  // Keep this as a no-op so existing call sites don't break
}

function applyPlanData(planData) {
  if (!planData?.plan) return;
  const members = planData.plan.raid_plan_members || [];
  const names = new Set();
  const flex  = {};
  members.forEach(m => {
    const name = m.characters?.name;
    if (!name) return;
    names.add(name);
    if (m.assigned_role && m.assigned_role !== 'primary') {
      flex[name] = m.assigned_role; // 'flex_tank' or 'flex_heal'
    }
  });
  plannerSelected  = names;
  flexRoleSelected = flex;
  saveFlexSlots();
  STATE.plannerSwaps = planData.plan.swaps || [];
  // Restore the raid date this plan was saved for, if present
  if (planData.plan.raid_date) {
    STATE.plannerDate = planData.plan.raid_date;
    updatePlannerDateLabel();
  }
  renderPlannerChecklist();
  renderPlannerRoster();
  if (planData.plan.published) {
    STATE.raidPlanPublished = true;
    const badge = document.getElementById('plan-status-badge');
    if (badge) {
      badge.textContent = 'PUBLISHED';
      badge.style.background  = 'rgba(30,255,0,0.1)';
      badge.style.color       = '#1EFF00';
      badge.style.borderColor = 'rgba(30,255,0,0.3)';
      badge.style.display     = 'inline-block';
    }
    document.getElementById('planner-edit-btn').style.display    = ['owner', 'officer'].includes(STATE.myRole) ? 'block' : 'none';
    document.getElementById('planner-publish-btn').style.display = 'none';
    document.getElementById('planner-import-btn').style.display  = 'none';
  }
}

// Escapes text for safe insertion into innerHTML as visible content (does NOT make
// a value safe inside an onclick="..." attribute -- only use for text nodes/content).
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Safely embeds a value as an argument in an inline HTML event-handler
// attribute, e.g. `onclick="fn(${jsAttr(name)})"`. JSON.stringify makes it a
// correctly-escaped JS string literal (handles quotes/backslashes for the JS
// context); escapeHtml on top of that stops the literal's own quotes from
// closing the surrounding double-quoted HTML attribute early. Verified this
// round-trips real names correctly and neutralizes injected HTML/JS alike.
function jsAttr(value) {
  return escapeHtml(JSON.stringify(String(value)));
}

// Helper — detect if a hex color is light (needs dark text)
function isLightColor(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return (r*299 + g*587 + b*114) / 1000 > 128;
}

// Selected player names (persisted)
// Always start with empty selection — DB is the source of truth for published plans
// localStorage is only used as a draft buffer during active edit sessions
let plannerSelected = new Set();
// Clear any stale cached plan — it will be loaded fresh from DB
try { localStorage.removeItem(PLANNER_KEY); } catch(e) {}

// Find the next upcoming raid day on/after today, based on recurring weekly schedule + one-off extra nights
function nextUpcomingRaidDate() {
  const recurringDays = STATE.config?.raidDays || [];
  const extraDays     = STATE.attendanceExtraDays || [];
  const todayStr = attendanceDateStr(new Date());
  // Start from tomorrow so we advance past dates that have already happened today
  // (if today IS a raid day, include it only if we haven't passed raid time — we don't
  //  track raid time yet, so just include today if it's a raid day)
  for (let i = 0; i < 60; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dStr = attendanceDateStr(d);
    if (recurringDays.includes(d.getDay()) || extraDays.includes(dStr)) {
      return dStr;
    }
  }
  return todayStr;
}

// Load the plan for a specific raid date, clearing selections if none exists.
// attendanceFresh: the caller just loaded attendance, so don't fetch it again.
async function loadPlanForDate(dateStr, { attendanceFresh = false } = {}) {
  if (!dateStr || !STATE.teamId) return;

  // Reset immediately so checklist is never stuck in a stale locked/published state
  STATE.raidPlanPublished = false;
  STATE.raidPlanMode      = null;
  plannerSelected         = new Set();
  flexRoleSelected        = {};
  STATE.plannerSwaps      = [];
  saveFlexSlots();
  renderPlannerChecklist();
  renderPlannerRoster();

  // Always refresh attendance marks alongside the plan itself --
  // STATE.attendanceMarks is otherwise only ever fetched once per session
  // (see showTab's attendanceLoaded gate), so a teammate marking themselves
  // unavailable after this session's first Raid Night visit would silently
  // never show up as Out here, even on a fresh publish or a later reopen
  // of this same tab, without an explicit refresh on every load.
  const [planData] = await Promise.all([fetchRaidPlanFromDB(dateStr), attendanceFresh ? null : loadAttendanceData()]);
  console.log('[Planner] loadPlanForDate', dateStr, planData?.plan ? 'found' : 'none');
  if (planData?.plan) {
    applyPlanData(planData);
  }
  // No plan: already cleared above
  // Reflect published state in the badge
  const badge = document.getElementById('plan-status-badge');
  // Edit/Publish/Import are officer-only regardless of published state --
  // this function runs on every tab/date load and was previously showing
  // them unconditionally, silently overriding whatever applyRolePermissions
  // had correctly hidden for a Member/Viewer moments earlier.
  const isOfficerForPlan = ['owner', 'officer'].includes(STATE.myRole);
  if (planData?.plan?.published) {
    STATE.raidPlanPublished = true;
    STATE.raidPlanMode      = 'view';
    if (badge) {
      badge.textContent    = 'PUBLISHED';
      badge.style.background  = 'rgba(30,255,0,0.1)';
      badge.style.color       = '#1EFF00';
      badge.style.borderColor = 'rgba(30,255,0,0.3)';
    }
    const editBtn = document.getElementById('planner-edit-btn');
    if (editBtn) editBtn.style.display = isOfficerForPlan ? 'block' : 'none';
    const pubBtn = document.getElementById('planner-publish-btn');
    if (pubBtn) pubBtn.style.display = 'none';
    const importBtn = document.getElementById('planner-import-btn');
    if (importBtn) importBtn.style.display = 'none';
  } else {
    STATE.raidPlanPublished = false;
    STATE.raidPlanMode      = null;
    if (badge) {
      badge.textContent    = 'DRAFT';
      badge.style.background  = 'rgba(255,107,107,0.1)';
      badge.style.color       = '#ff6b6b';
      badge.style.borderColor = 'rgba(255,107,107,0.3)';
    }
    const editBtn = document.getElementById('planner-edit-btn');
    if (editBtn) editBtn.style.display = 'none';
    const pubBtn = document.getElementById('planner-publish-btn');
    if (pubBtn) pubBtn.style.display = isOfficerForPlan ? 'block' : 'none';
    const importBtn = document.getElementById('planner-import-btn');
    if (importBtn) importBtn.style.display = isOfficerForPlan ? 'inline-flex' : 'none';
  }
  const clearBtn = document.getElementById('planner-clear-btn');
  if (clearBtn) clearBtn.style.display = 'none';
  const editBanner = document.getElementById('edit-mode-banner');
  if (editBanner) editBanner.style.display = 'none';
}

// Build a sorted list of all known raid dates (recurring + extras) on/around today
function getAllRaidDates(windowDays = 90) {
  const recurringDays = STATE.config?.raidDays || [];
  const extraDays     = new Set(STATE.attendanceExtraDays || []);
  const dates         = new Set();
  const today         = new Date();
  for (let i = -windowDays; i <= windowDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dStr = attendanceDateStr(d);
    if (recurringDays.includes(d.getDay()) || extraDays.has(dStr)) {
      dates.add(dStr);
    }
  }
  return [...dates].sort();
}

function navigatePlannerDate(delta) {
  const all     = getAllRaidDates();
  const current = STATE.plannerDate;
  const idx     = all.indexOf(current);
  let next;
  if (idx === -1) {
    next = delta > 0 ? all.find(d => d > current) : [...all].reverse().find(d => d < current);
  } else {
    next = all[idx + delta];
  }
  if (!next) { showToast(delta > 0 ? 'No future raid nights found' : 'No earlier raid nights found', ''); return; }
  STATE.plannerDate = next;
  updatePlannerDateLabel();
  if (STATE.raidPlanMode !== 'edit') loadPlanForDate(next);
  else { renderPlannerChecklist(); renderPlannerRoster(); }
}

function updatePlannerDateLabel() {
  const label = document.getElementById('planner-date-label');
  if (!label) return;
  if (!STATE.plannerDate) { label.textContent = '—'; return; }
  const d = new Date(STATE.plannerDate + 'T00:00:00');
  label.textContent = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  const editBtn = document.getElementById('planner-date-edit-btn');
  if (editBtn) {
    const isOfficer = ['owner','officer'].includes(STATE.myRole);
    editBtn.style.display = isOfficer ? 'inline-block' : 'none';
  }
}

function openPlannerDatePicker() {
  const input = document.getElementById('planner-date-input');
  if (!input) return;
  input.value = STATE.plannerDate || nextUpcomingRaidDate();
  input.style.display = 'inline-block';
  input.focus();
  if (input.showPicker) input.showPicker();
}

function setPlannerDate(dateStr) {
  if (!dateStr) return;
  STATE.plannerDate = dateStr;
  document.getElementById('planner-date-input').style.display = 'none';
  updatePlannerDateLabel();
  if (STATE.raidPlanMode !== 'edit') {
    loadPlanForDate(dateStr);
  } else {
    renderPlannerChecklist();
    renderPlannerRoster();
  }
}

function getUnavailableNamesForDate(dateStr) {
  if (!dateStr) return new Set();
  return new Set(
    (STATE.attendanceMarks || [])
      .filter(m => m.raid_date === dateStr && m.status === 'unavailable')
      .map(m => m.character_name)
  );
}

function renderOutUnavailableSection() {
  const wrap = document.getElementById('plan-unavailable-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  const unavailableNames = getUnavailableNamesForDate(STATE.plannerDate);
  if (!unavailableNames || unavailableNames.size === 0) return;

  const seenNames = new Set();
  const uniquePlayers = STATE.players.filter(p => {
    if (seenNames.has(p.name)) return false;
    seenNames.add(p.name);
    return true;
  });

  const unavailablePlayers = uniquePlayers
    .filter(p => unavailableNames.has(p.name))
    .sort((a,b) => a.name.localeCompare(b.name));
  if (unavailablePlayers.length === 0) return;

  const col = document.createElement('div');
  col.innerHTML = `
    <div class="plan-role-label" style="border-bottom: 1px solid #FF333333; color:#FF6666;">
      OUT / UNAVAILABLE <span style="color:#FF6666; opacity:0.7; font-weight:600; font-size:11px; margin-left:4px;">(${unavailablePlayers.length})</span>
    </div>
  `;

  const pillsWrap = document.createElement('div');
  pillsWrap.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-top:8px;';
  unavailablePlayers.forEach(p => {
    const color = CLASS_COLORS[p.class] || '#888';
    const pill  = document.createElement('div');
    pill.className = 'plan-player-pill';
    pill.style.background = 'transparent';
    pill.style.border = `1px solid #FF333366`;
    pill.style.opacity = '0.7';
    pill.innerHTML = `<div class="class-dot" style="background:${color}; border:1px solid ${color};"></div><span style="color:${color};">${escapeHtml(p.name)}</span>${joinOrderBadge(p)}<span style="margin-left:auto; font-size:10px; color:#FF6666; text-transform:uppercase; letter-spacing:1px;">Out</span>`;
    pill.title = `${p.name} marked themselves unavailable for this raid night`;
    pillsWrap.appendChild(pill);
  });
  col.appendChild(pillsWrap);
  wrap.appendChild(col);
}

// Boss-by-boss swaps against the published roster (e.g. "Turtles: Dust out, Feided in").
// Each new swap's OUT/IN options reflect the roster state AFTER every earlier swap in the
// list has been applied (so swapping Feided in for Dust means the next swap offers Feided
// to sit out and Dust to come back in) -- but the swap records themselves are independent
// of the published roster itself, purely a reference log of what changed and when.
function getSwapRosterState() {
  const current = new Set(plannerSelected);
  (STATE.plannerSwaps || []).forEach(s => {
    current.delete(s.outName);
    current.add(s.inName);
  });
  return current;
}

function renderPlannerSwaps() {
  const wrap = document.getElementById('plan-swaps-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  const isOfficer = ['owner', 'officer'].includes(STATE.myRole);
  const swaps = STATE.plannerSwaps || [];
  if (swaps.length === 0 && !isOfficer) return;

  const col = document.createElement('div');
  col.id = 'plan-swaps-col';
  col.innerHTML = `
    <div class="plan-role-label" style="border-bottom: 1px solid var(--gold-dim); color:var(--gold);">
      SWAPS${swaps.length > 0 ? ` <span style="color:var(--gold); opacity:0.7; font-weight:600; font-size:11px; margin-left:4px;">(${swaps.length})</span>` : ''}
    </div>
  `;

  const swapPill = name => {
    const player = STATE.players.find(p => p.name === name);
    const color  = CLASS_COLORS[player?.class] || '#888';
    const textColor = isLightColor(color) ? '#000000' : '#ffffff';
    return `<div class="plan-player-pill" style="background:${color}; border:1px solid ${color}; margin-bottom:0; cursor:default;">
      <div class="class-dot" style="background:${textColor}22; border:1px solid ${textColor}44;"></div>
      <span style="color:${textColor}; text-shadow: 0 1px 2px rgba(0,0,0,0.4);">${escapeHtml(name)}</span>${joinOrderBadge(player)}
    </div>`;
  };

  // Group swaps by boss (in order of first appearance) so several swaps against
  // the same boss show as one card with multiple rows, instead of a separate
  // card per swap.
  const bossOrder = [];
  const swapsByBoss = {};
  swaps.forEach(s => {
    if (!swapsByBoss[s.boss]) { swapsByBoss[s.boss] = []; bossOrder.push(s.boss); }
    swapsByBoss[s.boss].push(s);
  });

  if (bossOrder.length > 0) {
    const listWrap = document.createElement('div');
    listWrap.style.cssText = 'display:flex; flex-direction:column; gap:10px; margin-top:8px;';
    bossOrder.forEach(boss => {
      const card = document.createElement('div');
      card.style.cssText = 'background:var(--bg2); border:1px solid var(--border); border-radius:6px; padding:10px 12px 12px;';

      const header = document.createElement('div');
      header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;';
      const bossLabel = document.createElement('div');
      bossLabel.style.cssText = 'color:var(--gold); font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase;';
      bossLabel.textContent = boss;
      header.appendChild(bossLabel);
      if (isOfficer) {
        const addToBossBtn = document.createElement('div');
        addToBossBtn.title = 'Add another swap for ' + boss;
        addToBossBtn.style.cssText = 'cursor:pointer; color:var(--gold); font-size:16px; line-height:1; font-weight:700; padding:2px 4px;';
        addToBossBtn.textContent = '+';
        addToBossBtn.onclick = () => openAddSwapForm(col, null, boss, card);
        header.appendChild(addToBossBtn);
      }
      card.appendChild(header);

      const rowsWrap = document.createElement('div');
      rowsWrap.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
      swapsByBoss[boss].forEach(swap => {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid; grid-template-columns:1fr 20px 1fr auto; align-items:center; gap:6px;';
        row.innerHTML = `
          <div>
            <div class="plan-role-label" style="font-size:9px; margin-bottom:5px; padding-bottom:4px; border-bottom:1px solid #FF333333; color:#FF6666;">OUT</div>
            ${swapPill(swap.outName)}
          </div>
          <div style="text-align:center; color:var(--text-mute); font-size:16px;">&rarr;</div>
          <div>
            <div class="plan-role-label" style="font-size:9px; margin-bottom:5px; padding-bottom:4px; border-bottom:1px solid #1EFF0033; color:#1EFF00;">IN</div>
            ${swapPill(swap.inName)}
          </div>
          ${isOfficer ? `<div title="Remove swap" onclick="removePlannerSwap('${swap.id}')" style="cursor:pointer; color:var(--text-mute); font-size:16px; line-height:1; padding:2px 4px;">&times;</div>` : '<div></div>'}
        `;
        rowsWrap.appendChild(row);
      });
      card.appendChild(rowsWrap);
      listWrap.appendChild(card);
    });
    col.appendChild(listWrap);
  }

  if (isOfficer) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-secondary';
    addBtn.style.cssText = 'margin-top:10px; padding:6px 12px; font-size:12px; width:100%;';
    addBtn.textContent = '+ Add Swap';
    addBtn.onclick = () => openAddSwapForm(col, addBtn);
    col.appendChild(addBtn);
  }

  wrap.appendChild(col);
}

// prefillBoss + appendTarget let the "+" on an existing boss card add another
// swap for that same boss inline, without retyping the boss name or reopening
// the generic "+ Add Swap" flow.
function openAddSwapForm(col, addBtn, prefillBoss, appendTarget) {
  const existingForm = document.getElementById('planner-swap-form');
  if (existingForm) existingForm.remove();
  if (addBtn) addBtn.style.display = 'none';

  const currentRoster = getSwapRosterState();
  const outNames = [...currentRoster].sort((a,b) => a.localeCompare(b));
  const seenNames = new Set();
  const uniquePlayers = STATE.players.filter(p => {
    if (seenNames.has(p.name)) return false;
    seenNames.add(p.name);
    return true;
  });
  const inNames = uniquePlayers.map(p => p.name).filter(n => !currentRoster.has(n)).sort((a,b) => a.localeCompare(b));

  const form = document.createElement('div');
  form.id = 'planner-swap-form';
  form.style.cssText = 'margin-top:10px; background:var(--bg2); border:1px solid var(--border); border-radius:6px; padding:12px; display:flex; flex-direction:column; gap:8px;';

  let bossInput = null;
  if (!prefillBoss) {
    bossInput = document.createElement('input');
    bossInput.type = 'text';
    bossInput.id = 'swap-boss-input';
    bossInput.placeholder = 'Boss Name';
    bossInput.style.width = '100%';
    form.appendChild(bossInput);
  }

  const selectRow = document.createElement('div');
  selectRow.style.cssText = 'display:flex; gap:8px;';
  selectRow.innerHTML = `
    <select id="swap-out-select" style="flex:1;">
      <option value="">Out...</option>
      ${outNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}
    </select>
    <select id="swap-in-select" style="flex:1;">
      <option value="">In...</option>
      ${inNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}
    </select>
  `;
  form.appendChild(selectRow);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:8px; justify-content:flex-end;';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.style.cssText = 'padding:6px 12px; font-size:12px;';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => renderPlannerSwaps();
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn-primary';
  confirmBtn.style.cssText = 'padding:6px 12px; font-size:12px;';
  confirmBtn.textContent = 'Add';
  confirmBtn.onclick = () => addPlannerSwap(prefillBoss || null);
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(confirmBtn);
  form.appendChild(btnRow);

  (appendTarget || col).appendChild(form);
  (bossInput || document.getElementById('swap-out-select')).focus();
}

async function addPlannerSwap(prefillBoss) {
  const boss    = prefillBoss || document.getElementById('swap-boss-input')?.value.trim();
  const outName = document.getElementById('swap-out-select')?.value;
  const inName  = document.getElementById('swap-in-select')?.value;
  if (!boss)    { showToast('Enter a boss name', 'error'); return; }
  if (!outName) { showToast('Select who is sitting out', 'error'); return; }
  if (!inName)  { showToast('Select who is coming in', 'error'); return; }

  const swap = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), boss, outName, inName };
  STATE.plannerSwaps = [...(STATE.plannerSwaps || []), swap];
  renderPlannerSwaps();
  await saveSwapsToDB();
}

async function removePlannerSwap(id) {
  STATE.plannerSwaps = (STATE.plannerSwaps || []).filter(s => s.id !== id);
  renderPlannerSwaps();
  await saveSwapsToDB();
}

async function saveSwapsToDB() {
  if (!STATE.teamId || !STATE.plannerDate) return;
  try {
    const resp = await fetch('/api/plans?action=saveSwaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, raidDate: STATE.plannerDate, swaps: STATE.plannerSwaps }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to save swaps');
  } catch(e) {
    showToast('Failed to save swap: ' + e.message, 'error');
  }
}

function renderPlannerChecklist() {
  const checklist = document.getElementById('planner-checklist');
  if (!checklist) return;
  checklist.innerHTML = '';

  const roleGroups = [
    { keys: ['tank'],           label: 'TANKS',   color: '#C79C6E', flexKey: null },
    { keys: ['heal','healer'],  label: 'HEALERS', color: '#1EFF00', flexKey: null },
    { keys: ['melee'],          label: 'MELEE',   color: '#FF8000', flexKey: null },
    { keys: ['ranged'],         label: 'RANGED',  color: '#69CCF0', flexKey: null },
    { keys: [],                 label: 'FLEX TANKS',   color: '#C79C6E', flexKey: 'flex_tank',   isFlexGroup: true },
    { keys: [],                 label: 'FLEX HEALERS', color: '#1EFF00', flexKey: 'flex_heal',   isFlexGroup: true },
    { keys: [],                 label: 'FLEX MELEE',   color: '#FF8000', flexKey: 'flex_melee',  isFlexGroup: true },
    { keys: [],                 label: 'FLEX RANGED',  color: '#69CCF0', flexKey: 'flex_ranged', isFlexGroup: true },
  ];

  // Deduplicate STATE.players by name
  const seenCheckNames = new Set();
  const uniqueCheckPlayers = STATE.players.filter(p => {
    if (seenCheckNames.has(p.name)) return false;
    seenCheckNames.add(p.name);
    return true;
  });

  // Out/Unavailable — players whose claimed character is marked unavailable for the planned date
  const unavailableNames = getUnavailableNamesForDate(STATE.plannerDate);

  roleGroups.forEach(role => {
    let group;
    if (role.isFlexGroup) {
      group = uniqueCheckPlayers
        .filter(p => p[role.flexKey] && p.role !== (
          role.flexKey === 'flex_melee'  ? 'melee'  :
          role.flexKey === 'flex_ranged' ? 'ranged' :
          role.flexKey === 'flex_tank'   ? 'tank'   :
          role.flexKey === 'flex_heal'   ? 'heal'   : null
        ))
        .sort((a,b) => a.name.localeCompare(b.name));
    } else {
      group = uniqueCheckPlayers
        .filter(p => role.keys.includes(p.role))
        .sort((a,b) => a.name.localeCompare(b.name));
    }
    if (group.length === 0) return;

    const div = document.createElement('div');
    div.className = 'checklist-role-group';

    const header = document.createElement('div');
    header.className = 'checklist-role-header';
    header.style.borderLeftColor = role.color;
    const checkedCount = role.isFlexGroup
      ? group.filter(p => plannerSelected.has(p.name) && flexRoleSelected[p.name] === role.flexKey).length
      : group.filter(p => plannerSelected.has(p.name) && (flexRoleSelected[p.name] || 'primary') === 'primary').length;
    header.innerHTML = `${role.label} <span style="color:var(--gold); font-weight:700; margin-left:auto; font-size:12px; background:rgba(200,168,75,0.12); padding:2px 7px; border-radius:10px;">${checkedCount}/${group.length}</span>`;
    div.appendChild(header);

    const playersDiv = document.createElement('div');
    playersDiv.className = 'checklist-players';

    group.forEach(player => {
      const color      = CLASS_COLORS[player.class] || '#888';
      const slotType   = role.isFlexGroup ? role.flexKey : 'primary';
      const isSelected = plannerSelected.has(player.name);
      // A player is "taken elsewhere" if selected but in a different slot than this row
      const selectedSlot = flexRoleSelected[player.name] || 'primary';
      const takenElsewhere = isSelected && selectedSlot !== slotType;
      const checkedHere    = isSelected && selectedSlot === slotType;
      const isLocked = STATE.raidPlanPublished && STATE.raidPlanMode !== 'edit';
      const isUnavailable = unavailableNames.has(player.name);
      // Unavailable players can't be NEWLY selected — but if already checked here, still allow unchecking
      const blockedByUnavailable = isUnavailable && !checkedHere;
      // Disable this row if player is taken in the other slot, locked, or unavailable-and-not-already-checked
      const isDisabled = takenElsewhere || isLocked || blockedByUnavailable;

      const item = document.createElement('div');
      item.className = 'checklist-item' + (checkedHere ? ' checked' : '') + (isDisabled ? ' locked' : '');
      item.style.opacity = takenElsewhere ? '0.3' : (blockedByUnavailable ? '0.35' : (isLocked && !checkedHere ? '0.45' : '1'));
      item.style.cursor  = isDisabled ? 'default' : 'pointer';
      item.title = takenElsewhere
        ? `${player.name} is already selected as ${
            selectedSlot === 'flex_tank'   ? 'Flex Tank'   :
            selectedSlot === 'flex_heal'   ? 'Flex Healer' :
            selectedSlot === 'flex_melee'  ? 'Flex Melee'  :
            selectedSlot === 'flex_ranged' ? 'Flex Ranged' : 'primary role'
          }`
        : blockedByUnavailable
        ? `${player.name} marked themselves unavailable for this raid night`
        : '';
      const outTag = isUnavailable
        ? `<span title="Marked unavailable for this raid night" style="margin-left:auto; font-size:9px; color:#FF6666; text-transform:uppercase; letter-spacing:1px;">Out</span>`
        : '';
      item.innerHTML = `
        <div class="checklist-checkbox">${checkedHere ? '✓' : ''}</div>
        <div class="checklist-name" style="color:${takenElsewhere ? 'var(--text-mute)' : color};">${escapeHtml(player.name)}</div>
        ${joinOrderBadge(player)}${outTag}
      `;
      if (!isDisabled) item.onclick = () => togglePlannerPlayer(player.name, slotType);
      playersDiv.appendChild(item);
    });

    div.appendChild(playersDiv);
    checklist.appendChild(div);
  });
}

// Track which players were selected via flex slot
let flexRoleSelected = JSON.parse(localStorage.getItem('raidlead_flex_slots') || '{}');
// { playerName: 'tank' | 'heal' | 'primary' }

function saveFlexSlots() {
  localStorage.setItem('raidlead_flex_slots', JSON.stringify(flexRoleSelected));
}

function togglePlannerPlayer(name, slotType) {
  // Lock changes when published and not in edit mode
  if (STATE.raidPlanPublished && STATE.raidPlanMode !== 'edit') return;
  // slotType: 'primary' | 'flex_tank' | 'flex_heal'
  if (plannerSelected.has(name)) {
    // If clicking same slot type, deselect
    if (!slotType || flexRoleSelected[name] === slotType || !flexRoleSelected[name]) {
      plannerSelected.delete(name);
      delete flexRoleSelected[name];
    } else {
      // Switch slot type (e.g. selected as DPS, now clicking flex tank)
      flexRoleSelected[name] = slotType;
    }
  } else {
    plannerSelected.add(name);
    flexRoleSelected[name] = slotType || 'primary';
  }
  saveFlexSlots();
  savePlannerState(plannerSelected);
  renderPlannerChecklist();
  renderPlannerRoster();
}

function renderPlannerRoster() {
  // Deduplicate STATE.players by name before filtering
  const seenNames = new Set();
  const uniquePlayers = STATE.players.filter(p => {
    if (seenNames.has(p.name)) return false;
    seenNames.add(p.name);
    return true;
  });
  const selected = uniquePlayers.filter(p => plannerSelected.has(p.name));

  // Update counts — account for flex role assignments
  const effectiveRole = p => {
    const flex = flexRoleSelected[p.name];
    if (flex === 'flex_tank')   return 'tank';
    if (flex === 'flex_heal')   return 'heal';
    if (flex === 'flex_melee')  return 'melee';
    if (flex === 'flex_ranged') return 'ranged';
    return p.role;
  };
  const tanks   = selected.filter(p => effectiveRole(p) === 'tank');
  const healers = selected.filter(p => ['heal','healer'].includes(effectiveRole(p)));
  const dps     = selected.filter(p => ['melee','ranged','dps'].includes(effectiveRole(p)));
  const melee2  = selected.filter(p => effectiveRole(p) === 'melee');
  const ranged2 = selected.filter(p => effectiveRole(p) === 'ranged');
  document.getElementById('plan-total').textContent   = selected.length;
  document.getElementById('plan-tanks').textContent   = tanks.length;
  document.getElementById('plan-healers').textContent = healers.length;
  document.getElementById('plan-dps').textContent     = (melee2.length + ranged2.length);

  // Raid buffs for tonight, then raid utility
  const buffsEl = document.getElementById('plan-buffs');
  buffsEl.innerHTML = '';
  const planPill = b => {
    const pill = buffPill(b, selected);
    const card = document.createElement('div');
    card.title = b.providers.map(providerLabel).join(', ');
    card.style.cssText = `
      background: var(--bg2);
      border: 1px solid ${pill.covered ? pill.color + '66' : 'var(--border)'};
      border-radius: 6px;
      padding: 8px 10px;
      display: flex; align-items: center; gap: 8px;
      min-width: 130px;
    `;
    card.innerHTML = `
      <div class="buff-indicator ${pill.covered ? 'covered' : 'missing'}"></div>
      <div>
        <div style="font-size:12px; font-weight:700; color:${pill.covered ? pill.color : 'var(--text-mute)'};">${escapeHtml(pill.title)}</div>
        ${pill.sub ? `<div style="font-size:10px; color:${pill.covered ? pill.color : 'var(--text-mute)'}; letter-spacing:1px;">${escapeHtml(pill.sub)}</div>` : ''}
      </div>
    `;
    buffsEl.appendChild(card);
  };
  GAME.raidBuffs.forEach(planPill);
  if (GAME.raidUtility.length) {
    const label = document.createElement('div');
    label.className = 'plan-utility-label';
    label.textContent = 'Utility';
    buffsEl.appendChild(label);
    GAME.raidUtility.forEach(planPill);
  }

  // Roster columns
  const colsEl = document.getElementById('plan-roster-cols');
  colsEl.innerHTML = '';

  // Split by effective role — flex players appear under their assigned column, never twice
  const flexAsTank   = selected.filter(p => flexRoleSelected[p.name] === 'flex_tank'   && p.role !== 'tank');
  const flexAsHeal   = selected.filter(p => flexRoleSelected[p.name] === 'flex_heal'   && !['heal','healer'].includes(p.role));
  const flexAsMelee  = selected.filter(p => flexRoleSelected[p.name] === 'flex_melee'  && p.role !== 'melee');
  const flexAsRanged = selected.filter(p => flexRoleSelected[p.name] === 'flex_ranged' && p.role !== 'ranged');
  const flexed       = new Set([...flexAsTank, ...flexAsHeal, ...flexAsMelee, ...flexAsRanged].map(p => p.name));
  // Primary role columns exclude anyone assigned to a flex slot
  const pureTanks   = selected.filter(p => ['tank'].includes(p.role) && !flexed.has(p.name));
  const pureHealers = selected.filter(p => ['heal','healer'].includes(p.role) && !flexed.has(p.name));
  const pureMelee   = selected.filter(p => p.role === 'melee'  && !flexed.has(p.name));
  const pureRanged  = selected.filter(p => p.role === 'ranged' && !flexed.has(p.name));

  const roleGroups = [
    { label: 'TANKS',   players: [...pureTanks,   ...flexAsTank],   color: '#C79C6E' },
    { label: 'HEALERS', players: [...pureHealers, ...flexAsHeal],   color: '#1EFF00' },
    { label: 'MELEE',   players: [...pureMelee,   ...flexAsMelee],  color: '#FF8000' },
    { label: 'RANGED',  players: [...pureRanged,  ...flexAsRanged], color: '#69CCF0' },
  ];

  roleGroups.forEach(group => {
    const col = document.createElement('div');
    col.className = 'plan-role-col';
    // Always show the header, even if empty
    col.innerHTML = `
      <div class="plan-role-label" style="border-bottom: 1px solid ${group.color}33; color:${group.color};">
        ${group.label} <span style="color:${group.color}; opacity:0.7; font-weight:600; font-size:11px; margin-left:4px;">(${group.players.length})</span>
      </div>
    `;

    if (group.players.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px; color:var(--text-mute); padding:6px 2px; font-style:italic;';
      empty.textContent = 'None selected';
      col.appendChild(empty);
    } else {
      group.players.sort((a,b) => a.name.localeCompare(b.name)).forEach(p => {
        const color = CLASS_COLORS[p.class] || '#888';
        const pill  = document.createElement('div');
        pill.className = 'plan-player-pill';
        pill.style.background = color;
        pill.style.border = `1px solid ${color}`;
        const textColor = isLightColor(color) ? '#000000' : '#ffffff';
        pill.innerHTML = `<div class="class-dot" style="background:${textColor}22; border:1px solid ${textColor}44;"></div><span style="color:${textColor}; text-shadow: 0 1px 2px rgba(0,0,0,0.4);">${escapeHtml(p.name)}</span>${joinOrderBadge(p)}`;
        pill.title = 'Click to remove';
        pill.onclick = () => togglePlannerPlayer(p.name);
        col.appendChild(pill);
      });
    }
    colsEl.appendChild(col);
  });

  renderOutUnavailableSection();
  renderPlannerSwaps();
}

function enterEditMode() {
  STATE.raidPlanMode      = 'edit';
  STATE.raidPlanPublished = false;
  document.getElementById('planner-edit-banner').style.display = 'block';
  document.getElementById('planner-edit-btn').style.display    = 'none';
  document.getElementById('planner-publish-btn').style.display = 'block';
  document.getElementById('planner-import-btn').style.display  = 'inline-flex';
  document.getElementById('planner-clear-btn').style.display   = 'inline-flex';
  showToast('Edit mode active — changes are drafts until published', '');
}

function exitEditMode() {
  STATE.raidPlanMode = 'view';
  // Re-enable publish button in case it was disabled by an error
  const pubBtn = document.getElementById('planner-publish-btn');
  if (pubBtn) { pubBtn.disabled = false; pubBtn.textContent = '⬆ Publish'; }
  document.getElementById('planner-edit-banner').style.display = 'none';
  document.getElementById('planner-edit-btn').style.display    = 'block';
  document.getElementById('planner-publish-btn').style.display = 'none';
  document.getElementById('planner-import-btn').style.display  = 'none';
  document.getElementById('planner-clear-btn').style.display   = 'none';
  // Reload from DB to discard unsaved changes -- must pass the date being edited,
  // otherwise this falls back to "most recently published plan" (any date), which
  // could silently jump the planner to a completely different date than the one
  // you were just editing.
  fetchRaidPlanFromDB(STATE.plannerDate).then(planData => {
    if (planData && planData.plan) applyPlanData(planData);
  });
}

async function publishRaidPlan() {
  const btn = document.getElementById('planner-publish-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Publishing...';
  try {
    await saveRaidPlanToDB(true);
    STATE.raidPlanMode = 'view';
    STATE.raidPlanPublished = true;
    document.getElementById('planner-edit-banner').style.display = 'none';
    document.getElementById('planner-edit-btn').style.display    = 'block';
    document.getElementById('planner-publish-btn').style.display = 'none';
    document.getElementById('planner-import-btn').style.display  = 'none';
    document.getElementById('planner-clear-btn').style.display   = 'none';
    document.getElementById('plan-status-badge').textContent     = 'PUBLISHED';
    // Clear localStorage draft so other devices always read from DB
    try { localStorage.removeItem(PLANNER_KEY); } catch(e) {}
    document.getElementById('plan-status-badge').style.background = 'rgba(30,255,0,0.1)';
    document.getElementById('plan-status-badge').style.color     = '#1EFF00';
    document.getElementById('plan-status-badge').style.borderColor = 'rgba(30,255,0,0.3)';
    showToast('Raid plan published! Members can now see it.', 'success');
  } catch(e) {
    showToast('Error publishing: ' + e.message, 'error');
    // Restore edit mode UI so user can try again
    btn.disabled = false;
    btn.textContent = '⬆ Publish';
    document.getElementById('planner-edit-banner').style.display = 'block';
    document.getElementById('planner-edit-btn').style.display    = 'none';
    document.getElementById('planner-publish-btn').style.display = 'block';
    document.getElementById('planner-import-btn').style.display  = 'inline-flex';
    document.getElementById('planner-clear-btn').style.display   = 'inline-flex';
    return;
  }
  btn.disabled = false;
  btn.textContent = '⬆ Publish';
}

function clearRaidRoster() {
  plannerSelected = new Set();
  savePlannerState(plannerSelected);
  renderPlannerChecklist();
  renderPlannerRoster();
  showToast('Raid roster cleared.', '');
}

// Pulls the character selections from the most recent saved raid plan before the
// current planner date into the in-memory selection -- does NOT save or publish,
// so it's just a starting point the officer can tweak before publishing themselves.
async function importLastRaidRoster() {
  if (!STATE.plannerDate || !STATE.teamId) return;
  const btn = document.getElementById('planner-import-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading...'; }
  try {
    const resp = await fetch(`/api/plans?action=getPrevious&teamId=${STATE.teamId}&beforeDate=${STATE.plannerDate}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load previous roster');
    if (!data.plan) {
      showToast('No previous raid roster found.', '');
      return;
    }

    const members = data.plan.raid_plan_members || [];
    const unavailableNames = getUnavailableNamesForDate(STATE.plannerDate);
    const names = new Set();
    const flex  = {};
    let skipped = 0;
    members.forEach(m => {
      const name = m.characters?.name;
      if (!name) return;
      if (unavailableNames.has(name)) { skipped++; return; }
      names.add(name);
      if (m.assigned_role && m.assigned_role !== 'primary') flex[name] = m.assigned_role;
    });

    plannerSelected  = names;
    flexRoleSelected = flex;
    saveFlexSlots();
    renderPlannerChecklist();
    renderPlannerRoster();

    const dateLabel = data.plan.raid_date
      ? new Date(data.plan.raid_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'the last raid night';
    let msg = `Imported roster from ${dateLabel} (${names.size} players).`;
    if (skipped > 0) msg += ` Skipped ${skipped} marked unavailable for this date.`;
    showToast(msg, 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⤓ Use Last Roster'; }
  }
}


// ─────────────────────────────────────────────
//  AUTH STATE
// ─────────────────────────────────────────────
const AUTH = {
  session: null,
  account: null,
};

async function signOut() {
  // Expire the HttpOnly session cookie server-side
  try { await fetch('/api/auth?action=logout', { method: 'POST' }); } catch(e) {}
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem('raidlead_display');
  AUTH.session = null;
  AUTH.account = null;
  STATE.config  = null;
  STATE.players = [];
  STATE.scores  = [];
  showLoginScreen();
}

function toggleAccountMenu() {
  document.getElementById('account-dropdown').classList.toggle('open');
}

// ── Mobile hamburger nav -- built by cloning the real .nav-btn tabs so it
// can never list a tab that doesn't exist (or miss one that's been added). ──
function initMobileNav() {
  const dropdown = document.getElementById('mobile-nav-dropdown');
  if (!dropdown) return;
  dropdown.innerHTML = '';
  document.querySelectorAll('#main-nav > .nav-btn').forEach(btn => {
    const item = document.createElement('button');
    item.className = 'dropdown-item mobile-nav-item' + (btn.classList.contains('active') ? ' active' : '')
      + (btn.classList.contains('role-hidden') ? ' role-hidden' : ''); // officer-only tabs stay hidden until applyRolePermissions says otherwise
    item.textContent = btn.textContent;
    item.dataset.tab = btn.dataset.tab;
    item.onclick = () => {
      showTab(btn.dataset.tab);
      dropdown.classList.remove('open');
    };
    dropdown.appendChild(item);
  });
}

function toggleMobileNav() {
  document.getElementById('mobile-nav-dropdown')?.classList.toggle('open');
}

// Keeps the hamburger's current-tab label and the dropdown's highlighted
// item in sync with whichever tab is active, regardless of whether it was
// switched from the desktop row or the mobile flyout.
function updateMobileNavActive(name) {
  const navBtn = document.querySelector('.nav-btn[data-tab="' + name + '"]');
  const currentEl = document.getElementById('mobile-nav-current');
  if (currentEl && navBtn) currentEl.textContent = navBtn.textContent;
  document.querySelectorAll('#mobile-nav-dropdown .mobile-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.tab === name);
  });
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('account-menu');
  if (menu && !menu.contains(e.target)) {
    const dd = document.getElementById('account-dropdown');
    if (dd) dd.classList.remove('open');
  }
  const teamMenuWrap = document.getElementById('guild-badge-wrap');
  if (teamMenuWrap && !teamMenuWrap.contains(e.target)) {
    document.getElementById('team-menu')?.classList.remove('open');
  }
  const mobileNav = document.getElementById('mobile-nav-menu');
  if (mobileNav && !mobileNav.contains(e.target)) {
    document.getElementById('mobile-nav-dropdown')?.classList.remove('open');
  }
});

// Hides the boot loading screen -- called first thing by every function
// below that shows a real screen, so it never lingers once we know what to
// actually display. Idempotent (safe to call repeatedly / after it's
// already hidden), and does nothing on tab switches after boot since the
// element is gone from the flow by then.
function hideBootLoader() {
  const el = document.getElementById('boot-loading-screen');
  if (el) el.style.display = 'none';
}

function showLoginScreen() {
  hideBootLoader();
  document.getElementById('login-screen').style.display       = 'flex';
  document.getElementById('setup-screen').style.display       = 'none';
  document.getElementById('guild-setup-screen').style.display = 'none';
  document.getElementById('landing-choice-screen').style.display = 'none';
  document.getElementById('join-guild-screen').style.display  = 'none';
  document.getElementById('dashboard').style.display          = 'none';
  document.getElementById('main-nav').style.display           = 'none';
  document.getElementById('guild-badge').style.display        = 'none';
  const _shareBtnSetup = document.getElementById('share-btn');
  if (_shareBtnSetup) _shareBtnSetup.style.display = 'none';
  document.getElementById('account-menu').style.display       = 'none';
}

function showGuildSetup() {
  hideBootLoader();
  const gameSel = document.getElementById('gs-game');
  if (gameSel && !gameSel.options.length) {
    gameSel.innerHTML = GAMES_API.GAME_ORDER.map(id => GAMES_API.GAMES[id])
      .map(g => `<option value="${g.id}">${escapeHtml(g.label)}${g.beta ? ' (launches Nov 4)' : ''}</option>`).join('');
  }
  document.getElementById('login-screen').style.display       = 'none';
  document.getElementById('setup-screen').style.display       = 'none';
  document.getElementById('guild-setup-screen').style.display = 'flex';
  document.getElementById('landing-choice-screen').style.display = 'none';
  document.getElementById('join-guild-screen').style.display  = 'none';
  document.getElementById('dashboard').style.display          = 'none';
  document.getElementById('main-nav').style.display           = 'none';
  document.getElementById('guild-badge').style.display        = 'none';
  const _shareBtnSetup = document.getElementById('share-btn');
  if (_shareBtnSetup) _shareBtnSetup.style.display = 'none';
  document.getElementById('account-menu').style.display       = 'flex';
  if (AUTH.session && AUTH.session.battletag) {
    document.getElementById('account-battletag').textContent  = AUTH.session.battletag;
    document.getElementById('dropdown-battletag').textContent = AUTH.session.battletag;
  }
}

function showLandingChoice() {
  hideBootLoader();
  document.getElementById('login-screen').style.display       = 'none';
  document.getElementById('setup-screen').style.display       = 'none';
  document.getElementById('guild-setup-screen').style.display = 'none';
  document.getElementById('join-guild-screen').style.display  = 'none';
  document.getElementById('dashboard').style.display          = 'none';
  document.getElementById('main-nav').style.display           = 'none';
  document.getElementById('guild-badge').style.display        = 'none';
  const _shareBtnSetup = document.getElementById('share-btn');
  if (_shareBtnSetup) _shareBtnSetup.style.display = 'none';
  document.getElementById('account-menu').style.display       = 'flex';
  document.getElementById('landing-choice-screen').style.display = 'flex';
  // Already on a team (came here to start or join another guild): a way back.
  const back = document.getElementById('landing-back-btn');
  if (back) {
    back.style.display = isOnTeam() ? '' : 'none';
    back.textContent = isOnTeam() ? `← Back to ${currentTeamLabel()}` : '';
  }
  if (AUTH.session && AUTH.session.battletag) {
    document.getElementById('account-battletag').textContent  = AUTH.session.battletag;
    document.getElementById('dropdown-battletag').textContent = AUTH.session.battletag;
  }
}

function showJoinGuildScreen() {
  hideBootLoader();
  document.getElementById('login-screen').style.display          = 'none';
  document.getElementById('setup-screen').style.display          = 'none';
  document.getElementById('guild-setup-screen').style.display    = 'none';
  document.getElementById('landing-choice-screen').style.display = 'none';
  document.getElementById('dashboard').style.display             = 'none';
  document.getElementById('main-nav').style.display              = 'none';
  document.getElementById('guild-badge').style.display           = 'none';
  const _shareBtnSetup = document.getElementById('share-btn');
  if (_shareBtnSetup) _shareBtnSetup.style.display = 'none';
  document.getElementById('account-menu').style.display       = 'flex';
  document.getElementById('join-guild-screen').style.display  = 'flex';
  document.getElementById('jg-code-status').textContent = '';
  document.getElementById('jg-code-status').className   = 'status-msg';
}

// Completes joining a guild by join code — hydrates STATE from the DB and
// routes to either the claim gate or the dashboard.
async function completeGuildJoin(joinCode) {
  const joinResp = await fetch('/api/auth?action=join-guild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ joinCode }),
  });
  const joinData = await joinResp.json();
  if (!joinResp.ok) throw new Error(joinData.error || 'Failed to join guild');

  if (isOnTeam() && joinData.teamId && joinData.teamId !== STATE.teamId) {
    await switchActiveTeam(joinData.teamId);
    showToast(joinWelcomeMessage(), 'success');
    return;
  }

  const freshData = await fetchGuildFromDB(joinData.teamId);
  if (!freshData || !freshData.team) throw new Error('Joined, but could not load team data. Try refreshing the page.');
  applyGuildData(freshData);
  await loadRosterFromDB();

  showDashboard(freshData);
  showToast(joinWelcomeMessage(), 'success');
  checkAndAdvanceSeason();
}

async function joinGuildByCode() {
  let raw = document.getElementById('jg-code').value.trim();
  const statusEl = document.getElementById('jg-code-status');
  if (!raw) {
    statusEl.textContent = 'Please enter a join code or invite link.';
    statusEl.className   = 'status-msg error';
    return;
  }
  statusEl.textContent = 'Joining...';
  statusEl.className   = 'status-msg loading';
  try {
    // Accept a full invite link too — pull the code out of the URL if so
    try {
      const url = new URL(raw);
      const inviteParam = url.searchParams.get('invite');
      if (inviteParam) raw = inviteParam;
    } catch(e) { /* not a URL — treat input as the raw code */ }

    // Old invite links carried a long, self-contained base64 blob instead of
    // a real join code -- no longer accepted (see api/auth.js's join-guild),
    // so this explains rather than sending an inevitably-invalid code.
    if (raw.length > 10) {
      throw new Error("That's an outdated invite link — ask an officer for a new one.");
    }

    await completeGuildJoin(raw);
  } catch(e) {
    statusEl.textContent = 'Error: ' + e.message;
    statusEl.className   = 'status-msg error';
  }
}

function toggleTeamName(radio) {
  const teamRow    = document.getElementById('team-name-row');
  const teamNote   = document.getElementById('team-name-note');
  const wclTeamRow = document.getElementById('gs-wcl-team-row');
  if (radio.value === 'yes') {
    teamRow.style.display  = 'flex';
    teamNote.style.display = 'none';
    if (wclTeamRow) wclTeamRow.style.display = 'block';
  } else {
    teamRow.style.display  = 'none';
    teamNote.style.display = 'inline';
    if (wclTeamRow) wclTeamRow.style.display = 'none';
  }
}

async function createGuild(confirmNewTeam) {
  const game       = document.getElementById('gs-game')?.value || 'retail';
  const guild      = document.getElementById('gs-guild').value.trim();
  const server     = document.getElementById('gs-server').value.trim();
  const region     = document.getElementById('gs-region').value;
  const multiTeam = document.querySelector('input[name="multi-team"]:checked')?.value === 'yes';
  const teamNameEl = document.getElementById('gs-team');
  const teamName   = multiTeam && teamNameEl ? teamNameEl.value.trim() || 'Main Team' : 'Main Team';
  const wclTeamId  = document.getElementById('gs-wcl-team').value.trim() || null;
  const raidDays   = getRaidDaysFrom('gs-raid-days');

  if (!guild || !server) {
    document.getElementById('gs-status').textContent = 'Please fill in Guild Name and Server.';
    document.getElementById('gs-status').className   = 'status-msg error';
    return;
  }

  document.getElementById('gs-status').textContent = 'Creating guild...';
  document.getElementById('gs-status').className   = 'status-msg loading';

  try {
    const resp = await fetch('/api/guild?action=create', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        },
      body: JSON.stringify({ guild, server, region, game, difficulty: GAMES_API.gameFor(game).defaultDifficulty, teamName, wclTeamId, raidDays, confirmNewTeam: !!confirmNewTeam }),
    });

    let data = {};
    const text = await resp.text();
    try { data = JSON.parse(text); } catch(e) { throw new Error('Server returned invalid response: ' + text.slice(0, 100)); }

    // A guild with this name+server already exists -- ask whether this is a
    // brand-new second team, or whether they meant to join the existing one(s).
    if (resp.status === 409 && data.error === 'GUILD_EXISTS') {
      const teamList = data.teamNames?.length ? data.teamNames.join(', ') : 'an existing team';
      const wantsNewTeam = confirm(
        `${data.message}\n\nClick OK to create a NEW team under this guild (you'll be its owner).\nClick Cancel if you meant to join ${teamList} instead -- ask an officer there for a join code.`
      );
      if (wantsNewTeam) return createGuild(true);
      document.getElementById('gs-status').textContent = 'Ask an officer of the existing team for a join code, then use "Join Guild" instead.';
      document.getElementById('gs-status').className   = 'status-msg';
      return;
    }

    if (!resp.ok) throw new Error(data.error || 'Failed to create guild');

    if (isOnTeam() && data.team?.id && data.team.id !== STATE.teamId) {
      await switchActiveTeam(data.team.id);
      return;
    }

    // Populate full STATE (including the teams list) now that the team row exists
    const freshGuildData = await fetchGuildFromDB(data.team?.id);
    if (!freshGuildData || !freshGuildData.team) throw new Error('Created, but could not load team data. Try refreshing the page.');
    applyGuildData(freshGuildData);

    await loadRosterFromDB();

    showDashboard(freshGuildData);
    checkAndAdvanceSeason();

  } catch(e) {
    document.getElementById('gs-status').textContent = 'Error: ' + e.message;
    document.getElementById('gs-status').className   = 'status-msg error';
  }
}

// ─────────────────────────────────────────────
//  INVITE & ROLE MANAGEMENT
// ─────────────────────────────────────────────

// The invite link is just the team's real join code in URL form -- both are
// backed by the same server-verified teams.join_code, so there's exactly one
// mechanism to join by (see api/auth.js's join-guild), not a second,
// unverified one built from guild name/server. A team with no code yet
// (created before this existed) gets one generated automatically here.
async function ensureJoinCode() {
  if (STATE.joinCode) return STATE.joinCode;
  const resp = await fetch('/api/guild?action=generateJoinCode', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: STATE.teamId }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Failed to generate a join code');
  STATE.joinCode = data.joinCode;
  return STATE.joinCode;
}

async function showInviteModal() {
  const linkInput = document.getElementById('invite-link-input');
  linkInput.value = 'Generating...';
  document.getElementById('invite-copy-msg').style.display = 'none';
  document.getElementById('invite-modal').classList.add('open');
  try {
    const code    = await ensureJoinCode();
    const baseUrl = window.location.origin + window.location.pathname;
    linkInput.value = `${baseUrl}?invite=${code}`;
  } catch (e) {
    linkInput.value = 'Could not generate link';
  }
  renderJoinCodeUI();
}

function closeInviteModal() {
  document.getElementById('invite-modal').classList.remove('open');
}

function copyInviteLink() {
  const input = document.getElementById('invite-link-input');
  navigator.clipboard.writeText(input.value).then(() => {
    const msg = document.getElementById('invite-copy-msg');
    msg.style.display = 'block';
    setTimeout(() => msg.style.display = 'none', 3000);
  }).catch(() => {
    input.select();
    document.execCommand('copy');
  });
}

function renderJoinCodeUI() {
  const display = document.getElementById('join-code-display');
  const genBtn  = document.getElementById('join-code-generate-btn');
  const msg     = document.getElementById('join-code-msg');
  msg.style.display = 'none';
  if (STATE.joinCode) {
    document.getElementById('join-code-input').value = STATE.joinCode;
    display.style.display = 'flex';
    genBtn.textContent = 'Regenerate Join Code';
  } else {
    display.style.display = 'none';
    genBtn.textContent = 'Generate Join Code';
  }
}

async function generateJoinCode() {
  const msg = document.getElementById('join-code-msg');
  const hadCode = !!STATE.joinCode;
  if (hadCode && !confirm('This will invalidate the current join code. Continue?')) return;

  msg.style.display = 'block';
  msg.style.color   = 'var(--text-mute)';
  msg.textContent   = 'Generating...';
  try {
    const resp = await fetch('/api/guild?action=generateJoinCode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamId: STATE.teamId }) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to generate join code');
    STATE.joinCode = data.joinCode;
    renderJoinCodeUI();
    msg.style.display = 'block';
    msg.style.color   = '#1EFF00';
    msg.textContent   = 'New join code generated!';
    setTimeout(() => { msg.style.display = 'none'; }, 3000);
  } catch(e) {
    msg.style.color = '#ff6b6b';
    msg.textContent = 'Error: ' + e.message;
  }
}

function copyJoinCode() {
  const input = document.getElementById('join-code-input');
  navigator.clipboard.writeText(input.value).then(() => {
    const msg = document.getElementById('join-code-msg');
    msg.style.display = 'block';
    msg.style.color   = '#1EFF00';
    msg.textContent   = '✓ Copied to clipboard!';
    setTimeout(() => { msg.style.display = 'none'; }, 3000);
  }).catch(() => {
    input.select();
    document.execCommand('copy');
  });
}

function toggleSettingsTeam(radio) {
  const teamRow    = document.getElementById('settings-team-row');
  const teamNote   = document.getElementById('settings-team-note');
  const wclTeamRow = document.getElementById('settings-wcl-team-row');
  if (radio.value === 'yes') {
    teamRow.style.display  = 'flex';
    teamNote.style.display = 'none';
    if (wclTeamRow) wclTeamRow.style.display = 'block';
  } else {
    teamRow.style.display  = 'none';
    teamNote.style.display = 'inline';
    if (wclTeamRow) wclTeamRow.style.display = 'none';
  }
}

// Handle invite link on page load -- the ?invite= value is just the team's
// join code (see showInviteModal/ensureJoinCode), stashed until login
// finishes since a brand-new visitor hits Battle.net's OAuth redirect first.
function checkInviteParam() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  if (!invite) return false;
  window.history.replaceState({}, '', '/');

  // Old invite links carried a self-contained (unsigned) base64 blob of
  // guild info instead of a real join code -- no longer accepted (see
  // api/auth.js's join-guild), so this explains rather than silently
  // failing on an invite that will just never resolve to anything.
  if (invite.length > 10) {
    showToast('This invite link is outdated -- ask an officer for a new one.', 'error');
    return false;
  }

  localStorage.setItem('raidlead_pending_invite', invite.toUpperCase());
  return true;
}

// ─────────────────────────────────────────────
//  MEMBERS MANAGEMENT
// ─────────────────────────────────────────────
let CURRENT_PROFILE_PLAYER = null;
let ORIGINAL_DISPLAY_NAME = '';
let CURRENT_MEMBERS = [];

function updateDisplayNameSaveState() {
  const input = document.getElementById('display-name-input');
  const btn = document.getElementById('display-name-save-btn');
  if (!input || !btn) return;
  btn.disabled = input.value.trim() === ORIGINAL_DISPLAY_NAME;
}

function showMembersModal() {
  document.getElementById('members-modal').classList.add('open');
  document.getElementById('members-list').innerHTML = '<div style="color:var(--text-mute); font-size:13px; padding:16px 0;">Loading members...</div>';

  const isOfficer = ['owner', 'officer'].includes(STATE.myRole);
  const title = document.getElementById('members-modal-title');
  const subtitle = document.getElementById('members-modal-subtitle');
  if (title) title.textContent = isOfficer ? 'Guild Members' : 'My Profile';
  if (subtitle) subtitle.textContent = isOfficer ? 'Manage roles and character claims' : 'Manage your display name and character claim';

  // Show/hide officer section based on role
  const officerSection = document.getElementById('officer-members-section');
  if (officerSection) officerSection.style.display = isOfficer ? 'block' : 'none';

  // Pre-fill display name
  const displayInput = document.getElementById('display-name-input');
  if (displayInput && AUTH.session?.displayName) {
    displayInput.value = AUTH.session.displayName;
  }

  loadConnectedDevices();

  fetchMembersFromDB().then(data => {
    const members = data?.members || (Array.isArray(data) ? data : []);
    CURRENT_MEMBERS = members;
    if (data?.myRole) {
      localStorage.setItem('raidlead_my_role', data.myRole);
      applyRolePermissions(data.myRole);
    }
    const self = members.find(m => m.account_id === AUTH.session?.id);
    const acct = Array.isArray(self?.accounts) ? self.accounts[0] : self?.accounts;
    ORIGINAL_DISPLAY_NAME = (acct?.display_name || AUTH.session?.displayName || '').trim();
    if (displayInput) displayInput.value = ORIGINAL_DISPLAY_NAME;
    updateDisplayNameSaveState();

    // Always render claim section for all members
    renderMemberClaimSection(members);
    renderDiscordLinkSection(acct?.discord_id || null);

    // Only render full member list for officers
    if (isOfficer) {
      renderMembersListFromDB(members);
      renderUnclaimedListFromDB(members);
    }
  });
}

// Shows every character this account has claimed on the team (a Main and
// any Alt(s)) with a release button each, plus a persistent "claim another"
// button -- claiming is additive (see api/members.js's claimCharacter),
// not a single replaceable slot.
// A person's characters: Main first, then Alt(s) by name.
function mainsFirst(chars) {
  const isMain = c => (c.rank || 'Main') === 'Main';
  return [...(chars || [])].sort((a, b) => (isMain(b) - isMain(a)) || String(a.name).localeCompare(String(b.name)));
}

function renderMemberClaimSection(members) {
  const claimedEl = document.getElementById('member-claimed-char');
  const pickerEl  = document.getElementById('member-claim-picker');
  if (!claimedEl || !pickerEl) return;

  const me = (members || []).find(m => m.account_id === AUTH.session?.id);
  const chars = mainsFirst(Array.isArray(me?.characters) ? me.characters : (me?.characters ? [me.characters] : []));

  if (chars.length === 0) {
    claimedEl.textContent = 'No character connected yet. Your characters connect automatically once they\'re on the roster (Sync from Battle.net if one is missing), or claim one below.';
  } else {
    claimedEl.innerHTML = chars.map(c => {
      const color = CLASS_COLORS[c.class] || '#888';
      const rankBadge = c.rank ? `<span style="color:var(--text-mute); font-size:11px; text-transform:uppercase; letter-spacing:1px;">${escapeHtml(c.rank)}</span>` : '';
      return `<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
        <span style="color:${color}; font-weight:700; font-size:16px;">${escapeHtml(c.name)}</span>
        <span style="color:var(--text-mute); font-size:12px;">${escapeHtml(c.class)} · ${escapeHtml(c.primary_role)}</span>
        ${rankBadge}
        ${c.claim_verified ? '<span class="bnet-verified" title="Confirmed by your Battle.net account">✓ Battle.net</span>' : ''}
        <button onclick="releaseCharacterClaim('${escapeHtml(c.name)}')" title="Release this character" style="background:none; border:none; color:var(--text-mute); cursor:pointer; font-size:14px; line-height:1; padding:0 2px;">✕</button>
      </div>`;
    }).join('');
  }

  pickerEl.innerHTML = `<button class="btn-secondary" style="font-size:12px; padding:6px 12px;" title="Refresh your characters from your Battle.net account" onclick="syncFromBattleNet()">↻ Sync from Battle.net</button>
    <button class="btn-secondary" style="font-size:12px; padding:6px 12px;" onclick="showClaimCharacter('${AUTH.session?.id}')">+ Claim ${chars.length ? 'Another ' : 'a '}Character</button>`;
}

async function releaseCharacterClaim(characterName) {
  if (!confirm(`Release ${characterName}? You can claim it again later if needed.`)) return;
  try {
    const resp = await fetch('/api/members?action=unclaimCharacter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterName, teamId: STATE.teamId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to release character');
    showToast(`${characterName} released.`, 'success');
    fetchMembersFromDB().then(data => {
      const members = data?.members || [];
      CURRENT_MEMBERS = members;
      renderMemberClaimSection(members);
      if (['owner','officer'].includes(STATE.myRole)) {
        renderMembersListFromDB(members);
        renderUnclaimedListFromDB(members);
      }
    });
    // My own claimed-characters list changed -- refresh STATE so attendance/
    // the claim gate reflect it without needing a full page reload.
    const guildData = await fetchGuildFromDB(STATE.teamId);
    if (guildData) {
      STATE.claimedCharacters = mainsFirst(guildData.claimedCharacters);
      STATE.claimedCharacter  = STATE.claimedCharacters[0]?.name || guildData.claimedCharacter || null;
      renderAttendanceCharacterPicker();
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

function renderDiscordLinkSection(discordId) {
  const statusEl = document.getElementById('discord-link-status');
  const btn      = document.getElementById('discord-link-btn');
  const codeDisplay = document.getElementById('discord-link-code-display');
  if (!statusEl || !btn) return;
  codeDisplay.style.display = 'none';
  if (discordId) {
    statusEl.innerHTML = '<span style="color:#5865F2;">🔗 Linked</span>';
    btn.textContent = 'Re-link Discord';
  } else {
    statusEl.textContent = 'Not linked yet. Link your Discord so you can use /attendance and /link in your server.';
    btn.textContent = 'Link Discord';
  }
}

async function startDiscordLink() {
  const btn = document.getElementById('discord-link-btn');
  const codeDisplay = document.getElementById('discord-link-code-display');
  const codeEl = document.getElementById('discord-link-code');
  btn.disabled = true;
  try {
    const resp = await fetch('/api/members?action=generateDiscordLinkCode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to generate code');
    codeEl.textContent = data.code;
    codeDisplay.style.display = 'flex';
    btn.textContent = 'Generate New Code';
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function closeMembersModal() {
  document.getElementById('members-modal').classList.remove('open');
}

function renderMembersListFromDB(members) {
  const el = document.getElementById('members-list');
  if (!members || members.length === 0) {
    el.innerHTML = '<div style="color:var(--text-mute); font-size:13px; padding:8px 0;">No members have signed in yet. Share the invite link to get started.</div>';
    return;
  }

  const isOfficer = ['owner','officer'].includes(STATE.myRole);

  el.innerHTML = members.map(m => {
    // accounts may be an object or array depending on Supabase join
    const acct = Array.isArray(m.accounts) ? m.accounts[0] : m.accounts;
    const bt          = acct?.battletag || 'Unknown';
    const displayName = acct?.display_name || null;
    // characters may also be array -- a member can claim more than one (Main + Alt(s))
    const chars = mainsFirst(Array.isArray(m.characters) ? m.characters : (m.characters ? [m.characters] : []));
    const charNames = chars.map(c => c.name).filter(Boolean);
    const charLabels = chars.filter(c => c.name).map(c => escapeHtml(c.name) + (c.claim_verified ? ' <span class="bnet-verified" title="Confirmed by their Battle.net account">✓</span>' : ''));
    const accountId = m.account_id;
    const isSelf = AUTH.session?.id === accountId;
    const discordId = acct?.discord_id || null;

    return `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:var(--bg3); border:1px solid var(--border); border-radius:6px; margin-bottom:8px;">
      <div>
        <div style="font-size:14px; font-weight:700;">
          <span style="color:${displayName ? 'var(--text)' : 'var(--gold)'};">${escapeHtml(displayName || bt)}</span>
          ${isSelf ? '<span style="font-size:10px; color:var(--text-mute);"> · you</span>' : ''}
        </div>
        <div style="font-size:12px; color:var(--text-mute); margin-top:2px;">
          ${charNames.length
            ? `<span style="color:var(--text-dim);">Character${charNames.length > 1 ? 's' : ''}: <strong>${charLabels.join(', ')}</strong></span>`
            : `<span style="color:#ff6b6b;">No character claimed</span>`
          }
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        ${isSelf ? `<button onclick="showClaimCharacter('${accountId}')" class="btn-secondary" style="padding:4px 10px; font-size:12px;">+ Claim ${charNames.length ? 'Another' : 'Character'}</button>` : ''}
        ${isOfficer && !isSelf ? `
          <div style="display:flex; align-items:center; gap:6px;">
            <button onclick="promptSetMemberDiscordId('${accountId}', ${discordId ? `'${discordId}'` : 'null'})" class="btn-secondary" style="padding:4px 10px; font-size:12px; color:${discordId ? '#5865F2' : 'var(--text-mute)'};" title="${discordId ? 'Discord linked — click to change' : 'Click to link this member on Discord'}">${discordId ? '🔗 Discord' : 'Discord: —'}</button>
            <button onclick="showClaimCharacter('${accountId}')" class="btn-secondary" style="padding:4px 10px; font-size:12px;" title="Assign a character to this member">+ Assign</button>
            ${m.role === 'owner'
              ? `<span style="font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:var(--gold);" title="Hand the team to someone else from Team Management > Roles">Owner</span>`
              : `<select onchange="updateRoleFromDB('${accountId}', this.value)"
                  style="background:var(--bg2); border:1px solid var(--border); border-radius:4px; color:var(--text); font-family:'Rajdhani',sans-serif; font-size:13px; padding:4px 8px; cursor:pointer;">
                  <option value="viewer"  ${m.role==='viewer'  ?'selected':''}>Viewer</option>
                  <option value="member"  ${m.role==='member'  ?'selected':''}>Member</option>
                  <option value="officer" ${m.role==='officer'?'selected':''}>Officer</option>
                </select>`
            }
            ${(isOfficer && m.role !== 'owner') ? `<button onclick="removeMember('${accountId}')" style="background:rgba(196,30,58,0.1); border:1px solid rgba(196,30,58,0.3); border-radius:4px; color:#ff6b6b; font-family:'Rajdhani',sans-serif; font-size:12px; padding:4px 8px; cursor:pointer;">✕</button>` : ''}
          </div>
        ` : `<span style="font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:var(--text-mute);">${m.role}</span>`}
      </div>
    </div>`;
  }).join('');
}

function renderUnclaimedListFromDB(members) {
  const el = document.getElementById('unclaimed-list');
  const claimedChars = members
    .flatMap(m => Array.isArray(m.characters) ? m.characters : (m.characters ? [m.characters] : []))
    .map(c => c.name?.toLowerCase())
    .filter(Boolean);

  const unclaimed = STATE.players.filter(p => !claimedChars.includes(p.name.toLowerCase()));

  if (unclaimed.length === 0) {
    el.innerHTML = '<div style="color:var(--text-mute); font-size:13px;">All characters have been claimed!</div>';
    return;
  }

  el.innerHTML = unclaimed.map(p => {
    const color = CLASS_COLORS[p.class] || '#888';
    return `<span style="font-size:13px; font-weight:600; color:${color}; padding:4px 10px; background:${color}15; border:1px solid ${color}33; border-radius:4px;">${escapeHtml(p.name)}</span>`;
  }).join('');
}

async function removeMember(accountId) {
  if (!confirm('Remove this member from the guild?')) return;
  try {
    const resp = await fetch('/api/members?action=removeMember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, targetAccountId: accountId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to remove member');
    showToast('Member removed', 'success');
    showMembersModal(); // refresh
  } catch(e) { showToast('Error removing member: ' + e.message, 'error'); }
}

async function updateRoleFromDB(accountId, role) {
  try {
    await updateMemberInDB(accountId, role, null, STATE.teamId);
    showToast('Role updated!', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function promptSetMemberDiscordId(accountId, currentDiscordId) {
  const input = prompt(
    'Paste this member\'s Discord User ID (enable Developer Mode in Discord, right-click their name, "Copy User ID"). Leave blank to unlink.',
    currentDiscordId || ''
  );
  if (input === null) return; // cancelled
  try {
    const resp = await fetch('/api/members?action=setMemberDiscordId', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, targetAccountId: accountId, discordId: input.trim() }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to save');
    showToast(input.trim() ? 'Discord linked!' : 'Discord unlinked', 'success');
    showMembersModal(); // refresh
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

let claimingAccountId = null;

function showClaimCharacter(accountId) {
  claimingAccountId = accountId;
  // Show a mini picker of unclaimed characters
  const claimedChars = CURRENT_MEMBERS
    .flatMap(m => Array.isArray(m.characters) ? m.characters : (m.characters ? [m.characters] : []))
    .map(c => c.name?.toLowerCase())
    .filter(Boolean);
  const available = STATE.players.filter(p => !claimedChars.includes(p.name.toLowerCase()));

  const options = available.map(p => {
    const color = CLASS_COLORS[p.class] || '#888';
    return `<div onclick="claimCharacter(${jsAttr(p.name)})" style="padding:10px 14px; cursor:pointer; border-radius:4px; border:1px solid var(--border); margin-bottom:6px; display:flex; align-items:center; gap:10px; transition:background 0.15s;" onmouseover="this.style.background='var(--bg4)'" onmouseout="this.style.background='transparent'">
      <div style="width:10px; height:10px; border-radius:50%; background:${color};"></div>
      <span style="color:${color}; font-weight:700; font-size:14px;">${escapeHtml(p.name)}</span>
      <span style="color:var(--text-mute); font-size:12px; margin-left:auto;">${escapeHtml(p.class)} · ${escapeHtml(p.serverDisplay || p.server)}</span>
    </div>`;
  }).join('');

  // Insert claim picker right after the (always-visible, even for non-officers)
  // claim section -- NOT anchored to #members-list, which lives inside
  // officer-members-section and is display:none for regular members, so a
  // self-claim picker anchored there would render invisibly for them.
  document.getElementById('claim-picker')?.remove();
  const el = document.getElementById('member-claim-section');
  el.insertAdjacentHTML('afterend', `
    <div id="claim-picker" style="background:var(--bg3); border:1px solid var(--gold-dim); border-radius:6px; padding:16px; margin-bottom:16px;">
      <div style="font-size:13px; font-weight:700; color:var(--gold); margin-bottom:12px;">Select your character:</div>
      <div style="max-height:300px; overflow-y:auto;">${options}</div>
      <button onclick="document.getElementById('claim-picker').remove()" class="btn-secondary" style="margin-top:8px; width:100%;">Cancel</button>
    </div>
  `);
  const picker = document.getElementById('claim-picker');
  const stickyHeader = document.querySelector('#members-modal .modal-header');
  if (picker) {
    // Account for the modal's sticky header, which otherwise overlaps the top
    // of the picker once scrolled into view.
    picker.style.scrollMarginTop = ((stickyHeader?.offsetHeight || 0) + 12) + 'px';
    picker.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function claimCharacter(characterName) {
  try {
    const player = STATE.players.find(p => p.name === characterName);
    const resp = await fetch('/api/members?action=claimCharacter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      characterName, teamId: STATE.teamId, targetAccountId: claimingAccountId,
      characterClass: player?.class, characterServer: player?.server, characterRole: player?.role,
    }) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Claim failed');
    document.getElementById('claim-picker')?.remove();
    showToast('Character claimed: ' + characterName, 'success');
    // Refresh members list
    fetchMembersFromDB().then(data => {
      const members = data?.members || [];
      CURRENT_MEMBERS = members;
      renderMemberClaimSection(members);
      if (['owner','officer'].includes(STATE.myRole)) {
        renderMembersListFromDB(members);
        renderUnclaimedListFromDB(members);
      }
    });
    // Only my own claim (not an officer assigning someone else's) changes
    // what's mine to act as -- refresh STATE so attendance/the claim gate
    // reflect a first-ever claim without needing a full page reload.
    if (!claimingAccountId || claimingAccountId === AUTH.session?.id) {
      const guildData = await fetchGuildFromDB(STATE.teamId);
      if (guildData) {
        STATE.claimedCharacters = mainsFirst(guildData.claimedCharacters);
        STATE.claimedCharacter  = STATE.claimedCharacters[0]?.name || guildData.claimedCharacter || null;
        renderAttendanceCharacterPicker();
      }
    }
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ─────────────────────────────────────────────
//  FLEX MANAGEMENT
// ─────────────────────────────────────────────
function saveFlexChange() {
  if (!CURRENT_PROFILE_PLAYER) return;
  const flexTank   = document.getElementById('flex-tank-toggle').checked;
  const flexHeal   = document.getElementById('flex-heal-toggle').checked;
  const flexMelee  = document.getElementById('flex-melee-toggle').checked;
  const flexRanged = document.getElementById('flex-ranged-toggle').checked;

  // Update in STATE.players
  const player = STATE.players.find(p => p.name === CURRENT_PROFILE_PLAYER.name);
  if (player) {
    player.flex_tank   = flexTank;
    player.flex_heal   = flexHeal;
    player.flex_melee  = flexMelee;
    player.flex_ranged = flexRanged;
  }

  // Save flex overrides to localStorage
  const flexData = JSON.parse(localStorage.getItem('raidlead_flex') || '{}');
  flexData[CURRENT_PROFILE_PLAYER.name] = {
    flex_tank: flexTank, flex_heal: flexHeal,
    flex_melee: flexMelee, flex_ranged: flexRanged,
  };
  localStorage.setItem('raidlead_flex', JSON.stringify(flexData));

  // Also save to Supabase if we have a teamId
  if (STATE.teamId) {
      fetch('/api/roster?action=updateFlex', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        teamId:       STATE.teamId,
        playerName:   CURRENT_PROFILE_PLAYER.name,
        flex_tank:    flexTank,
        flex_heal:    flexHeal,
        flex_melee:   flexMelee,
        flex_ranged:  flexRanged,
      }),
    }).catch(e => console.warn('Flex DB save failed:', e));
  }

  showToast('Flex updated for ' + CURRENT_PROFILE_PLAYER.name, 'success');
  renderRoster();
  renderPlannerChecklist();
}

function loadFlexData() {
  if (STATE.teamId) {
      fetch(`/api/roster?action=getFlex&teamId=${STATE.teamId}`, {
      headers: {}
    }).then(r => r.json()).then(data => {
      if (data.flexData) {
        localStorage.setItem('raidlead_flex', JSON.stringify(data.flexData));
        let changed = false;
        STATE.players.forEach(p => {
          const dbFlex = data.flexData[p.name];
          const newTank   = dbFlex ? (dbFlex.flex_tank   || false) : false;
          const newHeal   = dbFlex ? (dbFlex.flex_heal   || false) : false;
          const newMelee  = dbFlex ? (dbFlex.flex_melee  || false) : false;
          const newRanged = dbFlex ? (dbFlex.flex_ranged || false) : false;
          const canTank   = dbFlex ? (dbFlex.can_flex_tank   || false) : false;
          const canHeal   = dbFlex ? (dbFlex.can_flex_heal   || false) : false;
          const canMelee  = dbFlex ? (dbFlex.can_flex_melee  || false) : false;
          const canRanged = dbFlex ? (dbFlex.can_flex_ranged || false) : false;
          if (p.flex_tank !== newTank || p.flex_heal !== newHeal || p.flex_melee !== newMelee || p.flex_ranged !== newRanged
            || p.can_flex_tank !== canTank || p.can_flex_heal !== canHeal || p.can_flex_melee !== canMelee || p.can_flex_ranged !== canRanged) {
            p.flex_tank = newTank;
            p.flex_heal = newHeal;
            p.flex_melee = newMelee;
            p.flex_ranged = newRanged;
            p.can_flex_tank = canTank;
            p.can_flex_heal = canHeal;
            p.can_flex_melee = canMelee;
            p.can_flex_ranged = canRanged;
            changed = true;
          }
        });
        if (changed) {
          renderRoster();
          renderPlannerChecklist();
        }
      }
    }).catch(() => {});
    return;
  }

  // Load from localStorage immediately for instant render
  const flexCache = JSON.parse(localStorage.getItem('raidlead_flex') || '{}');
  STATE.players.forEach(p => {
    if (flexCache[p.name]) {
      p.flex_tank   = flexCache[p.name].flex_tank   || false;
      p.flex_heal   = flexCache[p.name].flex_heal   || false;
      p.flex_melee  = flexCache[p.name].flex_melee  || false;
      p.flex_ranged = flexCache[p.name].flex_ranged || false;
    }
  });

  // Always fetch from Supabase DB — this is the source of truth
  // DB overrides localStorage so cross-device changes are reflected
  if (STATE.teamId) {
      fetch(`/api/roster?action=getFlex&teamId=${STATE.teamId}`, {
      headers: {}
    }).then(r => r.json()).then(data => {
      if (data.flexData) {
        // DB is source of truth — overwrite local cache
        localStorage.setItem('raidlead_flex', JSON.stringify(data.flexData));
        let changed = false;
        STATE.players.forEach(p => {
          const dbFlex = data.flexData[p.name];
          const newTank = dbFlex ? (dbFlex.flex_tank || false) : false;
          const newHeal = dbFlex ? (dbFlex.flex_heal || false) : false;
          if (p.flex_tank !== newTank || p.flex_heal !== newHeal) {
            p.flex_tank = newTank;
            p.flex_heal = newHeal;
            changed = true;
          }
        });
        if (changed) {
          renderRoster();
          renderPlannerChecklist();
        }
      }
    }).catch(() => {});
  }
}

// ─────────────────────────────────────────────
//  GUILD & ROLE FETCHING FROM SUPABASE
// ─────────────────────────────────────────────

// Fetches the caller's teams. Without teamId: returns every team the account
// belongs to (STATE.teams) plus, when there's exactly one, its full config
// inline. With teamId: returns that specific team's full config (the caller
// must actually belong to it).
async function fetchGuildFromDB(teamId) {
  try {
    const qs = teamId ? ('&teamId=' + encodeURIComponent(teamId)) : '';
    const resp = await fetch('/api/guild?action=get' + qs, {
      headers: {}
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.code === 'NO_GUILD') return null;
    return data;
  } catch(e) { return null; }
}

// Applies a guild.get response to STATE -- the one place that maps a team's
// config onto the app's working state, used on initial load, after joining,
// after creating a guild/team, and when switching the active team.
function applyGuildData(guildData) {
  STATE.teams = guildData?.teams || [];
  const t = guildData?.team;
  if (!t) return false;

  const game = GAMES_API.gameFor(t.guilds?.game);
  const config = {
    guild:       t.guilds?.name || null,
    server:      t.guilds?.server || null,
    region:      t.guilds?.region || 'us',
    game:        game.id,
    difficulty:  t.difficulty || game.defaultDifficulty,
    wclUrl:      t.wcl_url || '',
    wclTeamId:   t.wcl_team_id || null,
    zoneId:      t.zone_id || null,
    zoneName:    t.zone_name || '',
    raidDays:    t.raid_days || [],
    // A version with no Warcraft Logs site yet (Forever, until launch) counts as not connected.
    hasWclCredentials: !!(t.hasWclCredentials && game.sources.wclHost),
    wclClientId: t.wcl_client_id || null,
    hasWowauditKey: t.hasWowauditKey || false,
  };
  STATE.config           = config;
  STATE.zoneId           = config.zoneId;
  STATE.zoneName         = config.zoneName;
  STATE.guildId          = t.guild_id;
  STATE.teamId           = t.id;
  STATE.teamName         = t.name;
  STATE.progressCache    = {}; // may be a different team/region/raid than what was cached
  STATE.progressRaidsList = null;
  STATE.progressRaidSlug  = null;
  STATE.claimedCharacters = mainsFirst(guildData.claimedCharacters);
  STATE.claimedCharacter  = STATE.claimedCharacters[0]?.name || guildData.claimedCharacter || null;
  STATE.joinCode         = t.join_code || null;
  STATE.discordGuildId   = t.discord_guild_id || null;
  STATE.myRole           = guildData.role || 'member';

  saveConfig(config);
  try {
    localStorage.setItem('raidlead_my_role', STATE.myRole);
    localStorage.setItem('raidlead_team_id', t.id);
    localStorage.setItem('raidlead_guild_id', t.guild_id);
    localStorage.setItem('raidlead_active_team_id', t.id);
  } catch(e) {}
  applyGameRules(game.id);
  applyRolePermissions(STATE.myRole);
  renderTeamSwitcher();
  return true;
}

// Switches the page to a WoW version's rules (public/games.js): classes and
// specs, raid buffs, difficulties, and what's shown. Difficulty choices carry
// over when the version has them, otherwise its default.
function applyGameRules(gameId) {
  GAME = GAMES_API.gameFor(gameId);
  CLASS_SPECS = GAME.specs;
  const has = key => GAME.difficulties.some(d => d.key === key);
  if (!has(STATE.scoreDifficulty)) STATE.scoreDifficulty = GAME.defaultDifficulty;
  if (!has(TEAM_MGMT.scoreDifficulty)) TEAM_MGMT.scoreDifficulty = GAME.defaultDifficulty;
  renderDifficultyFilters();
  if (document.body?.dataset) document.body.dataset.game = GAME.id; // CSS hides .retail-only elsewhere
  renderGameBadge();
}

// The WCL Scores and Recruits difficulty buttons, from the version's list.
function renderDifficultyFilters() {
  const buttons = (current, handler) => GAME.difficulties.map(d =>
    `<button class="filter-btn${d.key === current ? ' active' : ''}" onclick="${handler}(${jsAttr(d.key)}, this)">${escapeHtml(d.label)}</button>`).join('');
  const scores = document.getElementById('difficulty-filter');
  if (scores) scores.innerHTML = buttons(STATE.scoreDifficulty, 'setScoreDifficulty');
  const recruits = document.getElementById('recruit-difficulty-filter');
  if (recruits) recruits.innerHTML = buttons(TEAM_MGMT.scoreDifficulty, 'setRecruitScoreDifficulty');
}

// A small version tag in the header ("Classic", "TBC", ...) -- shown for
// every version but Retail, and for Retail too once you're on teams in more
// than one version.
function renderGameBadge() {
  const el = document.getElementById('badge-game');
  if (!el) return;
  const mixed = new Set((STATE.teams || []).map(t => t.game || 'retail')).size > 1;
  const show = GAME.id !== 'retail' || mixed;
  el.textContent = show ? GAME.badge : '';
  el.style.display = show ? '' : 'none';
}

// Loads whichever team should be active: the one remembered from last time if
// the account still belongs to it, otherwise the first team returned.
async function fetchActiveGuildData() {
  let guildData = await fetchGuildFromDB();
  if (guildData && guildData.teams?.length > 0 && !guildData.team) {
    let remembered = null;
    try { remembered = localStorage.getItem('raidlead_active_team_id'); } catch(e) {}
    const pick = guildData.teams.find(t => t.teamId === remembered)?.teamId || guildData.teams[0].teamId;
    guildData = await fetchGuildFromDB(pick);
  }
  return guildData;
}

// Switches the active team (from the team switcher) and reloads everything
// that's scoped to it.
async function switchActiveTeam(teamId) {
  if (teamId === STATE.teamId) return;
  const guildData = await fetchGuildFromDB(teamId);
  if (!guildData || !guildData.team) { showToast('Could not switch teams', 'error'); return; }
  applyGuildData(guildData);
  await loadRosterFromDB();
  // Nothing from the previous team carries over: its scores, and its raid
  // night -- showDashboard picks this team's next raid night once its
  // attendance (extra raid nights) has loaded.
  STATE.scores = []; STATE.bossNames = []; STATE.scoresDifficulty = null;
  STATE.survivorMap = {}; STATE.survivorFetched = false; STATE.survivorMapDifficulty = null;
  STATE.mitigationMap = {}; STATE.mitigationFetched = false; STATE.mitigationMapDifficulty = null;
  STATE.plannerDate = null;
  STATE.attendanceLoaded = false; STATE.attendanceExtraDays = []; STATE.attendanceMarks = [];
  ROLES.members = null; JOIN.list = null; JOIN.entries = []; SURVEY.results = null; SURVEY.surveys = []; SURVEY.selectedId = null;
  showDashboard(guildData);
  updateRosterTitle();
  renderScoresTable('all');
  loadCachedScores();
  checkAndAdvanceSeason();
}

// The guild badge in the header doubles as the team switcher when the
// account is on more than one team: click it for a menu with each team
// on its own line (a team in another guild shows that guild under it).
function renderTeamSwitcher() {
  const badge = document.getElementById('guild-badge');
  const caret = document.getElementById('guild-badge-caret');
  const menu  = document.getElementById('team-menu');
  const teams = STATE.teams || [];
  const multi = teams.length > 1;
  if (badge) { badge.classList.toggle('switchable', multi); badge.title = multi ? 'Switch team' : ''; }
  if (caret) caret.style.display = multi ? '' : 'none';
  if (!menu) return;
  if (!multi) { menu.innerHTML = ''; menu.classList.remove('open'); return; }
  const current = teams.find(t => t.teamId === STATE.teamId);
  const item = t => {
    const otherGuild = current && t.guildId !== current.guildId;
    const isCurrent = t.teamId === STATE.teamId;
    return `<button class="dropdown-item team-menu-item${isCurrent ? ' active' : ''}" onclick="chooseTeam(${jsAttr(t.teamId)})">
      <span class="team-menu-check">${isCurrent ? '✓' : ''}</span>
      <span class="team-menu-name">${escapeHtml(t.teamName || 'Team')}${otherGuild
        ? `<span class="team-menu-guild">${escapeHtml(t.guildName || '')}${t.guildServer ? ' – ' + escapeHtml(titleCaseServer(t.guildServer)) : ''}</span>` : ''}</span>
    </button>`;
  };
  // Teams in more than one WoW version are grouped by version -- switching
  // to a Classic team switches the whole site to Classic.
  const games = GAMES_API.GAME_ORDER.filter(id => teams.some(t => (t.game || 'retail') === id));
  const body = games.length > 1
    ? games.map(id => `<div class="team-menu-group">${escapeHtml(GAMES_API.GAMES[id].label)}</div>` +
        teams.filter(t => (t.game || 'retail') === id).map(item).join('')).join('')
    : teams.map(item).join('');
  menu.innerHTML = body +
    `<button class="dropdown-item team-menu-item team-menu-another" onclick="startAnotherGuild()"><span class="team-menu-check">＋</span><span class="team-menu-name">Start or join another guild</span></button>`;
  renderGameBadge();
}

// From the team menu or account menu: create a new guild (any WoW version) or
// join one with a code, without leaving the teams you're already on.
function startAnotherGuild() {
  document.getElementById('team-menu')?.classList.remove('open');
  showLandingChoice();
}

// Back from the Create/Join screens to the team you were on.
function returnToTeam() {
  if (isOnTeam()) showDashboard();
}

// True once a team you're a member of has loaded (not just a cached id).
function isOnTeam() {
  return !!STATE.teamId && (STATE.teams || []).some(t => t.teamId === STATE.teamId);
}

function toggleTeamMenu() {
  if ((STATE.teams || []).length < 2) return;
  document.getElementById('team-menu')?.classList.toggle('open');
}

function chooseTeam(teamId) {
  document.getElementById('team-menu')?.classList.remove('open');
  switchActiveTeam(teamId);
}

async function fetchMembersFromDB(teamId) {
  try {
    const tid = teamId || STATE.teamId || '';
    const resp = await fetch('/api/members?action=get&teamId=' + encodeURIComponent(tid), {
      headers: {}
    });
    if (!resp.ok) return { members: [], myRole: null };
    return await resp.json();
  } catch(e) { return { members: [], myRole: null }; }
}

async function updateMemberInDB(targetAccountId, role, characterName, teamId) {
  const resp = await fetch('/api/members?action=updateRole', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ targetAccountId, role, characterName, teamId }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error);
  return data;
}

async function saveRaidPlanToDB(publish = false) {
  const teamId = STATE.teamId;
  if (!teamId) { showToast('No team configured', 'error'); return; }

  // Send each player with their flex role assignment
  const selectedPlayers = [...plannerSelected].map(name => {
    const player = STATE.players.find(p => p.name === name) || {};
    return {
      name,
      class:    player.class  || 'unknown',
      server:   player.server || STATE.config?.server || '',
      role:     player.role   || 'ranged',
      flexRole: flexRoleSelected[name] || 'primary',
    };
  });

  const resp = await fetch('/api/plans?action=save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      teamId,
      selectedPlayers,
      publish,
      planName: 'Raid Night',
      raidDate: STATE.plannerDate || nextUpcomingRaidDate(),
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error);
  return data;
}

async function fetchRaidPlanFromDB(raidDate) {
  const teamId = STATE.teamId;
  if (!teamId) return null;
  try {
    const dateParam = raidDate ? `&raidDate=${raidDate}` : '';
    const resp = await fetch(`/api/plans?action=get&teamId=${teamId}${dateParam}`, {
      headers: {}
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch(e) { return null; }
}

// Apply role-based UI visibility
function applyRolePermissions(role) {
  if (!role) return;
  STATE.myRole = role;
  const isOfficer = ['owner', 'officer'].includes(role);

  // Settings — dropdown only, no standalone button. Officers+ (owner-only actions
  // like transferring ownership are gated separately, inside the Members panel).
  const dropdownSettingsBtn = document.getElementById('dropdown-settings-btn');
  if (dropdownSettingsBtn) dropdownSettingsBtn.style.display = isOfficer ? 'block' : 'none';

  // Members — dropdown only, no standalone button


  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) shareBtn.style.display = isOfficer ? 'flex' : 'none';
  const dropdownInviteBtn = document.getElementById('dropdown-invite-btn');
  if (dropdownInviteBtn) dropdownInviteBtn.style.display = isOfficer ? 'block' : 'none';

  // Raid Night edit controls — officers only
  const editBtn    = document.getElementById('planner-edit-btn');
  const publishBtn = document.getElementById('planner-publish-btn');
  const importBtn  = document.getElementById('planner-import-btn');
  const clearBtn   = document.getElementById('planner-clear-btn');
  if (editBtn)    editBtn.style.display    = isOfficer ? 'block' : 'none';
  if (publishBtn) publishBtn.style.display = 'none'; // only show in edit mode
  if (importBtn)  importBtn.style.display  = 'none'; // only visible in edit mode / draft
  if (clearBtn)   clearBtn.style.display   = 'none'; // only visible in edit mode

  // WCL Scores fetch button — officers only (results visible to all)
  const scoresFetchBtn = document.getElementById('fetch-scores-btn');
  if (scoresFetchBtn) scoresFetchBtn.style.display = isOfficer ? 'inline-flex' : 'none';

  // Flex controls in profile modal
  const flexControls = document.getElementById('flex-controls');
  if (flexControls) flexControls.style.display = isOfficer ? 'block' : 'none';

  // WCL refresh is officer-only; members read the latest saved scores.
  const fetchScoresBtn = document.getElementById('fetch-scores-btn');
  if (fetchScoresBtn) fetchScoresBtn.style.display = isOfficer ? 'inline-flex' : 'none';

  // Roster management -- adding/importing/editing/removing characters is officer-only.
  const addCharacterBtn = document.getElementById('add-character-btn');
  if (addCharacterBtn) addCharacterBtn.style.display = isOfficer ? 'inline-flex' : 'none';
  updateWowauditImportBtn();

  // Team Management tab -- officers only. Toggled with a class, not an inline
  // style.display: below 1440px wide the stylesheet hides every .nav-btn in
  // favor of the hamburger menu, and an inline display would override that
  // and leak this one button back into the tablet/mobile header. The
  // hamburger's copy of the button has to be toggled too.
  document.querySelectorAll('.nav-btn[data-tab="team"], .mobile-nav-item[data-tab="team"]')
    .forEach(el => el.classList.toggle('role-hidden', !isOfficer));

  // Raid Night "Show Order Joined" -- officers only.
  const joinOrderBtn = document.getElementById('planner-join-order-btn');
  if (joinOrderBtn) joinOrderBtn.style.display = isOfficer ? 'inline-flex' : 'none';
  if (isOfficer) restoreShowOrderJoined(); else JOIN.showOnPlanner = false;
  if (!isOfficer && document.getElementById('tab-team')?.classList.contains('active')) showTab('roster');
}

// The Import button is officer-only. It shows with or without a WowAudit
// key -- without one, clicking it asks for a key (showWowauditKeyPrompt).
// Called from applyRolePermissions and after saving/clearing the key.
function updateWowauditImportBtn() {
  const btn = document.getElementById('wowaudit-import-btn');
  if (!btn) return;
  btn.style.display = ['owner', 'officer'].includes(STATE.myRole) && GAME.id === 'retail' ? 'inline-flex' : 'none'; // WowAudit covers Retail
}

// ─────────────────────────────────────────────
//  DISPLAY NAME
// ─────────────────────────────────────────────
// One name for the account, shown the same on every team it's on.
async function saveDisplayName(name) {
  name = (name || '').trim();
  if (!name) return;
  const btn = document.getElementById('display-name-save-btn');
  if (btn) btn.disabled = true;
  try {
    const resp = await fetch('/api/members?action=updateDisplayName', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Could not save');
    if (AUTH.session) AUTH.session.displayName = name;
    ORIGINAL_DISPLAY_NAME = name;
    // The member list in this window shows it too.
    const self = CURRENT_MEMBERS.find(m => m.account_id === AUTH.session?.id);
    const acct = Array.isArray(self?.accounts) ? self.accounts[0] : self?.accounts;
    if (acct) acct.display_name = name;
    if (['owner', 'officer'].includes(STATE.myRole)) renderMembersListFromDB(CURRENT_MEMBERS);
    showToast('Display name saved!', 'success');
  } catch (e) {
    showToast('Error saving display name: ' + e.message, 'error');
  }
  updateDisplayNameSaveState();
}

function showToast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast ' + type + ' show';
  setTimeout(() => t.className = 'toast ' + type, 3000);
}
// ── Fetch zone boss list ──
async function fetchZoneBosses(zoneId) {
  const query = `query {
    worldData {
      zone(id: ${zoneId}) {
        encounters {
          id
          name
        }
      }
    }
  }`;
  const resp = await wclQuery(query);
  return resp?.data?.worldData?.zone?.encounters || [];
}

// ─────────────────────────────────────────────
//  TEAM MANAGEMENT (officers only) -- Recruits
// ─────────────────────────────────────────────
// Recruiting pipeline: people an officer reached out to (and, once the
// Applicants sub-tab lands, applicants promoted out of that triage inbox),
// reusable outreach message templates, and the same WCL scores the roster
// gets. Backed by api/recruiting.js, which re-checks officer role on every
// action -- hiding the tab is only a UX nicety, not the security boundary.
const TEAM_MGMT = {
  recruits:          [],
  templates:         [],
  view:              'list',        // list | scores
  statusFilter:      'active',      // active | history | rejected | all
  scoreView:         'performance', // performance | oppoparse | firstkill
  scoreDifficulty:   'mythic',
  scoreSortCol:      'best',
  scoresInFlight:    false,
  lookupTimer:       null,
  lookupToken:       0,
  editingTemplateId: null,
  // Applicants (the guild's Google Form responses)
  applications:          null,      // last listApplications payload
  applicantFilter:       'pending', // pending | promoted | rejected | all
  applicantSettingsOpen: false,
  applicantLookups:      {},        // response key -> { summary, existing } from Raider.io, per session
  selectedApplicants:    new Set(), // response keys ticked for a bulk action
  bulkInFlight:          false,
  // Recruits "Change Recruit Specs" mode
  specEditing:           false,
  specDrafts:            {},        // recruit id -> spec picked but not saved yet
  specSaving:            false,
};

// Must match STATUSES in api/recruiting.js.
const RECRUIT_STATUSES = [
  { value: 'contacted',      label: 'Contacted' },
  { value: 'no_response',    label: 'No Response' },
  { value: 'not_interested', label: 'Not Interested' },
  { value: 'interested',     label: 'Interested' },
  { value: 'joined',         label: 'Joined' },
  { value: 'rejected',       label: 'Rejected' },
];
// Outcome settled -> shown under History instead of Active (Rejected has its own filter).
const RECRUIT_CLOSED_STATUSES = ['no_response', 'not_interested', 'joined', 'rejected'];
// "Beast Mastery" / "BeastMastery" (WCL's spelling) -> "beastmastery"
const specKey = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
// The class's own spelling of a spec, or null if it isn't one of theirs.
function canonicalSpecFor(cls, spec) {
  const key = specKey(spec);
  return (CLASS_SPECS[cls] || []).find(([name]) => specKey(name) === key)?.[0] || null;
}
const RECRUIT_CHANNEL_LABELS  = { mail: 'Mail', whisper: 'Whisper', discord: 'Discord', form: 'Application', other: 'Other' };
// WoW's own caps: chat/whisper lines at 255 characters, in-game mail bodies at 500.
const WHISPER_CHAR_LIMIT = 255;
const MAIL_CHAR_LIMIT    = 500;

async function recruitingApi(action, body) {
  const resp = await fetch('/api/recruiting?action=' + encodeURIComponent(action), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: STATE.teamId, ...(body || {}) }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = resp.status;
    err.data   = data;
    throw err;
  }
  return data;
}

async function loadTeamTab() {
  const dateInput = document.getElementById('ra-date');
  if (dateInput && !dateInput.value) dateInput.value = attendanceDateStr(new Date());
  const realmInput = document.getElementById('ra-realm');
  if (realmInput && !realmInput.value) realmInput.value = titleCaseServer(STATE.config?.server);

  // Applications read a Google Sheet, which can be slower -- loaded on its
  // own so it never holds up the Recruits list.
  loadApplications();

  const listEl = document.getElementById('recruit-list');
  if (TEAM_MGMT.recruits.length === 0) {
    listEl.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Loading recruits...</div></div>';
  }
  try {
    const [r, t] = await Promise.all([recruitingApi('listRecruits'), recruitingApi('listTemplates')]);
    TEAM_MGMT.recruits  = r.recruits  || [];
    TEAM_MGMT.templates = t.templates || [];
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><h3>Couldn't load recruits</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  renderRecruitTab();
  refreshStaleRecruitLookups();
}

// Raider.io snapshots older than this get re-pulled when the tab opens.
const RECRUIT_LOOKUP_MAX_AGE_MS = 3 * 86400000;

// Quietly re-pulls missing or stale Raider.io snapshots, a few at a time.
// This is also what repairs a recruit who renamed or transferred: the
// server follows them through Warcraft Logs and saves the new name, so
// their links and WCL scores work again. Each recruit is tried at most
// once per session.
async function refreshStaleRecruitLookups() {
  TEAM_MGMT.lookupRefreshTried ||= new Set();
  const stale = TEAM_MGMT.recruits.filter(r => {
    if (TEAM_MGMT.lookupRefreshTried.has(r.id)) return false;
    const fetched = Date.parse(r.lookup?.fetchedAt || '');
    return !r.lookup || !fetched || Date.now() - fetched > RECRUIT_LOOKUP_MAX_AGE_MS;
  });
  if (stale.length === 0) return;
  stale.forEach(r => TEAM_MGMT.lookupRefreshTried.add(r.id));

  const renamed = [];
  await runWithConcurrency(stale, 3, async r => {
    try {
      const { recruit } = await recruitingApi('refreshRecruitLookup', { recruitId: r.id });
      const i = TEAM_MGMT.recruits.findIndex(x => x.id === recruit.id);
      if (i >= 0) TEAM_MGMT.recruits[i] = recruit;
      if (recruit.name !== r.name || recruit.realm_slug !== r.realm_slug) renamed.push(recruit);
    } catch (e) { /* keep the old snapshot */ }
  });
  renderRecruitsUnlessEditing();
  // Their scores were looked up under the old name -- fetch them again.
  if (renamed.length && STATE.config?.hasWclCredentials && STATE.zoneId) fetchRecruitScores(renamed, { silent: true });
}

function renderRecruitTab() {
  renderRecruitSpecToolbar();
  renderRecruits();
  renderRecruitTemplates();
  if (TEAM_MGMT.view === 'scores') renderRecruitScores();
}

function setTeamSubTab(name, btn) {
  document.querySelectorAll('#team-subtab-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  ['applicants', 'recruits', 'season', 'join', 'roles'].forEach(n => {
    const el = document.getElementById('team-subtab-' + n);
    if (el) el.style.display = n === name ? '' : 'none';
  });
  if (name === 'season') return loadSeasonTab();
  if (name === 'join') return loadJoinOrderTab();
  if (name === 'roles') return loadRolesTab();
}

function setRecruitView(view, btn) {
  TEAM_MGMT.view = view;
  document.querySelectorAll('#recruit-view-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('recruit-view-list').style.display   = view === 'list'   ? '' : 'none';
  document.getElementById('recruit-view-scores').style.display = view === 'scores' ? '' : 'none';
  if (view === 'scores') renderRecruitScores(); else renderRecruits(); // picks up a score refresh's WCL spec hints
}

function setRecruitStatusFilter(filter, btn) {
  TEAM_MGMT.statusFilter = filter;
  document.querySelectorAll('#recruit-status-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderRecruitTab();
}

// "YYYY-MM-DD" parsed as a LOCAL date (not UTC), so something contacted
// today never reads as "1d ago" for anyone west of UTC.
function parseLocalDate(dateStr) {
  const [y, m, d] = (dateStr || '').split('-').map(Number);
  return y ? new Date(y, m - 1, d) : null;
}

function daysSinceDate(dateStr) {
  const then = parseLocalDate(dateStr);
  if (!then) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today - then) / 86400000);
}

function formatRecruitDate(dateStr) {
  const d = parseLocalDate(dateStr);
  return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
}

function recruitMatchesFilter(r, filter) {
  if (filter === 'all') return true;
  if (filter === 'rejected' || r.status === 'rejected') return filter === 'rejected' && r.status === 'rejected';
  const closed = RECRUIT_CLOSED_STATUSES.includes(r.status);
  return filter === 'history' ? closed : !closed;
}

function visibleRecruits() {
  return TEAM_MGMT.recruits.filter(r => recruitMatchesFilter(r, TEAM_MGMT.statusFilter));
}

function sortRecruits() {
  TEAM_MGMT.recruits.sort((a, b) =>
    (b.contacted_at || '').localeCompare(a.contacted_at || '') || (b.created_at || '').localeCompare(a.created_at || ''));
}

function recruitLinks(r) {
  return characterLinks(r.name, r.realm_slug, r.lookup?.profileUrl);
}

// Raider.io, Warcraft Logs, and Armory links for a character in the team's
// WoW version -- each only where that version has one (null otherwise).
function characterLinks(name, realmSlug, rioProfileUrl) {
  if (!name || !realmSlug) return { raiderio: null, wcl: null, armory: null };
  const region = toWclRegion(STATE.config?.region || 'us');
  const enc    = encodeURIComponent(name);
  const lower  = encodeURIComponent(name.toLowerCase());
  const rio    = GAME.sources.raiderio;
  const wcl    = GAME.sources.wclHost;
  return {
    raiderio: rio ? (rioProfileUrl && rioProfileUrl.startsWith(`https://${rio.host}/`) ? rioProfileUrl : `https://${rio.host}/characters/${region}/${realmSlug}/${enc}`) : null,
    wcl:      wcl ? `https://${wcl}.warcraftlogs.com/character/${region}/${realmSlug}/${lower}` : null,
    armory:   GAME.sources.armory ? `https://worldofwarcraft.blizzard.com/${GAME.sources.armory}/character/${region}/${realmSlug}/${lower}` : null,
  };
}

// { name, realm } a lookup found them under before a rename or realm
// transfer -> "Vuk-Sargeras".
function formerCharacterText(renamedFrom) {
  return renamedFrom ? `${renamedFrom.name}-${titleCaseServer(renamedFrom.realm)}` : '';
}

const RENAMED_TOOLTIP = 'Renamed or transferred since then -- RaidLead found their current character through Warcraft Logs';

function titleCaseClass(cls) {
  return cls ? cls.replace(/\b\w/g, c => c.toUpperCase()) : '';
}

// "Devastation Evoker · 316 ilvl · 3,140 M+ · 6/8 M"
function recruitStatLine(spec, cls, lookup) {
  const l = lookup || {};
  return [
    [spec, titleCaseClass(cls)].filter(Boolean).join(' '),
    l.ilvl ? `${Math.round(l.ilvl)} ilvl` : null,
    l.mplusScore ? `${Math.round(l.mplusScore).toLocaleString()} M+` : null,
    l.raidProgress || null,
  ].filter(Boolean).join(' · ');
}

function alreadyTrackedMessage(existing) {
  const who    = existing.creator?.display_name || existing.creator?.battletag || 'an officer';
  const status = RECRUIT_STATUSES.find(s => s.value === existing.status)?.label || existing.status;
  return `Already tracked: ${existing.name} was added by ${who}, contacted ${formatRecruitDate(existing.contacted_at)} (${status}).`;
}

// "Elemental Shaman · 316 ilvl · 3,140 M+ · 6/8 M". While "Change Recruit
// Specs" is on, the spec becomes a picker -- Raider.io only knows the spec
// they last logged out in, so officers correct it here.
function recruitSpecLineHtml(r) {
  const specs = CLASS_SPECS[r.class];
  if (!TEAM_MGMT.specEditing || !specs) {
    const stat = recruitStatLine(r.spec, r.class, r.lookup);
    return stat ? escapeHtml(stat) : 'No Raider.io data';
  }
  const saved   = canonicalSpecFor(r.class, r.spec);
  const shown   = TEAM_MGMT.specDrafts[r.id] || saved;
  const options = (shown ? '' : `<option value="" selected>${escapeHtml(r.spec || 'Spec?')}</option>`)
    + specs.map(([name]) => `<option value="${escapeHtml(name)}"${name === shown ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('');
  const rest = recruitStatLine(null, r.class, r.lookup);
  return `<select class="recruit-spec-select${TEAM_MGMT.specDrafts[r.id] ? ' changed' : ''}" aria-label="Spec"
      title="Their main spec. Sets their role, and whether WCL scores use DPS or HPS."
      onchange="setRecruitSpecDraft(${jsAttr(r.id)}, this.value)">${options}</select> ${escapeHtml(rest)}`;
}

// The spec their WCL logs are on, from the last score fetch (the selected
// difficulty first) -- or null if it matches their spec (or the unsaved
// pick while editing), or is unknown.
function recruitLoggedSpec(r) {
  const current = (TEAM_MGMT.specEditing && TEAM_MGMT.specDrafts[r.id]) || r.spec;
  const order = [TEAM_MGMT.scoreDifficulty, ...GAME.difficulties.map(d => d.key).reverse()];
  for (const diff of order) {
    const logged = canonicalSpecFor(r.class, r.wcl_scores?.[diff]?.result?.loggedSpec);
    if (logged) return specKey(logged) === specKey(current) ? null : logged;
  }
  return null;
}

// One click saves it -- or, while editing specs, just picks it in the dropdown.
function recruitSpecHintHtml(r) {
  const logged = recruitLoggedSpec(r);
  if (!logged) return '';
  const action = TEAM_MGMT.specEditing ? 'setRecruitSpecDraft' : 'setRecruitSpec';
  return `<button class="recruit-spec-hint" title="Their ranked Warcraft Logs parses are on ${escapeHtml(logged)}. Switch their spec to match."
    onclick="${action}(${jsAttr(r.id)}, ${jsAttr(logged)})">Logs as ${escapeHtml(logged)} on WCL · Use ${escapeHtml(logged)}</button>`;
}

// "Change Recruit Specs", or Cancel / Save Changes while editing.
function renderRecruitSpecToolbar() {
  const el = document.getElementById('recruit-spec-toolbar');
  if (!el) return;
  if (TEAM_MGMT.recruits.length === 0) { el.innerHTML = ''; return; }
  if (!TEAM_MGMT.specEditing) {
    el.innerHTML = `<button class="btn-secondary recruit-small-btn" onclick="startRecruitSpecEdit()"
      title="Raider.io only shows the spec they last logged out in. Set each recruit's real main spec here.">Change Recruit Specs</button>`;
    return;
  }
  const n = Object.keys(TEAM_MGMT.specDrafts).length;
  const busy = TEAM_MGMT.specSaving ? ' disabled' : '';
  // Left-aligned, over the spec column; Save takes Change Recruit Specs' spot.
  el.innerHTML = `<button class="btn-primary recruit-small-btn" onclick="saveRecruitSpecEdits()"${busy || (n ? '' : ' disabled')}>${
      TEAM_MGMT.specSaving ? 'Saving...' : `Save Changes${n ? ` (${n})` : ''}`}</button>
    <button class="btn-secondary recruit-small-btn" onclick="cancelRecruitSpecEdit()"${busy}>Cancel</button>
    <span class="recruit-spec-toolbar-note">Pick each recruit's main spec, then save.</span>`;
}

function startRecruitSpecEdit() {
  TEAM_MGMT.specEditing = true;
  TEAM_MGMT.specDrafts  = {};
  renderRecruitTab();
}

function cancelRecruitSpecEdit() {
  TEAM_MGMT.specEditing = false;
  TEAM_MGMT.specDrafts  = {};
  renderRecruitTab();
}

// Held until Save Changes -- picking their saved spec again drops the draft.
function setRecruitSpecDraft(recruitId, spec) {
  const r = TEAM_MGMT.recruits.find(x => x.id === recruitId);
  if (!r || !spec) return;
  if (specKey(spec) === specKey(r.spec)) delete TEAM_MGMT.specDrafts[recruitId];
  else TEAM_MGMT.specDrafts[recruitId] = spec;
  renderRecruitTab();
}

async function saveRecruitSpecEdits() {
  const changes = Object.entries(TEAM_MGMT.specDrafts).map(([id, spec]) => ({ id, spec }));
  if (changes.length === 0) return cancelRecruitSpecEdit();
  TEAM_MGMT.specSaving = true;
  renderRecruitSpecToolbar();
  const failed = await saveRecruitSpecs(changes);
  TEAM_MGMT.specSaving = false;
  // Anything that didn't save stays in edit mode as a draft, to retry.
  TEAM_MGMT.specDrafts = Object.fromEntries(failed.map(c => [c.id, c.spec]));
  TEAM_MGMT.specEditing = failed.length > 0;
  renderRecruitTab();
}

// The single-click path (the WCL hint outside edit mode).
async function setRecruitSpec(recruitId, spec) {
  if (!spec) return;
  await saveRecruitSpecs([{ id: recruitId, spec }]);
  renderRecruitTab();
}

// Saves spec changes, then starts re-fetching WCL scores (in the
// background) for anyone who crossed healer <-> non-healer: that switches
// the metric (HPS vs DPS), and the server already dropped their old-metric
// scores. Returns the changes that failed to save; the caller re-renders.
async function saveRecruitSpecs(changes) {
  const failed = [], crossed = [];
  await runWithConcurrency(changes, 4, async c => {
    const before = TEAM_MGMT.recruits.find(r => r.id === c.id);
    if (!before) return;
    try {
      const { recruit } = await recruitingApi('updateRecruit', { recruitId: c.id, spec: c.spec });
      const i = TEAM_MGMT.recruits.findIndex(r => r.id === c.id);
      if (i >= 0) TEAM_MGMT.recruits[i] = recruit;
      if ((recruit.role === 'heal') !== (before.role === 'heal')) crossed.push(recruit);
    } catch (e) {
      failed.push({ ...c, error: e.message });
    }
  });

  const saved = changes.length - failed.length;
  if (failed.length) {
    showToast(`Couldn't save ${failed.length} spec change${failed.length === 1 ? '' : 's'}: ${failed[0].error}`, 'error');
  } else if (changes.length > 1) {
    showToast(`Saved ${saved} spec changes`, 'success');
  }

  if (crossed.length && STATE.config?.hasWclCredentials && STATE.zoneId) {
    const who = crossed.length === 1 ? crossed[0].name : `${crossed.length} recruits`;
    if (TEAM_MGMT.scoresInFlight) {
      showToast(`Refresh scores once the current refresh finishes to get ${who}'s parses for their new role.`, '');
    } else {
      showToast(`Fetching ${who}'s parses for their new role (${crossed.length === 1 ? (crossed[0].role === 'heal' ? 'HPS' : 'DPS') : 'HPS / DPS'})`, 'success');
      fetchRecruitScores(crossed, { silent: true }).then(renderRecruitsUnlessEditing);
    }
  }
  return failed;
}

// Background updates re-render the list, but not out from under an officer
// mid-way through typing a note -- the fresh data shows on the next render.
function renderRecruitsUnlessEditing() {
  const listEl = document.getElementById('recruit-list');
  if (listEl && document.activeElement && listEl.contains?.(document.activeElement)) return;
  renderRecruitTab();
}

function renderRecruits() {
  const wrap = document.getElementById('recruit-list');
  if (!wrap) return;

  if (TEAM_MGMT.recruits.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">✉</div><h3>Track your first recruit</h3>
      <p>Add someone you've mailed or whispered above. RaidLead pulls their class, item level${GAME.sources.raiderio?.mplus ? ', and M+ score' : ''} from ${GAME.sources.raiderio ? 'Raider.io' : 'the Armory'}.</p></div>`;
    return;
  }
  const list = visibleRecruits();
  if (list.length === 0) {
    wrap.innerHTML = '<div class="recruit-empty-filter">No recruits match this filter.</div>';
    return;
  }

  const templateOptions = TEAM_MGMT.templates
    .map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.title)}</option>`).join('');

  wrap.innerHTML = list.map(r => {
    const color    = CLASS_COLORS[r.class] || 'var(--text)';
    const days     = daysSinceDate(r.contacted_at);
    const ago      = days == null ? '' : days <= 0 ? 'today' : `${days}d ago`;
    const closed   = RECRUIT_CLOSED_STATUSES.includes(r.status);
    const links    = recruitLinks(r);
    const addedBy  = r.creator?.display_name || r.creator?.battletag || '';
    const statusOptions = RECRUIT_STATUSES
      .map(s => `<option value="${s.value}"${s.value === r.status ? ' selected' : ''}>${s.label}</option>`).join('');
    return `
      <div class="recruit-row${closed ? ' closed' : ''}">
        <div class="recruit-main">
          <div class="recruit-name-line">
            <span class="recruit-name" style="color:${color};">${escapeHtml(r.name)}</span>
            <span class="recruit-realm">${escapeHtml(r.realm)}</span>
            ${r.lookup?.renamedFrom ? `<span class="recruit-renamed" title="${escapeHtml(RENAMED_TOOLTIP)}">formerly ${escapeHtml(formerCharacterText(r.lookup.renamedFrom))}</span>` : ''}
            ${r.application_key ? `<button class="recruit-badge clickable" title="View their application" onclick="openApplicationModal(${jsAttr(r.application_key)})">Application</button>` : ''}
          </div>
          <div class="recruit-sub">${recruitSpecLineHtml(r)}</div>
          ${recruitSpecHintHtml(r)}
          <div class="recruit-links">
            <a href="${escapeHtml(links.raiderio)}" target="_blank" rel="noopener noreferrer">Raider.io</a>
            <a href="${escapeHtml(links.wcl)}" target="_blank" rel="noopener noreferrer">WCL</a>
            <a href="${escapeHtml(links.armory)}" target="_blank" rel="noopener noreferrer">Armory</a>
          </div>
        </div>
        <div class="recruit-contact">
          <div class="recruit-date-line">
            <input type="date" class="recruit-date-input" value="${escapeHtml(r.contacted_at || '')}" max="${attendanceDateStr(new Date())}"
              title="When you last contacted them. Change it if you've talked to them again, or to fix a wrong date."
              aria-label="Last contacted" onchange="queueRecruitDateSave(${jsAttr(r.id)}, this)" onblur="queueRecruitDateSave(${jsAttr(r.id)}, this, true)" />
            <span class="recruit-sub">${ago}</span>
          </div>
          <div class="recruit-sub">${escapeHtml(RECRUIT_CHANNEL_LABELS[r.channel] || '—')}${addedBy ? ' · ' + escapeHtml(addedBy) : ''}</div>
        </div>
        <div class="recruit-status">
          <select onchange="updateRecruitField(${jsAttr(r.id)}, 'status', this.value)">${statusOptions}</select>
          ${r.status === 'joined' ? `<button class="btn-secondary recruit-small-btn" onclick="addRecruitToRoster(${jsAttr(r.id)})">Add to roster</button>` : ''}
        </div>
        <div class="recruit-notes">
          <input type="text" value="${escapeHtml(r.notes || '')}" placeholder="Notes" maxlength="500"
            onchange="updateRecruitField(${jsAttr(r.id)}, 'notes', this.value)" />
        </div>
        <div class="recruit-actions">
          ${templateOptions ? `<select class="recruit-template-select" title="Copy a message template with this recruit's name filled in"
            onchange="copyTemplateForRecruit(this.value, ${jsAttr(r.id)}); this.value='';"><option value="">Copy template…</option>${templateOptions}</select>` : ''}
          ${r.status === 'rejected'
            ? `<button class="recruit-delete" title="Delete permanently" onclick="deleteRecruit(${jsAttr(r.id)})">✕</button>`
            : `<button class="recruit-delete" title="Reject" onclick="rejectRecruit(${jsAttr(r.id)})">✕</button>`}
        </div>
      </div>`;
  }).join('');
}

// Raider.io preview while typing -- debounced, and a token discards any
// response that a newer keystroke's lookup has already superseded.
function scheduleRecruitLookup() {
  clearTimeout(TEAM_MGMT.lookupTimer);
  TEAM_MGMT.lookupTimer = setTimeout(runRecruitLookup, 600);
}

async function runRecruitLookup() {
  const name  = document.getElementById('ra-name').value.trim();
  const realm = document.getElementById('ra-realm').value.trim();
  const el    = document.getElementById('ra-lookup');
  const token = ++TEAM_MGMT.lookupToken;
  el.className = 'recruit-lookup';
  if (!name || !realm) { el.textContent = ''; return; }
  el.textContent = 'Looking up on Raider.io...';
  try {
    const data = await recruitingApi('lookupCharacter', { name, realm });
    if (token !== TEAM_MGMT.lookupToken) return;
    if (data.existing) {
      el.className   = 'recruit-lookup warn';
      el.textContent = alreadyTrackedMessage(data.existing);
      return;
    }
    const s = data.summary;
    if (!s) {
      el.textContent = 'Not found on Raider.io. You can still add them.';
      return;
    }
    el.className = 'recruit-lookup found';
    el.innerHTML = `<span style="color:${CLASS_COLORS[s.class] || 'var(--text)'}; font-weight:700;">${escapeHtml(s.name)}</span>
      <span class="recruit-sub">${escapeHtml(s.realmName || '')}</span> · ${escapeHtml(recruitStatLine(s.spec, s.class, s) || 'Not on Raider.io')}`
      + (s.renamedFrom ? ` · <span class="recruit-renamed" title="${escapeHtml(RENAMED_TOOLTIP)}">renamed from ${escapeHtml(formerCharacterText(s.renamedFrom))}</span>` : '');
  } catch (e) {
    if (token === TEAM_MGMT.lookupToken) el.textContent = '';
  }
}

async function addRecruit() {
  const nameEl   = document.getElementById('ra-name');
  const realmEl  = document.getElementById('ra-realm');
  const notesEl  = document.getElementById('ra-notes');
  const lookupEl = document.getElementById('ra-lookup');
  const name  = nameEl.value.trim();
  const realm = realmEl.value.trim();
  if (!name || !realm) {
    lookupEl.className   = 'recruit-lookup warn';
    lookupEl.textContent = 'Enter a character name and realm.';
    return;
  }

  const btn = document.getElementById('ra-add-btn');
  btn.disabled = true;
  try {
    const data = await recruitingApi('addRecruit', {
      name,
      realm,
      channel:     document.getElementById('ra-channel').value,
      contactedAt: document.getElementById('ra-date').value || attendanceDateStr(new Date()),
      notes:       notesEl.value,
    });
    TEAM_MGMT.recruits.push(data.recruit);
    sortRecruits();
    nameEl.value = '';
    notesEl.value = '';
    TEAM_MGMT.lookupToken++; // drop any lookup still in flight for the name just added
    lookupEl.textContent = '';
    lookupEl.className   = 'recruit-lookup';
    renderRecruitTab();
    showToast(`${data.recruit.name} added`, 'success');
    if (STATE.config?.hasWclCredentials && STATE.zoneId) fetchRecruitScores([data.recruit], { silent: true });
  } catch (e) {
    lookupEl.className   = 'recruit-lookup warn';
    lookupEl.textContent = e.status === 409 && e.data?.existing ? alreadyTrackedMessage(e.data.existing) : e.message;
  } finally {
    btn.disabled = false;
  }
}

// Date inputs fire change on every keystroke while a date is typed (a year
// of "2" is briefly 0002-09-25), so the save waits for a pause in typing,
// or happens right away when they leave the field.
function queueRecruitDateSave(recruitId, input, now = false) {
  clearTimeout(TEAM_MGMT.dateSaveTimer);
  const save = () => {
    const r = TEAM_MGMT.recruits.find(x => x.id === recruitId);
    if (!r) return;
    const value = input.value;
    const valid = value && value >= '2004-01-01' && value <= attendanceDateStr(new Date());
    if (valid && value !== r.contacted_at) return updateRecruitField(recruitId, 'contactedAt', value);
    if (now) renderRecruitsUnlessEditing(); // left the field: show the saved date (and fresh "days ago")
  };
  if (now) save(); else TEAM_MGMT.dateSaveTimer = setTimeout(save, 800);
}

async function updateRecruitField(recruitId, field, value) {
  try {
    const data = await recruitingApi('updateRecruit', { recruitId, [field]: value });
    const i = TEAM_MGMT.recruits.findIndex(r => r.id === recruitId);
    if (i >= 0) TEAM_MGMT.recruits[i] = data.recruit;
    if (field === 'contactedAt') { // re-sort, newest contact first -- once they're done with the picker
      sortRecruits();
      renderRecruitsUnlessEditing();
      return;
    }
    // A status change can move the row between filters (or add the Add to
    // roster button); a notes edit doesn't need a re-render.
    if (field !== 'notes') renderRecruitTab();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
    renderRecruits(); // put the control back to the saved value
  }
}

// The ✕ on a recruit works like Reject on an application: an optional note
// for the other officers, then they move to Rejected -- kept on record, so
// re-adding them later says they were already rejected.
async function rejectRecruit(recruitId) {
  const r = TEAM_MGMT.recruits.find(x => x.id === recruitId);
  if (!r) return;
  const note = prompt(`Reject ${r.name}? Optional note for the other officers:`, '');
  if (note === null) return;
  const reason = note.trim();
  const changes = { recruitId, status: 'rejected' };
  if (reason) changes.notes = [r.notes, `Rejected: ${reason}`].filter(Boolean).join(' · ').slice(0, 500);
  try {
    const data = await recruitingApi('updateRecruit', changes);
    const i = TEAM_MGMT.recruits.findIndex(x => x.id === recruitId);
    if (i >= 0) TEAM_MGMT.recruits[i] = data.recruit;
    renderRecruitTab();
    showToast(`${r.name} moved to Rejected`, 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// Only from Rejected (the ✕ there): removes them and their notes and scores.
async function deleteRecruit(recruitId) {
  const r = TEAM_MGMT.recruits.find(x => x.id === recruitId);
  if (!r) return;
  if (!confirm(`Delete ${r.name} permanently? Their notes and scores are removed, and nothing will show they were rejected if they're added again.`)) return;
  try {
    await recruitingApi('deleteRecruit', { recruitId });
    TEAM_MGMT.recruits = TEAM_MGMT.recruits.filter(x => x.id !== recruitId);
    renderRecruitTab();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// Joined -> hands off to the existing Add Character modal, pre-filled the
// same way pickGuildCharacter pre-fills it from the guild roster.
function addRecruitToRoster(recruitId) {
  const r = TEAM_MGMT.recruits.find(x => x.id === recruitId);
  if (!r) return;
  openAddCharacterModal();
  CHARACTER_MODAL_JOIN_SOURCE = 'recruit';
  document.getElementById('cm-name').value = r.name;
  if (r.class && CLASS_COLORS[r.class]) {
    document.getElementById('cm-class').value = r.class;
    populateSpecDropdown(r.class, r.spec, r.role);
  }
  CHARACTER_LOOKUP.key = characterLookupKey(r.name, r.realm); // their recruit entry already has the right spec
  document.getElementById('cm-server').value = r.realm;
  const msg = document.getElementById('cm-msg');
  msg.textContent = `Filled in from ${r.name}'s recruit entry. Check the spec and rank, then Save.`;
  msg.className   = 'status-msg';
}

// ── Message templates ──
function fillRecruitTemplate(body, recruit) {
  return body
    .replace(/\{name\}/gi,  () => recruit?.name  || '{name}')
    .replace(/\{realm\}/gi, () => recruit?.realm || '{realm}')
    .replace(/\{guild\}/gi, () => STATE.config?.guild || '{guild}');
}

function templateLengthNote(len) {
  if (len > MAIL_CHAR_LIMIT)    return { level: 'error', text: `${len} characters: too long for in-game mail (${MAIL_CHAR_LIMIT} max)` };
  if (len > WHISPER_CHAR_LIMIT) return { level: 'warn',  text: `${len} characters: fits in-game mail, too long for a whisper (${WHISPER_CHAR_LIMIT} max)` };
  return { level: 'ok', text: `${len} characters: fits a whisper or in-game mail` };
}

async function copyRecruitText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    prompt('Copy this message:', text);
    return false;
  }
}

async function copyTemplateForRecruit(templateId, recruitId) {
  if (!templateId) return;
  const t = TEAM_MGMT.templates.find(x => x.id === templateId);
  const r = TEAM_MGMT.recruits.find(x => x.id === recruitId);
  if (!t || !r) return;
  const text = fillRecruitTemplate(t.body, r);
  if (await copyRecruitText(text)) {
    const note = templateLengthNote(text.length);
    showToast(`Copied "${t.title}" for ${r.name}. ${note.text}`, note.level === 'error' ? 'error' : 'success');
  }
}

async function copyTemplateRaw(templateId) {
  const t = TEAM_MGMT.templates.find(x => x.id === templateId);
  if (t && await copyRecruitText(fillRecruitTemplate(t.body, null))) showToast(`Copied "${t.title}"`, 'success');
}

function renderRecruitTemplates() {
  const wrap = document.getElementById('recruit-template-list');
  if (!wrap) return;
  if (TEAM_MGMT.templates.length === 0) {
    wrap.innerHTML = `<div style="font-size:13px; color:var(--text-dim);">No templates yet. Save the messages you send most often, then copy them from any recruit's row with their name already filled in.</div>`;
    return;
  }
  wrap.innerHTML = TEAM_MGMT.templates.map(t => {
    const note = templateLengthNote(t.body.length);
    return `<div class="template-card">
      <div class="template-card-header">
        <div class="template-card-title">${escapeHtml(t.title)}</div>
        <div style="display:flex; gap:8px;">
          <button class="btn-secondary recruit-small-btn" onclick="copyTemplateRaw(${jsAttr(t.id)})">Copy</button>
          <button class="btn-secondary recruit-small-btn" onclick="openRecruitTemplateModal(${jsAttr(t.id)})">Edit</button>
        </div>
      </div>
      <div class="template-card-body">${escapeHtml(t.body)}</div>
      <div class="template-count ${note.level}">${escapeHtml(note.text)}</div>
    </div>`;
  }).join('');
}

function openRecruitTemplateModal(templateId) {
  const t = templateId ? TEAM_MGMT.templates.find(x => x.id === templateId) : null;
  TEAM_MGMT.editingTemplateId = t ? t.id : null;
  document.getElementById('rt-modal-title').textContent  = t ? 'Edit template' : 'New template';
  document.getElementById('rt-title').value              = t ? t.title : '';
  document.getElementById('rt-body').value               = t ? t.body  : '';
  document.getElementById('rt-delete-btn').style.display = t ? 'inline-block' : 'none';
  document.getElementById('rt-msg').textContent          = '';
  updateTemplateCharCount();
  document.getElementById('recruit-template-modal').classList.add('open');
}

function closeRecruitTemplateModal() {
  document.getElementById('recruit-template-modal').classList.remove('open');
}

function updateTemplateCharCount() {
  const note = templateLengthNote(document.getElementById('rt-body').value.length);
  const el   = document.getElementById('rt-count');
  el.textContent = `${note.text} (placeholders count as written)`;
  el.className   = 'template-count ' + note.level;
}

async function saveRecruitTemplate() {
  const title = document.getElementById('rt-title').value.trim();
  const body  = document.getElementById('rt-body').value.trim();
  const msg   = document.getElementById('rt-msg');
  if (!title || !body) {
    msg.textContent = 'Add a title and a message.';
    msg.className   = 'status-msg error';
    return;
  }
  msg.textContent = 'Saving...';
  msg.className   = 'status-msg loading';
  try {
    const data = await recruitingApi('saveTemplate', { templateId: TEAM_MGMT.editingTemplateId, title, body });
    const i = TEAM_MGMT.templates.findIndex(x => x.id === data.template.id);
    if (i >= 0) TEAM_MGMT.templates[i] = data.template;
    else TEAM_MGMT.templates.push(data.template);
    closeRecruitTemplateModal();
    renderRecruitTab(); // each row's "Copy template" menu lists the titles
  } catch (e) {
    msg.textContent = e.message;
    msg.className   = 'status-msg error';
  }
}

async function deleteRecruitTemplate() {
  const id = TEAM_MGMT.editingTemplateId;
  if (!id || !confirm('Delete this template?')) return;
  try {
    await recruitingApi('deleteTemplate', { templateId: id });
    TEAM_MGMT.templates = TEAM_MGMT.templates.filter(x => x.id !== id);
    closeRecruitTemplateModal();
    renderRecruitTab();
  } catch (e) {
    const msg = document.getElementById('rt-msg');
    msg.textContent = e.message;
    msg.className   = 'status-msg error';
  }
}

// ── Recruit WCL scores ──
// Same Performance / Oppo-Parse / First Kill data and table as the roster's
// WCL Scores tab (fetchCharacterWclScores + buildScoresTableHtml). Stored
// per recruit per difficulty through api/recruiting.js, so every officer
// sees them without refetching.
function setRecruitScoreView(view, btn) {
  TEAM_MGMT.scoreView    = view;
  TEAM_MGMT.scoreSortCol = 'best';
  document.querySelectorAll('#recruit-score-view-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderRecruitScores();
}

function setRecruitScoreDifficulty(diff, btn) {
  TEAM_MGMT.scoreDifficulty = diff;
  document.querySelectorAll('#recruit-difficulty-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderRecruitScores();
}

function setRecruitScoreSort(column) {
  TEAM_MGMT.scoreSortCol = column;
  renderRecruitScores();
}

// Only counts as this recruit's score if it was fetched for the zone the
// team is on now -- numbers from an older tier aren't "their score".
function recruitScoreEntry(r) {
  const entry = r.wcl_scores?.[TEAM_MGMT.scoreDifficulty];
  return entry && entry.zoneId === STATE.zoneId ? entry : null;
}

function renderRecruitScores() {
  const wrap = document.getElementById('recruit-scores-wrap');
  if (!wrap) return;
  if (!STATE.config?.hasWclCredentials) { wrap.innerHTML = wclNotConnectedHtml(); return; }

  const list = visibleRecruits();
  if (list.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📊</div><h3>No recruits to show</h3><p>Add recruits in the List view, or change the filter above.</p></div>';
    return;
  }

  let bossNames = [];
  const rows = list.map(r => {
    const entry = recruitScoreEntry(r);
    if ((entry?.bossNames?.length || 0) > bossNames.length) bossNames = entry.bossNames;
    return {
      // 'N/A' defaults keep not-yet-fetched rows blank rather than grey-shaded.
      bestAvg: 'N/A', medianAvg: 'N/A', oppoBestAvg: 'N/A', oppoMedianAvg: 'N/A',
      ...(entry?.result || {}),
      name:          r.name,
      server:        r.realm_slug,
      serverDisplay: r.realm,
      class:         r.class,
      role:          r.role || 'dps',
    };
  });
  if (bossNames.length === 0 && STATE.bossIdsZoneId === STATE.zoneId) bossNames = STATE.bossOrder || [];

  const diffLabel    = difficultyInfo(TEAM_MGMT.scoreDifficulty).label;
  const unfetched    = list.filter(r => !recruitScoreEntry(r)).length;
  const fetchedTimes = list.map(r => recruitScoreEntry(r)?.fetchedAt).filter(Boolean);
  const note = unfetched > 0
    ? `${unfetched} of ${list.length} haven't been fetched for ${diffLabel} yet. Click Refresh Scores.`
    : fetchedTimes.length ? `Last refreshed ${formatTimeAgo(Math.max(...fetchedTimes))}.` : '';

  wrap.innerHTML = (note ? `<div class="recruit-scores-note">${escapeHtml(note)}</div>` : '') + buildScoresTableHtml({
    scores:      rows,
    bossNames,
    view:        TEAM_MGMT.scoreView,
    sortCol:     TEAM_MGMT.scoreSortCol,
    sortHandler: 'setRecruitScoreSort',
    showRaw:     false,
    nameClick:   null,
  });
}

async function refreshRecruitScores() {
  if (!STATE.config?.hasWclCredentials) { renderRecruitScores(); return; }
  const list = visibleRecruits();
  if (list.length === 0) { showToast('No recruits in this filter to refresh.', ''); return; }
  await fetchRecruitScores(list);
}

// One character at a time, with the same 200ms spacing the roster uses,
// against the team's own WCL credentials.
async function fetchRecruitScores(recruits, { silent = false } = {}) {
  if (TEAM_MGMT.scoresInFlight) {
    if (!silent) showToast('Already refreshing recruit scores. Wait for it to finish.', '');
    return;
  }
  const zoneId = STATE.zoneId;
  if (!zoneId) {
    if (!silent) showToast('This team has no current raid zone set yet.', 'error');
    return;
  }
  TEAM_MGMT.scoresInFlight = true;
  const btn        = document.getElementById('recruit-scores-btn');
  const difficulty = TEAM_MGMT.scoreDifficulty;
  const { wcl: diffId, size } = difficultyInfo(difficulty);
  const region     = toWclRegion(STATE.config.region);
  let ok = 0;
  try {
    const { bossIds, bossOrder } = await ensureZoneBosses(zoneId);
    for (let i = 0; i < recruits.length; i++) {
      const r = recruits[i];
      if (btn) { btn.disabled = true; btn.textContent = `⏳ ${i + 1} / ${recruits.length}...`; }
      const { result } = await fetchCharacterWclScores(
        { name: r.name, server: r.realm_slug, role: r.role || 'dps' },
        { zoneId, diffId, size, region, bossIds, bossOrder });
      try {
        const saved = await recruitingApi('saveRecruitScores', {
          recruitId: r.id, difficulty, entry: { zoneId, bossNames: bossOrder, result },
        });
        const local = TEAM_MGMT.recruits.find(x => x.id === r.id);
        if (local) local.wcl_scores = saved.wclScores;
        if (!result.error) ok++;
      } catch (e) { /* counted as not refreshed below */ }
      if (TEAM_MGMT.view === 'scores') renderRecruitScores();
      if (!result.error) await sleep(200);
    }
    if (!silent) {
      showToast(`Scores refreshed for ${ok} of ${recruits.length} recruit${recruits.length === 1 ? '' : 's'}.`, ok === 0 ? 'error' : 'success');
    }
  } finally {
    TEAM_MGMT.scoresInFlight = false;
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh Scores'; }
    if (TEAM_MGMT.view === 'scores') renderRecruitScores();
  }
}

// ── Applicants ──
// A triage inbox over the guild's existing Google Form: every response
// either gets rejected or promoted with "Add to Recruitment". Anything
// still under "Needs decision" hasn't been looked at yet. The answers
// themselves stay in the Google Sheet (read through api/recruiting.js);
// only the decisions are stored in RaidLead.
const APPLICANT_FIELD_LABELS = {
  character: 'Character (Name-Realm)',
  classSpec: 'Class and spec',
  contact:   'BattleTag / Discord',
  wcl:       'Warcraft Logs link',
  raiderio:  'Raider.io link',
  armory:    'Armory link',
  timestamp: 'Timestamp',
};

async function loadApplications(force) {
  const btn    = document.getElementById('applicant-refresh-btn');
  const listEl = document.getElementById('applicant-list');
  if (force && btn) { btn.disabled = true; btn.textContent = '⏳ Refreshing...'; }
  if (!TEAM_MGMT.applications && listEl) {
    listEl.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Loading applications...</div></div>';
  }
  try {
    TEAM_MGMT.applications = await recruitingApi('listApplications', { force: !!force });
  } catch (e) {
    TEAM_MGMT.applications = { serverReady: true, configured: true, error: e.message, applications: [] };
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
  }
  renderApplicants();
}

function findApplication(key) {
  return TEAM_MGMT.applications?.applications?.find(a => a.key === key) || null;
}

function setApplicantFilter(filter, btn) {
  TEAM_MGMT.applicantFilter = filter;
  TEAM_MGMT.selectedApplicants.clear(); // never act on rows you can't see
  document.querySelectorAll('#applicant-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderApplicants();
}

const RESOLVE_TOOLTIP = "Mark as already handled outside RaidLead -- e.g. they're already on the roster, or they left. "
  + "No recruit is created and nobody is rejected. Shows as \"On roster\" or \"Not on roster\" based on your current roster. You can undo it.";

// Whether this applicant's character is on the team's active roster right
// now. Exact name match (not accent-folded -- Häzey and Hazey are different
// characters), plus the realm when the application gives one.
function applicantOnRoster(a) {
  const summary = TEAM_MGMT.applicantLookups[a.key]?.summary;
  const name = (summary?.name || a.name || '').trim().toLowerCase();
  if (!name) return false;
  const slug = realmSlugClient(summary?.realmName || a.realm);
  return (STATE.players || []).some(p =>
    (p.name || '').trim().toLowerCase() === name && (!slug || (p.server || '') === slug));
}

function toggleApplicantSettings() {
  TEAM_MGMT.applicantSettingsOpen = !TEAM_MGMT.applicantSettingsOpen;
  renderApplicantSettings();
}

function renderApplicantCount() {
  const el = document.getElementById('applicant-pending-count');
  if (!el) return;
  const pending = (TEAM_MGMT.applications?.applications || []).filter(a => a.decision === 'pending').length;
  el.textContent = pending > 0 ? String(pending) : '';
  el.style.display = pending > 0 ? '' : 'none';
}

// Client-side twin of lib/serverSlug.js's slugifyServer, for building links.
function realmSlugClient(realm) {
  return String(realm || '').toLowerCase().replace(/\s+/g, '-').replace(/'/g, '').replace(/[^a-z0-9-]/g, '');
}

function renderApplicants() {
  renderApplicantCount();
  renderApplicantSettings();
  const wrap = document.getElementById('applicant-list');
  const data = TEAM_MGMT.applications;
  if (!wrap || !data) return;

  // Not connected yet -- the settings panel above is the whole page.
  if (!data.serverReady || !data.configured || data.error) { // an error shows in the settings panel, next to how to fix it
    wrap.innerHTML = '';
    renderApplicantBulkBar([]);
    return;
  }

  const all = data.applications || [];
  if (all.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><h3>No applications yet</h3><p>New responses to your application form show up here automatically.</p></div>';
    renderApplicantBulkBar([]);
    return;
  }
  const list = all.filter(a => TEAM_MGMT.applicantFilter === 'all' || a.decision === TEAM_MGMT.applicantFilter);
  const pendingVisible = list.filter(a => a.decision === 'pending');
  // Drop selections that are no longer pending/visible (e.g. decided elsewhere).
  const visibleKeys = new Set(pendingVisible.map(a => a.key));
  [...TEAM_MGMT.selectedApplicants].forEach(k => { if (!visibleKeys.has(k)) TEAM_MGMT.selectedApplicants.delete(k); });
  renderApplicantBulkBar(pendingVisible);

  if (list.length === 0) {
    wrap.innerHTML = `<div class="recruit-empty-filter">${TEAM_MGMT.applicantFilter === 'pending'
      ? 'All caught up -- every application has a decision.'
      : 'No applications match this filter.'}</div>`;
    return;
  }

  const region = toWclRegion(STATE.config?.region || 'us');
  wrap.innerHTML = list.map(a => {
    const lk      = TEAM_MGMT.applicantLookups[a.key];
    const summary = lk?.summary || null;
    const cls     = summary?.class || a.class;
    const color   = CLASS_COLORS[cls] || 'var(--text)';
    const name    = summary?.name || a.name;
    const realm   = summary?.realmName || a.realm;
    const slug    = realmSlugClient(realm);
    const days    = daysSinceDate(a.submittedDate);
    const ago     = days == null ? '' : days <= 0 ? 'today' : `${days}d ago`;

    // After a rename or transfer, the links they pasted into the form point
    // at a character that no longer exists (Raider.io and the Armory error
    // out), so build them from the current name instead.
    const renamed = summary?.renamedFrom || null;
    const given   = renamed ? {} : (a.links || {});
    const built = characterLinks(name, slug, summary?.profileUrl);
    const links = {
      raiderio: built.raiderio || given.raiderio || null,
      wcl:      given.wcl    || built.wcl,
      armory:   given.armory || built.armory,
    };
    const linkHtml = [['Raider.io', links.raiderio], ['WCL', links.wcl], ['Armory', links.armory]]
      .filter(([, url]) => url && /^https?:\/\//.test(url))
      .map(([label, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`).join('');

    let statLine = '';
    if (summary) statLine = recruitStatLine(summary.spec, summary.class, summary) || 'Not found on Raider.io';
    else if (lk === 'loading') statLine = 'Looking up on Raider.io...';
    else if (lk && !summary && name && realm) statLine = 'Not found on Raider.io';

    const pending  = a.decision === 'pending';
    const onRoster = applicantOnRoster(a);
    const badges = (pending && onRoster
        ? `<span class="recruit-badge on-roster" title="This character is on your active roster -- Resolve is probably what you want">On roster</span>` : '')
      + (pending && lk?.existing
        ? `<span class="recruit-badge" title="Already in Recruits -- adding them links this application to that entry">In Recruits</span>` : '');

    const by = a.decidedBy ? ' by ' + escapeHtml(a.decidedBy) : '';
    let decisionHtml = '';
    if (a.decision === 'promoted') {
      decisionHtml = `<div class="applicant-decision promoted">Added to Recruits${by}${a.recruitId ? '' : ' (since removed)'}</div>`;
    } else if (a.decision === 'rejected') {
      decisionHtml = `<div class="applicant-decision rejected">Rejected${by}</div>`
        + (a.rejectNote ? `<div class="recruit-sub">"${escapeHtml(a.rejectNote)}"</div>` : '');
    } else if (a.decision === 'resolved') {
      // Worked out from today's roster, so it stays true if they join or leave later.
      decisionHtml = `<div class="applicant-decision resolved${onRoster ? ' on-roster' : ''}" title="${escapeHtml(RESOLVE_TOOLTIP)}">`
        + `Resolved · ${onRoster ? 'On roster' : 'Not on roster'}</div>`
        + (a.decidedBy ? `<div class="recruit-sub">by ${escapeHtml(a.decidedBy)}</div>` : '');
    }

    // Whichever action is likely -- Resolve when they're already on the
    // roster, otherwise Add to Recruitment -- gets the highlighted button.
    const promoteBtn = cls => `<button class="${cls} recruit-small-btn" onclick="promoteApplication(${jsAttr(a.key)})">Add to Recruitment</button>`;
    const resolveBtn = cls => `<button class="${cls} recruit-small-btn" title="${escapeHtml(RESOLVE_TOOLTIP)}" onclick="resolveApplication(${jsAttr(a.key)})">Resolve</button>`;
    const actions = pending
      ? (onRoster ? resolveBtn('btn-primary') + promoteBtn('btn-secondary') : promoteBtn('btn-primary') + resolveBtn('btn-secondary'))
        + `<button class="btn-secondary recruit-small-btn applicant-reject" onclick="rejectApplication(${jsAttr(a.key)})">Reject</button>`
      : (a.decision === 'rejected' || a.decision === 'resolved')
        ? `<button class="btn-secondary recruit-small-btn" title="Move back to Needs decision" onclick="undoApplicationDecision(${jsAttr(a.key)})">Undo</button>`
        : '';

    const selectCell = pending
      ? `<input type="checkbox" class="applicant-check" aria-label="Select ${escapeHtml(name || 'application')}"
           ${TEAM_MGMT.selectedApplicants.has(a.key) ? 'checked' : ''} onchange="toggleApplicantSelected(${jsAttr(a.key)}, this.checked)" />`
      : '<span></span>';

    return `
      <div class="recruit-row applicant-row${pending ? '' : ' closed'}${TEAM_MGMT.selectedApplicants.has(a.key) ? ' selected' : ''}">
        ${selectCell}
        <div class="recruit-main">
          <div class="recruit-name-line">
            <span class="recruit-name" style="color:${color};">${escapeHtml(name || 'No character given')}</span>
            <span class="recruit-realm">${escapeHtml(realm || 'realm not given')}</span>
            ${renamed ? `<span class="recruit-renamed" title="${escapeHtml(RENAMED_TOOLTIP)}">applied as ${escapeHtml(formerCharacterText(renamed))}</span>` : ''}
            ${badges}
          </div>
          <div class="recruit-sub">${escapeHtml([a.classSpec, a.contact].filter(Boolean).join(' · ') || '—')}</div>
          ${statLine ? `<div class="recruit-sub">${escapeHtml(statLine)}</div>` : ''}
          ${linkHtml ? `<div class="recruit-links">${linkHtml}</div>` : ''}
        </div>
        <div class="recruit-contact">
          <div>Applied ${escapeHtml(formatRecruitDate(a.submittedDate))} <span class="recruit-sub">· ${ago}</span></div>
          ${decisionHtml}
        </div>
        <div class="applicant-actions">
          <button class="btn-secondary recruit-small-btn" onclick="openApplicationModal(${jsAttr(a.key)})">View application</button>
          ${actions}
        </div>
      </div>`;
  }).join('');

  enrichApplicants(list.filter(a => a.decision === 'pending'));
}

async function runWithConcurrency(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// Raider.io stats (and "already in Recruits") for pending applicants,
// fetched a few at a time after the list is on screen, once per session.
async function enrichApplicants(apps) {
  const todo = apps.filter(a => a.name && a.realm && TEAM_MGMT.applicantLookups[a.key] === undefined);
  if (todo.length === 0) return;
  todo.forEach(a => { TEAM_MGMT.applicantLookups[a.key] = 'loading'; });
  await runWithConcurrency(todo, 4, async a => {
    try {
      // Their WCL link lets the server find them again after a rename.
      const data = await recruitingApi('lookupCharacter', { name: a.name, realm: a.realm, wclUrl: a.links?.wcl || null });
      TEAM_MGMT.applicantLookups[a.key] = { summary: data.summary, existing: data.existing };
    } catch (e) {
      TEAM_MGMT.applicantLookups[a.key] = { summary: null, existing: null };
    }
  });
  renderApplicants();
}

// "Vuk-Sargeras" / "Vuk Sargeras" / "Vuk-Azjol-Nerub" -> { name, realm } --
// same rules as lib/applications.js's parseCharacterText.
function splitNameRealm(text) {
  const m = String(text || '').trim().match(/^([^\s\-\/(,@]+)\s*[-\/(,@ ]\s*(.+?)\)?$/);
  return m ? { name: m[1], realm: m[2].trim() } : null;
}

async function promoteApplication(key, override) {
  const app = findApplication(key);
  if (!app) return;
  const body = { responseKey: key, ...(override || {}) };

  // Couldn't read a Name-Realm out of their answers -- ask the officer.
  if (!override && (!app.name || !app.realm)) {
    const typed = prompt('Which character is this? Enter it as Name-Realm (for example Vuk-Sargeras):', app.name ? app.name + '-' : '');
    if (typed === null) return;
    const parsed = splitNameRealm(typed);
    if (!parsed) { showToast('Enter it as Name-Realm, for example Vuk-Sargeras.', 'error'); return; }
    return promoteApplication(key, parsed);
  }

  try {
    const data = await recruitingApi('promoteApplication', body);
    applyPromotion(app, data.recruit);
    renderApplicants();
    renderRecruitTab();
    showToast(data.linked
      ? `${data.recruit.name} was already in Recruits -- linked their application`
      : `${data.recruit.name} added to Recruits`, 'success');
    if (STATE.config?.hasWclCredentials && STATE.zoneId) fetchRecruitScores([data.recruit], { silent: true });
  } catch (e) {
    if (e.data?.needsCharacter && !override) {
      const typed = prompt('Which character is this? Enter it as Name-Realm (for example Vuk-Sargeras):', '');
      const parsed = typed && splitNameRealm(typed);
      if (parsed) return promoteApplication(key, parsed);
      return;
    }
    showToast('Error: ' + e.message, 'error');
    if (e.status === 409) loadApplications(true); // someone else decided first -- show what they chose
  }
}

// Local bookkeeping after a successful promote (single or bulk).
function applyPromotion(app, recruit) {
  app.decision  = 'promoted';
  app.recruitId = recruit.id;
  app.decidedBy = 'you';
  TEAM_MGMT.selectedApplicants.delete(app.key);
  const i = TEAM_MGMT.recruits.findIndex(r => r.id === recruit.id);
  if (i >= 0) TEAM_MGMT.recruits[i] = recruit; else TEAM_MGMT.recruits.push(recruit);
  sortRecruits();
}

// Reject or Resolve one or more applications in a single request. The
// server skips any another officer already decided; those get reloaded so
// this officer sees what was chosen.
async function decideApplications(decision, keys, note) {
  const action = decision === 'rejected' ? 'rejectApplication' : 'resolveApplications';
  const data = await recruitingApi(action, { responseKeys: keys, note });
  for (const key of data.decided || []) {
    const app = findApplication(key);
    if (!app) continue;
    app.decision   = decision;
    app.rejectNote = decision === 'rejected' ? ((note || '').trim() || null) : null;
    app.decidedBy  = 'you';
    TEAM_MGMT.selectedApplicants.delete(key);
  }
  if ((data.skipped || []).length) {
    showToast(`${data.skipped.length} already had a decision from another officer. Refreshing.`, '');
    loadApplications(true);
  }
  renderApplicants();
  return data;
}

async function rejectApplication(key) {
  const app = findApplication(key);
  if (!app) return;
  const note = prompt(`Reject ${app.name || 'this applicant'}? Optional note for the other officers:`, '');
  if (note === null) return;
  try {
    await decideApplications('rejected', [key], note);
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
    if (e.status === 409) loadApplications(true);
  }
}

async function resolveApplication(key) {
  try {
    await decideApplications('resolved', [key]);
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
    if (e.status === 409) loadApplications(true);
  }
}

async function undoApplicationDecision(key) {
  const app = findApplication(key);
  if (!app) return;
  try {
    await recruitingApi('undoApplicationDecision', { responseKey: key });
    app.decision   = 'pending';
    app.rejectNote = null;
    app.decidedBy  = null;
    renderApplicants();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Bulk selection ──
function toggleApplicantSelected(key, checked) {
  if (checked) TEAM_MGMT.selectedApplicants.add(key); else TEAM_MGMT.selectedApplicants.delete(key);
  renderApplicants();
}

function selectAllApplicants(checked) {
  const visiblePending = (TEAM_MGMT.applications?.applications || []).filter(a =>
    a.decision === 'pending' && (TEAM_MGMT.applicantFilter === 'all' || TEAM_MGMT.applicantFilter === 'pending'));
  TEAM_MGMT.selectedApplicants = new Set(checked ? visiblePending.map(a => a.key) : []);
  renderApplicants();
}

function selectedPendingApplications() {
  return [...TEAM_MGMT.selectedApplicants].map(findApplication).filter(a => a && a.decision === 'pending');
}

function renderApplicantBulkBar(pendingVisible) {
  const bar = document.getElementById('applicant-bulk-bar');
  if (!bar) return;
  if (!pendingVisible.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  const n = selectedPendingApplications().length;
  const allChecked = n > 0 && n === pendingVisible.length;
  const busy = TEAM_MGMT.bulkInFlight ? ' disabled' : '';
  bar.style.display = '';
  bar.innerHTML = `
    <label class="applicant-select-all">
      <input type="checkbox" ${allChecked ? 'checked' : ''}${busy} onchange="selectAllApplicants(this.checked)" />
      ${n ? `${n} selected` : 'Select all'}
    </label>
    ${n ? `<div class="applicant-bulk-actions">
      <button class="btn-primary recruit-small-btn" id="bulk-promote-btn"${busy} onclick="bulkPromoteApplications()">Add to Recruitment</button>
      <button class="btn-secondary recruit-small-btn"${busy} title="${escapeHtml(RESOLVE_TOOLTIP)}" onclick="bulkDecideApplications('resolved')">Resolve</button>
      <button class="btn-secondary recruit-small-btn applicant-reject"${busy} onclick="bulkDecideApplications('rejected')">Reject</button>
      <button class="applicant-clear-selection"${busy} onclick="selectAllApplicants(false)">Clear</button>
    </div>` : ''}`;
}

async function bulkDecideApplications(decision) {
  const apps = selectedPendingApplications();
  if (!apps.length) return;
  let note = null;
  if (decision === 'rejected') {
    note = prompt(`Reject ${apps.length} application${apps.length === 1 ? '' : 's'}? Optional note for the other officers (applies to all of them):`, '');
    if (note === null) return;
  } else if (!confirm(`Resolve ${apps.length} application${apps.length === 1 ? '' : 's'}? They move to Resolved -- you can undo any of them from there.`)) {
    return;
  }
  TEAM_MGMT.bulkInFlight = true;
  renderApplicants();
  try {
    const data = await decideApplications(decision, apps.map(a => a.key), note);
    const done = (data.decided || []).length;
    showToast(`${decision === 'rejected' ? 'Rejected' : 'Resolved'} ${done} application${done === 1 ? '' : 's'}`, 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    TEAM_MGMT.bulkInFlight = false;
    renderApplicants();
  }
}

// One at a time: each promote does a Raider.io lookup and creates a recruit,
// so a big batch done server-side could hit the host's time limit.
// Applications with no readable realm are skipped -- those need the
// one-at-a-time flow, which asks for Name-Realm.
async function bulkPromoteApplications() {
  const apps = selectedPendingApplications();
  if (!apps.length) return;
  const ready     = apps.filter(a => a.name && a.realm);
  const needRealm = apps.length - ready.length;
  if (!ready.length) { showToast("None of the selected applications list a realm. Add those one at a time.", 'error'); return; }
  if (!confirm(`Add ${ready.length} application${ready.length === 1 ? '' : 's'} to Recruitment?`
      + (needRealm ? `\n\n${needRealm} without a realm will be skipped. Add those one at a time.` : ''))) return;

  TEAM_MGMT.bulkInFlight = true;
  renderApplicants();
  const added = [];
  let failed = 0;
  for (let i = 0; i < ready.length; i++) {
    const btn = document.getElementById('bulk-promote-btn');
    if (btn) btn.textContent = `⏳ ${i + 1} / ${ready.length}...`;
    try {
      const data = await recruitingApi('promoteApplication', { responseKey: ready[i].key });
      applyPromotion(ready[i], data.recruit);
      added.push(data.recruit);
    } catch (e) {
      failed++;
    }
  }
  TEAM_MGMT.bulkInFlight = false;
  renderApplicants();
  renderRecruitTab();
  showToast(`Added ${added.length} to Recruits`
    + (failed ? `. ${failed} couldn't be added (possibly decided by another officer).` : '')
    + (needRealm ? ` ${needRealm} skipped for a missing realm.` : ''), failed ? 'error' : 'success');
  if (failed) loadApplications(true);
  if (added.length && STATE.config?.hasWclCredentials && STATE.zoneId) fetchRecruitScores(added, { silent: true });
}

// ── Connecting the form's response sheet ──
function renderApplicantSettings() {
  const el = document.getElementById('applicant-settings');
  const d  = TEAM_MGMT.applications;
  if (!el) return;
  if (!d) { el.style.display = 'none'; return; }

  // Setup and errors always show; the field mapping only when asked for.
  const mustShow = !d.serverReady || !d.configured || !!d.error;
  el.style.display = (mustShow || TEAM_MGMT.applicantSettingsOpen) ? '' : 'none';

  if (!d.serverReady) {
    el.innerHTML = `<div class="applicant-setup-title">Google Sheets isn't set up on this RaidLead server yet</div>
      <div class="recruit-sub">The site admin needs to add a Google service account key (the GOOGLE_SERVICE_ACCOUNT_JSON setting in Vercel). Once that's in, this is where you'll connect your application form.</div>`;
    return;
  }

  const shareStep = `
    <div class="applicant-step"><span class="applicant-step-num">1</span><div style="flex:1; min-width:0;">
      <div>Open your application form's <strong>responses spreadsheet</strong> and share it with this address as a <strong>Viewer</strong>:</div>
      <div class="applicant-email-row"><code>${escapeHtml(d.serviceEmail || '')}</code>
        <button class="btn-secondary recruit-small-btn" onclick="copyServiceEmail()">Copy</button></div>
    </div></div>`;
  const urlStep = `
    <div class="applicant-step"><span class="applicant-step-num">2</span><div style="flex:1; min-width:0;">
      <div>Paste the spreadsheet's link:</div>
      <div class="applicant-url-row">
        <input type="text" id="applicant-sheet-url" placeholder="https://docs.google.com/spreadsheets/d/..." autocomplete="off" />
        <button class="btn-primary recruit-small-btn" id="applicant-connect-btn" onclick="connectApplicationSheet()">Connect</button>
      </div>
      <div id="applicant-connect-msg" class="status-msg" style="margin-top:6px;"></div>
    </div></div>`;

  if (!d.configured) {
    el.innerHTML = `<div class="applicant-setup-title">Connect your application form</div>
      <div class="applicant-setup-intro">
        <p>If you use a Google Form to receive applications, the spreadsheet of answers can be linked here.</p>
        <p>Applicants keep using your existing Google Form -- RaidLead just reads its responses so officers can sort through them here.</p>
      </div>
      ${shareStep}${urlStep}`;
    return;
  }

  if (d.error) {
    el.innerHTML = `<div class="applicant-setup-title">Couldn't read your application responses</div>
      <div class="recruit-lookup warn" style="margin:6px 0 14px;">${escapeHtml(d.error)}</div>
      ${shareStep}${urlStep}
      <div style="display:flex; justify-content:flex-end;"><button class="btn-secondary recruit-small-btn" onclick="disconnectApplicationSheet()">Disconnect</button></div>`;
    return;
  }

  const headerOptions = selected => ['<option value="-1">(not in this form)</option>']
    .concat((d.headers || []).map((h, i) => {
      const label = h.length > 70 ? h.slice(0, 70) + '…' : h;
      return `<option value="${i}"${selected === i ? ' selected' : ''}>${escapeHtml(label || `Column ${i + 1}`)}</option>`;
    })).join('');
  const mapFields = Object.entries(APPLICANT_FIELD_LABELS).map(([field, label]) => `
    <div class="form-group"><label>${label}</label>
      <select data-field="${field}">${headerOptions(d.columnMap?.[field] ?? -1)}</select></div>`).join('');

  el.innerHTML = `<div class="applicant-setup-title">Connected: ${escapeHtml(d.sheet?.title || 'Spreadsheet')} › ${escapeHtml(d.sheet?.tab || '')}</div>
    <div class="recruit-sub" style="margin:4px 0 14px;">RaidLead matched your form's questions to these fields automatically. Fix any that are wrong -- every question still shows in full on each application.</div>
    <div class="applicant-map-grid" id="applicant-column-map">${mapFields}</div>
    <div class="recruit-add-footer">
      <div id="applicant-map-msg" class="status-msg"></div>
      <div style="display:flex; gap:8px;">
        <button class="btn-secondary recruit-small-btn" onclick="disconnectApplicationSheet()">Disconnect</button>
        <button class="btn-primary recruit-small-btn" onclick="saveApplicantColumnMap()">Save fields</button>
      </div>
    </div>`;
}

async function copyServiceEmail() {
  const email = TEAM_MGMT.applications?.serviceEmail;
  if (email && await copyRecruitText(email)) showToast('Email copied', 'success');
}

async function connectApplicationSheet() {
  const url = document.getElementById('applicant-sheet-url').value.trim();
  const msg = document.getElementById('applicant-connect-msg');
  if (!url) { msg.textContent = 'Paste the spreadsheet link first.'; msg.className = 'status-msg error'; return; }
  const btn = document.getElementById('applicant-connect-btn');
  btn.disabled = true;
  msg.textContent = 'Connecting...';
  msg.className = 'status-msg loading';
  try {
    TEAM_MGMT.applications = await recruitingApi('saveApplicationSheet', { url });
    TEAM_MGMT.applicantSettingsOpen = true; // show the detected fields so they can be checked
    renderApplicants();
    showToast('Application form connected', 'success');
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'status-msg error';
    btn.disabled = false;
  }
}

async function disconnectApplicationSheet() {
  if (!confirm("Disconnect the application form? Decisions you've already made are kept, and come back if you reconnect the same sheet.")) return;
  try {
    TEAM_MGMT.applications = await recruitingApi('saveApplicationSheet', { url: '' });
    TEAM_MGMT.applicantSettingsOpen = false;
    renderApplicants();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function saveApplicantColumnMap() {
  const columnMap = {};
  document.querySelectorAll('#applicant-column-map select[data-field]').forEach(sel => {
    columnMap[sel.dataset.field] = parseInt(sel.value, 10);
  });
  const msg = document.getElementById('applicant-map-msg');
  msg.textContent = 'Saving...';
  msg.className = 'status-msg loading';
  try {
    TEAM_MGMT.applications = await recruitingApi('saveApplicationColumnMap', { columnMap });
    TEAM_MGMT.applicantLookups = {}; // names may have changed with the new mapping
    renderApplicants();
    const saved = document.getElementById('applicant-map-msg');
    if (saved) { saved.textContent = 'Saved'; saved.className = 'status-msg'; }
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'status-msg error';
  }
}

// ── Full application viewer ──
// URLs in answers become links; everything else is escaped text.
function linkifyText(text) {
  return String(text ?? '').split(/(https?:\/\/[^\s<>"]+)/g).map((part, i) => i % 2
    ? `<a href="${escapeHtml(part)}" target="_blank" rel="noopener noreferrer">${escapeHtml(part)}</a>`
    : escapeHtml(part)).join('');
}

async function openApplicationModal(key) {
  const modal = document.getElementById('application-modal');
  const title = document.getElementById('application-modal-title');
  const body  = document.getElementById('application-modal-body');
  let app = findApplication(key);
  title.textContent = 'Application';
  modal.classList.add('open');
  if (!app) {
    body.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Loading application...</div></div>';
    try {
      app = (await recruitingApi('getApplication', { responseKey: key })).application;
    } catch (e) {
      body.innerHTML = `<div class="recruit-lookup warn">${escapeHtml(e.message)}</div>`;
      return;
    }
  }
  title.textContent = app.name ? `${app.name}'s application` : 'Application';
  body.innerHTML = `<div class="recruit-sub" style="margin-bottom:16px;">Submitted ${escapeHtml(formatRecruitDate(app.submittedDate))}</div>`
    + app.answers.map(qa => `<div class="application-qa">
        <div class="application-q">${escapeHtml(qa.question)}</div>
        <div class="application-a">${linkifyText(qa.answer)}</div>
      </div>`).join('');
}

function closeApplicationModal() {
  document.getElementById('application-modal').classList.remove('open');
}

// ─────────────────────────────────────────────
//  NEXT SEASON SURVEY
// ─────────────────────────────────────────────
// Raiders answer from a banner on their dashboard (any tab, or the account
// menu); officers build the survey and read the results under Team
// Management > Next Season. Always asked: returning?, character, 1st-3rd
// choice class/spec, flex roles, comments. Officer-editable: the intro,
// acknowledgements, extra-night availability, and extra questions. The
// server-side rules are in lib/seasonSurvey.js.

// Must match WEEKDAYS in lib/seasonSurvey.js.
const SURVEY_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SURVEY_STATUS_LABELS = { returning: 'Returning', unsure: 'Not sure yet', not_returning: 'Not returning' };
const SURVEY_ROLES = [['tank', 'Tanks'], ['heal', 'Healers'], ['melee', 'Melee DPS'], ['ranged', 'Ranged DPS']];
const SURVEY_FLEX_LABELS = { tank: 'Tank', heal: 'Healer', melee: 'Melee DPS', ranged: 'Ranged DPS' };
const SURVEY_TYPE_LABELS = { single: 'Multiple choice', checkboxes: 'Checkboxes', short: 'Short answer', paragraph: 'Paragraph', scale: 'Scale' };
const SURVEY_AUDIENCE_LABELS = { returning: 'People returning or not sure', everyone: 'Everyone', not_returning: 'People not returning' };
// The always-asked questions' default wording -- must match FIXED_DEFAULTS in
// lib/seasonSurvey.js.
const SURVEY_FIXED_DEFAULTS = {
  character: { prompt: 'Character' },
  returning: {
    prompt: 'Are you coming back next season?',
    labels: { returning: "Yes, I'm returning", unsure: 'Not sure yet', not_returning: "No, I'm not returning" },
  },
  specs: {
    count: 3,
    prompts: ['First choice class and spec', 'Second choice class and spec', 'Third choice class and spec'],
    hints: [
      '',
      "Optional. Only pick one you'd be happy to play if we asked. You don't need to list other specs of your class that fill the same role -- you can swap between those freely.",
      "Optional. Same idea: only if you'd be happy to play it.",
    ],
  },
  flex:     { enabled: true, prompt: 'Can you flex into another role?' },
  comments: { enabled: true, prompt: 'Any other feedback or comments?' },
};
// What the projected roster is measured against: the version's full raid
// (GAME.compTarget -- Retail's 20-player Mythic group, Classic's 25, ...).

const SURVEY = {
  mine:           null,  // { survey, response } for the signed-in raider, or null
  submitting:     false,
  // Officer dashboard
  surveys:        [],    // every survey this team has run, newest first
  selectedId:     null,
  results:        null,  // { survey, responses } for the selected survey
  responseFilter: 'all', // all | returning | unsure | not_returning
  includeUnsure:  true,  // count "not sure yet" in the projected roster
  editor:         null,  // { mode: 'new' | 'edit', surveyId, title, intro, questions, responseCount }
  prompt:         null,  // officers: { kind: 'ending' | 'started', zoneName, nextName, date } from getSurveyPrompt
};

function surveyDate(ts) {
  return ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}

function surveySpecLabel(choice) {
  return choice ? `${choice.spec} ${titleCaseClass(choice.class)}` : '';
}

// ── Raider side ──

// Back from Battle.net sign-in: ?bnet_sync=started (the character list is
// being read -- checkBnetPrompt waits for it) or no_permission (Battle.net
// didn't share characters). Read once, and taken off the address bar.
let BNET_SYNC_PARAM = null;
function readBnetSyncParam() {
  const params = new URLSearchParams(window.location.search);
  BNET_SYNC_PARAM = params.get('bnet_sync');
  if (!BNET_SYNC_PARAM) return;
  params.delete('bnet_sync');
  const rest = params.toString();
  window.history.replaceState({}, '', '/' + (rest ? '?' + rest : ''));
}

// ── Connect prompt: anyone still signed in from before sign-in asked Battle.net
// for WoW characters (sessions last 30 days) gets a pop-up asking them to allow
// it, since nothing else would send them back through Battle.net. "Not now"
// hides it for 3 days. ──
const BNET_SYNC_PENDING_KEY = 'raidlead_bnet_sync_pending';
const bnetPromptSnoozeKey  = () => `raidlead_bnet_prompt_snoozed_until_${AUTH.session?.id}`;
let BNET_PROMPT_CHECKED = false;
const BNET_SYNC_WAIT_MS = 45000; // longest the page waits for a sign-in's character sync
const BNET_SYNC_POLL_MS = 1500;

// Re-runs Battle.net sign-in to read this player's character list (the first
// time, new characters, renames). Instant once they've allowed it. consent:
// ask Battle.net to show its approval screen again (see api/auth.js).
function syncFromBattleNet(consent) {
  try { sessionStorage.setItem(BNET_SYNC_PENDING_KEY, '1'); } catch (e) {}
  window.location.href = '/api/auth?action=login' + (consent ? '&consent=1' : '');
}

function clearBnetSyncPending() {
  try { sessionStorage.removeItem(BNET_SYNC_PENDING_KEY); } catch (e) {}
}

// Once per page load, after the dashboard has this team's data.
function checkBnetPrompt() {
  if (BNET_PROMPT_CHECKED || !AUTH.session) return;
  let asked = false; // they clicked Connect / Sync (rather than just signing in)
  try { asked = sessionStorage.getItem(BNET_SYNC_PENDING_KEY) === '1'; } catch (e) {}
  if (BNET_SYNC_PARAM) {
    BNET_PROMPT_CHECKED = true;
    clearBnetSyncPending();
    if (BNET_SYNC_PARAM === 'no_permission') return openBnetPermissionHelp();
    return watchBnetSync(asked);
  }
  if (asked) {
    // Back from Connect / Sync without a sync result (Battle.net sent them back early).
    BNET_PROMPT_CHECKED = true;
    clearBnetSyncPending();
    if (AUTH.session.bnetSynced) {
      showToast('Synced with Battle.net', 'success');
    } else {
      snoozeBnetPrompt(1);
      showToast("Couldn't sync with Battle.net. Try again later.", 'error');
    }
    return;
  }
  if (AUTH.session.bnetSynced) { BNET_PROMPT_CHECKED = true; return; }
  let snoozedUntil = 0;
  try { snoozedUntil = Number(localStorage.getItem(bnetPromptSnoozeKey())) || 0; } catch (e) {}
  if (snoozedUntil > Date.now()) { BNET_PROMPT_CHECKED = true; return; }
  // Another pop-up is up (a survey link, Companion login): ask on the next dashboard load.
  if (document.querySelector('.modal-overlay.open')) return;
  BNET_PROMPT_CHECKED = true;
  // Battle.net already turned them down once: the steps that fix it, not another Connect.
  if (AUTH.session.bnetSync?.status === 'no_permission') return openBnetPermissionHelp();
  setViewerNote('bnet-connect-viewer-note');
  document.getElementById('bnet-connect-modal').classList.add('open');
}

// "You're a Viewer on <team> until..." -- only for Viewers.
function setViewerNote(id) {
  const note = document.getElementById(id);
  if (!note) return;
  const viewer = STATE.myRole === 'viewer';
  note.textContent = viewer ? `You're a Viewer on ${currentTeamLabel()} until one of your characters is connected.` : '';
  note.style.display = viewer ? '' : 'none';
}

// Sign-in has gone through; its character sync finishes on the server
// (accounts.wow_sync). Wait for it, then say how it went -- quietly on an
// ordinary sign-in unless characters got connected.
async function watchBnetSync(asked) {
  if (asked) showToast('Syncing your characters with Battle.net…');
  const until = Date.now() + BNET_SYNC_WAIT_MS;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, BNET_SYNC_POLL_MS));
    let sync = null;
    try {
      const resp = await fetch('/api/auth?action=session');
      if (resp.ok) sync = (await resp.json()).account?.wow_sync || null;
    } catch (e) { /* try again next tick */ }
    if (sync && sync.status !== 'syncing') return finishBnetSync(sync, asked);
  }
  return finishBnetSync({ status: 'failed' }, asked); // took too long
}

async function finishBnetSync(sync, asked) {
  AUTH.session.bnetSync = sync;
  if (sync.status === 'no_permission') return openBnetPermissionHelp();
  if (sync.status === 'failed') {
    if (asked) {
      snoozeBnetPrompt(1);
      showToast("Couldn't reach Battle.net just now. Your characters are unchanged -- try Sync again later.", 'error');
    }
    return;
  }
  AUTH.session.bnetSynced = true;
  if (sync.connected?.length) {
    showToast('Connected with Battle.net', 'success');
    await refreshTeamAfterConnect();
  } else if (asked) {
    showToast('Synced with Battle.net', 'success');
  }
}

// Characters were just connected (a Viewer may be a Member now): this team's
// role and roster again.
async function refreshTeamAfterConnect() {
  if (!STATE.teamId) return;
  const data = await fetchGuildFromDB(STATE.teamId);
  if (!data?.team) return;
  applyGuildData(data);
  try { await loadRosterFromDB(); } catch (e) { return; }
  renderRoster();
  updateRosterTitle();
}

// Battle.net didn't share WoW characters: it keeps an approval from before
// RaidLead asked for them. The fix is on their Battle.net account.
function openBnetPermissionHelp() {
  setViewerNote('bnet-permission-viewer-note');
  document.getElementById('bnet-permission-modal').classList.add('open');
}

function closeBnetPermissionHelp(connect) {
  document.getElementById('bnet-permission-modal').classList.remove('open');
  if (connect) return syncFromBattleNet(true);
  snoozeBnetPrompt(3);
}

function snoozeBnetPrompt(days) {
  try { localStorage.setItem(bnetPromptSnoozeKey(), String(Date.now() + days * 86400000)); } catch (e) {}
}

function closeBnetPrompt(connect) {
  document.getElementById('bnet-connect-modal').classList.remove('open');
  if (connect) return syncFromBattleNet();
  snoozeBnetPrompt(3);
}

// ?survey=<teamId> -- the link officers share in Discord -- opens the survey
// once the dashboard has loaded. Stashed first, since a signed-out visitor
// goes through the Battle.net login redirect before getting there.
function checkSurveyParam() {
  const params = new URLSearchParams(window.location.search);
  const teamId = params.get('survey');
  if (!teamId) return;
  params.delete('survey');
  const rest = params.toString();
  window.history.replaceState({}, '', '/' + (rest ? '?' + rest : ''));
  try { localStorage.setItem('raidlead_open_survey', teamId); } catch (e) {}
}

// Called every time the dashboard shows (boot, team switch, after claiming).
async function loadMySurvey() {
  const teamId = STATE.teamId;
  SURVEY.mine = null;
  if (teamId && STATE.myRole && STATE.myRole !== 'viewer') {
    try {
      const data = await recruitingApi('getSurvey');
      if (teamId !== STATE.teamId) return; // switched teams while this was loading
      SURVEY.mine = data.survey ? data : null;
    } catch (e) { /* no banner */ }
  }
  renderSurveyBanner();
  loadSeasonPrompt(); // officers: "season's ending -- survey your raiders?"

  let wanted = null;
  try { wanted = localStorage.getItem('raidlead_open_survey'); } catch (e) {}
  if (!wanted) return;
  if (wanted !== STATE.teamId && (STATE.teams || []).some(t => t.teamId === wanted)) {
    return switchActiveTeam(wanted); // shows the dashboard again, which lands back here
  }
  try { localStorage.removeItem('raidlead_open_survey'); } catch (e) {}
  if (wanted !== STATE.teamId) showToast("That survey link is for a team you're not on.", 'error');
  else if (SURVEY.mine) openSurveyModal();
  else if (STATE.myRole !== 'viewer') showToast("That survey isn't open anymore.", '');
}

// ── Officer nudge: the season is ending (or just ended) and nobody's
// asked the raiders about next season yet. The server decides when
// (see surveyPromptFor in lib/seasonSurvey.js); "Not now" hides it until
// the next season change. ──
async function loadSeasonPrompt() {
  const teamId = STATE.teamId;
  SURVEY.prompt = null;
  if (teamId && ['owner', 'officer'].includes(STATE.myRole)) {
    try {
      const { prompt } = await recruitingApi('getSurveyPrompt');
      if (teamId !== STATE.teamId) return;
      SURVEY.prompt = prompt || null;
    } catch (e) { /* no nudge */ }
  }
  renderSeasonPrompt();
}

const seasonPromptKey = p => `${STATE.teamId}|${p.date}`;

function renderSeasonPrompt() {
  const el = document.getElementById('season-prompt-banner');
  if (!el) return;
  const p = SURVEY.prompt;
  let hidden = false;
  try { hidden = !!p && localStorage.getItem('raidlead_season_prompt_hidden') === seasonPromptKey(p); } catch (e) {}
  if (!p || hidden) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const when = new Date(p.date);
  const days = Math.round((when - Date.now()) / 86400000);
  const dateText = surveyDate(p.date);
  const text = p.kind === 'ending'
    ? `${p.zoneName ? `<strong>${escapeHtml(p.zoneName)}</strong> ends` : 'This raid tier ends'} ${dateText}`
      + `${days > 1 ? ` (in ${days} days)` : days === 1 ? ' (tomorrow)' : ' (today)'}`
      + `${p.nextName ? `, and ${escapeHtml(p.nextName)} is next` : ''}. Want to ask your raiders if they're coming back, and what they'll play?`
    : `A new raid tier${p.zoneName ? `, <strong>${escapeHtml(p.zoneName)}</strong>,` : ''} started ${dateText}, and your raiders haven't been surveyed yet. Want to ask them about the season?`;
  el.style.display = '';
  el.className = 'survey-banner';
  el.innerHTML = `<div class="survey-banner-text">${text}</div>
    <div class="survey-banner-actions">
      <button class="btn-primary recruit-small-btn" onclick="startSurveyFromPrompt()">Create survey</button>
      <button class="btn-secondary recruit-small-btn" onclick="dismissSeasonPrompt()">Not now</button>
    </div>`;
}

function dismissSeasonPrompt() {
  if (SURVEY.prompt) {
    try { localStorage.setItem('raidlead_season_prompt_hidden', seasonPromptKey(SURVEY.prompt)); } catch (e) {}
  }
  renderSeasonPrompt();
}

// Team Management > Next Season, with the survey editor open.
async function startSurveyFromPrompt() {
  showTab('team');
  const btn = [...document.querySelectorAll('#team-subtab-filter .filter-btn')].find(b => (b.getAttribute('onclick') || '').includes("'season'"));
  if (btn) await setTeamSubTab('season', btn);
  if (SURVEY.surveys.some(x => !x.closed_at)) return; // one's already open -- the tab shows it
  openSurveyEditor('new');
}

function surveyBannerHidden(surveyId) {
  try { return localStorage.getItem('raidlead_survey_banner_hidden') === surveyId; } catch (e) { return false; }
}

function dismissSurveyBanner() {
  try { localStorage.setItem('raidlead_survey_banner_hidden', SURVEY.mine?.survey?.id || ''); } catch (e) {}
  renderSurveyBanner();
}

function renderSurveyBanner() {
  const el = document.getElementById('survey-banner');
  const menuBtn = document.getElementById('dropdown-survey-btn');
  const mine = SURVEY.mine;
  if (menuBtn) menuBtn.style.display = mine ? 'block' : 'none';
  if (!el) return;
  // Once answered, the reminder can be hidden -- the account menu still opens it.
  if (!mine || (mine.response && surveyBannerHidden(mine.survey.id))) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const title = escapeHtml(mine.survey.title);
  el.style.display = '';
  el.className = 'survey-banner' + (mine.response ? ' answered' : '');
  el.innerHTML = mine.response
    ? `<div class="survey-banner-text"><strong>${title}</strong> · Thanks, you've answered. You can change your answers until it closes.</div>
       <div class="survey-banner-actions">
         <button class="btn-secondary recruit-small-btn" onclick="openSurveyModal()">Edit my answers</button>
         <button class="survey-banner-dismiss" title="Hide this reminder" aria-label="Hide this reminder" onclick="dismissSurveyBanner()">&times;</button>
       </div>`
    : `<div class="survey-banner-text"><strong>${title}</strong> · Let your officers know if you're coming back next season, and what you'd like to play.</div>
       <div class="survey-banner-actions"><button class="btn-primary recruit-small-btn" onclick="openSurveyModal()">Answer the survey</button></div>`;
}

function surveySpecOptions(selected) {
  return '<option value="">Choose a class and spec</option>' + Object.entries(CLASS_SPECS).map(([cls, specs]) =>
    `<optgroup label="${escapeHtml(titleCaseClass(cls))}">${specs.map(([spec]) => {
      const v = `${cls}|${spec}`;
      return `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(spec)} ${escapeHtml(titleCaseClass(cls))}</option>`;
    }).join('')}</optgroup>`).join('');
}

function openSurveyModal() {
  const mine = SURVEY.mine;
  if (!mine) return;
  document.getElementById('survey-modal-title').textContent = mine.survey.title;
  document.getElementById('survey-modal').classList.add('open');
  renderSurveyForm();
}

function closeSurveyModal() {
  document.getElementById('survey-modal').classList.remove('open');
}

function renderSurveyForm() {
  const { survey, response: r } = SURVEY.mine;
  const { fixed, items } = survey.questions;
  const claimed = (STATE.claimedCharacters || []).filter(c => c.id);
  const status = r?.status || null;
  const answers = r?.answers || {};
  const req = ' <span class="survey-req">*</span>';

  // Which character: one of theirs from the roster, or typed (officers who
  // haven't claimed one).
  const defaultId = r ? r.character_id : (claimed.find(c => (c.rank || 'Main') === 'Main') || claimed[0])?.id;
  const characterHtml = claimed.length
    ? `<select id="sv-character">${claimed.map(c => `<option value="${escapeHtml(c.id)}"${c.id === defaultId ? ' selected' : ''}>${escapeHtml(c.name)}${c.rank && c.rank !== 'Main' ? ` (${escapeHtml(c.rank)})` : ''}</option>`).join('')}</select>`
    : `<input type="text" id="sv-character-name" maxlength="40" autocomplete="off" placeholder="Your main's name" value="${escapeHtml(r?.character_name || STATE.claimedCharacter || '')}" />`;

  const specsHtml = Array.from({ length: fixed.specs.count }, (_, i) => {
    const current = r?.spec_choices?.[i] ? `${r.spec_choices[i].class}|${r.spec_choices[i].spec}` : '';
    return `<div class="survey-q">
      <div class="survey-q-label">${escapeHtml(fixed.specs.prompts[i])}${i === 0 ? req : ''}</div>
      ${fixed.specs.hints[i] ? `<div class="survey-q-hint">${escapeHtml(fixed.specs.hints[i])}</div>` : ''}
      <div class="form-group"><select id="sv-spec-${i}">${surveySpecOptions(current)}</select></div>
    </div>`;
  }).join('');
  const flexHtml = fixed.flex.enabled ? `
    <div class="survey-q">
      <div class="survey-q-label">${escapeHtml(fixed.flex.prompt)}</div>
      <div class="survey-choice-row">${Object.entries(SURVEY_FLEX_LABELS).map(([v, l]) => surveyChoice('checkbox', 'sv-flex', v, l, r?.flex_roles?.includes(v))).join('')}</div>
    </div>` : '';

  document.getElementById('survey-modal-body').innerHTML = `
    ${survey.intro ? `<div class="survey-intro">${linkifyText(survey.intro)}</div>` : ''}
    <div class="survey-q">
      <div class="survey-q-label">${escapeHtml(fixed.character.prompt)}</div>
      <div class="form-group">${characterHtml}</div>
    </div>
    <div class="survey-q">
      <div class="survey-q-label">${escapeHtml(fixed.returning.prompt)}${req}</div>
      <div class="survey-choice-row">
        ${['returning', 'unsure', 'not_returning'].map(s => surveyChoice('radio', 'sv-status', s, fixed.returning.labels[s], status === s, ' onchange="updateSurveyFormVisibility()"')).join('')}
      </div>
    </div>
    <div id="sv-staying-fields">${specsHtml}${flexHtml}</div>
    ${items.map(item => renderSurveyItem(item, answers[item.id])).join('')}
    ${fixed.comments.enabled ? `
      <div class="survey-q">
        <div class="survey-q-label">${escapeHtml(fixed.comments.prompt)}</div>
        <div class="form-group"><textarea id="sv-comments" rows="3" maxlength="2000">${escapeHtml(r?.comments || '')}</textarea></div>
      </div>` : ''}
    <div id="sv-msg" class="status-msg"></div>
    <div class="survey-form-actions">
      <span class="recruit-sub">Only officers can see your answers.</span>
      <button class="btn-secondary" onclick="closeSurveyModal()">Cancel</button>
      <button class="btn-primary" id="sv-submit-btn" onclick="submitSurvey()">${r ? 'Save changes' : 'Send answers'}</button>
    </div>`;
  updateSurveyFormVisibility();
}

// Spec choices and flex only matter to people coming back; each officer
// question shows for the audience it was written for.
function updateSurveyFormVisibility() {
  const status = document.querySelector('input[name="sv-status"]:checked')?.value || null;
  const staying = document.getElementById('sv-staying-fields');
  if (staying) staying.style.display = status === 'not_returning' ? 'none' : '';
  document.querySelectorAll('#survey-modal-body [data-audience]').forEach(el => {
    el.style.display = surveyItemAsked({ audience: el.dataset.audience }, status) ? '' : 'none';
  });
}

function collectSurveyForm(survey) {
  const { fixed, items } = survey.questions;
  const val = id => document.getElementById(id)?.value ?? '';
  const checkedValues = name => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value);
  const answers = {};
  items.forEach(item => {
    const name = 'sv-item-' + item.id;
    if (item.type === 'single') answers[item.id] = checkedValues(name)[0] || null;
    else if (item.type === 'checkboxes') answers[item.id] = checkedValues(name);
    else if (item.type === 'scale') { const v = checkedValues(name)[0]; answers[item.id] = v ? Number(v) : null; }
    else answers[item.id] = val(name);
  });
  const characterSelect = document.getElementById('sv-character');
  return {
    characterId:   characterSelect ? characterSelect.value : null,
    characterName: characterSelect ? null : val('sv-character-name').trim(),
    status:        document.querySelector('input[name="sv-status"]:checked')?.value || null,
    specChoices:   Array.from({ length: fixed.specs.count }, (_, i) => val('sv-spec-' + i)),
    flexRoles:     fixed.flex.enabled ? checkedValues('sv-flex') : [],
    answers,
    comments:      fixed.comments.enabled ? val('sv-comments') : '',
  };
}

// Same checks the server makes, so people hear about a missed question
// before anything is sent.
function surveyFormProblem(body, survey) {
  if (!body.characterId && !body.characterName) return 'Which character is this for?';
  if (!body.status) return "Let us know whether you're coming back.";
  if (body.status !== 'not_returning' && !body.specChoices[0]) return 'Pick your first-choice class and spec.';
  const missing = survey.questions.items.filter(i => i.required && surveyItemAsked(i, body.status) && surveyAnswerBlank(body.answers[i.id]));
  return missing.length ? 'Answer every question marked *.' : null;
}

async function submitSurvey() {
  const mine = SURVEY.mine;
  if (!mine || SURVEY.submitting) return;
  const msg = document.getElementById('sv-msg');
  const btn = document.getElementById('sv-submit-btn');
  const body = collectSurveyForm(mine.survey);
  const problem = surveyFormProblem(body, mine.survey);
  if (problem) { msg.className = 'status-msg error'; msg.textContent = problem; return; }

  SURVEY.submitting = true;
  btn.disabled = true;
  msg.className = 'status-msg loading';
  msg.textContent = 'Sending...';
  try {
    const { response } = await recruitingApi('submitSurveyResponse', { surveyId: mine.survey.id, ...body });
    const first = !mine.response;
    mine.response = response;
    closeSurveyModal();
    renderSurveyBanner();
    showToast(first ? 'Thanks! Your answers were sent to your officers.' : 'Your answers were updated.', 'success');
    // An officer answering their own survey sees it land in the results.
    if (SURVEY.results?.survey?.id === mine.survey.id) loadSeasonTab();
  } catch (e) {
    msg.className = 'status-msg error';
    msg.textContent = e.message;
    if (e.status === 409) loadMySurvey(); // closed (or replaced) while they were answering
  } finally {
    SURVEY.submitting = false;
    btn.disabled = false;
  }
}

// ── Officer side: Team Management > Next Season ──

async function loadSeasonTab() {
  const panel = document.getElementById('season-panel');
  if (!panel) return;
  if (!SURVEY.results && !SURVEY.surveys.length) {
    panel.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Loading surveys...</div></div>';
  }
  try {
    const { surveys } = await recruitingApi('listSurveys');
    SURVEY.surveys = surveys || [];
    if (!SURVEY.surveys.some(s => s.id === SURVEY.selectedId)) SURVEY.selectedId = SURVEY.surveys[0]?.id || null;
    SURVEY.results = SURVEY.selectedId ? await recruitingApi('getSurveyResults', { surveyId: SURVEY.selectedId }) : null;
  } catch (e) {
    panel.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><h3>Couldn't load surveys</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  renderSeasonTab();
}

function selectSeasonSurvey(surveyId) {
  SURVEY.selectedId = surveyId;
  SURVEY.results = null;
  loadSeasonTab();
}

function setSurveyResponseFilter(filter) {
  SURVEY.responseFilter = filter;
  renderSeasonTab();
}

function setSurveyIncludeUnsure(on) {
  SURVEY.includeUnsure = on;
  renderSeasonTab();
}

// Who's expected to answer: the roster's Mains (alts belong to someone
// who answers once). Matched by the character they answered for, or by
// the account that claimed the character.
function surveyTracker(responses) {
  const mains = (STATE.players || []).filter(p => (p.rank || 'Main') === 'Main');
  const answeredChars    = new Set(responses.map(r => r.character_id).filter(Boolean));
  const answeredAccounts = new Set(responses.map(r => r.account_id).filter(Boolean));
  const waiting = mains.filter(p => !answeredChars.has(p.id) && !(p.account_id && answeredAccounts.has(p.account_id)));
  return {
    mains,
    answeredMains: mains.length - waiting.length,
    waitingClaimed:   waiting.filter(p => p.account_id),
    waitingUnclaimed: waiting.filter(p => !p.account_id),
  };
}

// First choices fill the roster; second/third choices and flex roles show
// who could cover a role if needed.
function surveyProjection(responses, includeUnsure) {
  const counted = responses.filter(r => r.status === 'returning' || (includeUnsure && r.status === 'unsure'));
  const byRole = { tank: [], heal: [], melee: [], ranged: [] };
  const flex   = { tank: [], heal: [], melee: [], ranged: [] };
  counted.forEach(r => {
    const main = r.spec_choices?.[0];
    if (!main || !byRole[main.role]) return;
    byRole[main.role].push(r);
    const others = new Set([...(r.spec_choices || []).slice(1).map(c => c.role), ...(r.flex_roles || [])]);
    others.delete(main.role);
    others.forEach(role => flex[role]?.push(r));
  });
  return { counted, byRole, flex };
}

function surveyGaps(projection) {
  const { byRole, counted } = projection;
  const gaps = [];
  const dps = byRole.melee.length + byRole.ranged.length;
  if (byRole.tank.length < GAME.compTarget.tank) gaps.push(`Tanks: ${byRole.tank.length} of ${GAME.compTarget.tank}`);
  if (byRole.heal.length < GAME.compTarget.heal) gaps.push(`Healers: ${byRole.heal.length} of ${GAME.compTarget.heal}`);
  if (dps < GAME.compTarget.dps) gaps.push(`DPS: ${dps} of ${GAME.compTarget.dps}`);
  const projected = counted.map(r => r.spec_choices?.[0]).filter(c => c?.class).map(c => ({ class: c.class, spec: c.spec, role: c.role }));
  const missingBuffs = GAME.raidBuffs.filter(b => !buffCovered(b, projected));
  if (missingBuffs.length) gaps.push('No ' + missingBuffs.map(b => (b.providers.length === 1 && !b.providers[0].spec
    ? `${titleCaseClass(b.providers[0].class)} (${b.name})`
    : `${b.name} (${b.providers.map(providerLabel).join(' / ')})`)).join(', '));
  return gaps;
}

function surveyResponderName(r) {
  const player = (STATE.players || []).find(p => p.id === r.character_id);
  const cls = r.spec_choices?.[0]?.class || player?.class;
  return `<span class="recruit-name" style="color:${CLASS_COLORS[cls] || 'var(--text)'};">${escapeHtml(r.character_name)}</span>`;
}

function surveyChip(p) {
  return `<span class="season-chip" style="color:${CLASS_COLORS[p.class] || 'var(--text)'};">${escapeHtml(p.name)}</span>`;
}

function renderSeasonTab() {
  const panel = document.getElementById('season-panel');
  if (!panel) return;
  const openOne = SURVEY.surveys.find(s => !s.closed_at);

  if (!SURVEY.results) {
    panel.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📋</div><h3>Ask your raiders about next season</h3>
      <p>Raiders answer on RaidLead: whether they're coming back, what they want to play, and what they can flex to.
      You'll see who hasn't answered yet, the roster it adds up to, and any raid buffs or roles you're missing.</p>
      <button class="btn-primary" style="margin-top:14px;" onclick="openSurveyEditor('new')">Create survey</button></div>`;
    return;
  }

  const { survey, responses } = SURVEY.results;
  const { items } = survey.questions;
  const isOpen = !survey.closed_at;
  const tracker = surveyTracker(responses);
  const counts = { returning: 0, unsure: 0, not_returning: 0 };
  responses.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const projection = surveyProjection(responses, SURVEY.includeUnsure);
  const gaps = surveyGaps(projection);

  const picker = SURVEY.surveys.length > 1
    ? `<select class="season-survey-select" onchange="selectSeasonSurvey(this.value)" aria-label="Survey">${SURVEY.surveys.map(s =>
        `<option value="${escapeHtml(s.id)}"${s.id === survey.id ? ' selected' : ''}>${escapeHtml(s.title)} (${s.closed_at ? 'closed ' + surveyDate(s.closed_at) : 'open'})</option>`).join('')}</select>`
    : '';
  const actions = isOpen
    ? `<button class="btn-primary recruit-small-btn" onclick="copySurveyLink()">Copy survey link</button>
       <button class="btn-secondary recruit-small-btn" onclick="openSurveyEditor('edit')">Edit questions</button>
       <button class="btn-secondary recruit-small-btn" onclick="closeSeasonSurvey()">Close survey</button>`
    : `${openOne ? '' : `<button class="btn-primary recruit-small-btn" onclick="openSurveyEditor('new')">New survey</button>
       <button class="btn-secondary recruit-small-btn" onclick="reopenSeasonSurvey()">Reopen</button>`}
       <button class="btn-secondary recruit-small-btn applicant-reject" onclick="deleteSeasonSurvey()">Delete</button>`;

  // Who hasn't answered
  const waitingHtml = (tracker.waitingClaimed.length || tracker.waitingUnclaimed.length) ? `
    <div class="season-section">
      <div class="season-section-head">
        <div class="season-section-title">Still waiting on (${tracker.waitingClaimed.length + tracker.waitingUnclaimed.length})</div>
        ${tracker.waitingClaimed.length ? `<button class="btn-secondary recruit-small-btn" onclick="copySurveyWaitingNames()">Copy names</button>` : ''}
      </div>
      <div class="season-chips">${tracker.waitingClaimed.map(surveyChip).join('')}</div>
      ${tracker.waitingUnclaimed.length ? `
        <div class="recruit-sub" style="margin-top:10px;">Can't answer yet -- nobody has claimed these characters in RaidLead:</div>
        <div class="season-chips muted">${tracker.waitingUnclaimed.map(surveyChip).join('')}</div>` : ''}
    </div>` : (tracker.mains.length ? `<div class="season-section"><div class="season-all-in">Everyone on the roster has answered.</div></div>` : '');

  // Projected roster by role
  const roleCards = SURVEY_ROLES.map(([role, label]) => {
    const people = projection.byRole[role];
    const target = role === 'tank' ? GAME.compTarget.tank : role === 'heal' ? GAME.compTarget.heal : null;
    const short = target != null && people.length < target;
    return `<div class="season-role-card${short ? ' short' : ''}">
      <div class="stat-label">${label}</div>
      <div class="season-role-count">${people.length}${target != null ? `<span class="recruit-sub"> / ${target}</span>` : ''}</div>
      <div class="season-role-list">${people.map(r => `<div>${surveyResponderName(r)} <span class="recruit-sub">${escapeHtml(r.spec_choices[0].spec)}</span></div>`).join('') || '<span class="recruit-sub">Nobody yet</span>'}</div>
      ${projection.flex[role].length ? `<div class="season-role-flex"><span class="recruit-sub">Could flex:</span> ${projection.flex[role].map(surveyResponderName).join(', ')}</div>` : ''}
    </div>`;
  }).join('');
  const dpsCount = projection.byRole.melee.length + projection.byRole.ranged.length;

  // A bar chart per multiple-choice, checkbox, and scale question
  const chartItems = items.filter(i => ['single', 'checkboxes', 'scale'].includes(i.type));
  const questionsHtml = chartItems.length ? `
    <div class="season-section">
      <div class="season-section-title" style="margin-bottom:12px;">Question results</div>
      ${chartItems.map(i => surveyItemChart(i, responses)).join('')}
    </div>` : '';

  // Anyone who picked an answer marked "flag"
  const flags = [];
  responses.forEach(r => items.forEach(item => {
    const option = surveyFlaggedOption(item, r.answers?.[item.id]);
    if (option) flags.push({ r, item, option });
  }));
  const flagsHtml = flags.length ? `
    <div class="season-section">
      <div class="season-section-title">Flags (${flags.length})</div>
      ${flags.map(f => `<div class="season-flag">${surveyResponderName(f.r)} answered <strong>"${escapeHtml(f.option.label)}"</strong>
        <span class="recruit-sub">to: ${escapeHtml(surveyPromptSnippet(f.item.prompt))}</span></div>`).join('')}
    </div>` : '';

  // Every response
  const visible = responses.filter(r => SURVEY.responseFilter === 'all' || r.status === SURVEY.responseFilter);
  const filterBtn = (value, label) =>
    `<button class="filter-btn${SURVEY.responseFilter === value ? ' active' : ''}" onclick="setSurveyResponseFilter('${value}')">${label}</button>`;
  const responsesHtml = `
    <div class="season-section">
      <div class="season-section-head">
        <div class="season-section-title">Responses (${responses.length})</div>
        <div class="role-filter">${filterBtn('all', 'All')}${filterBtn('returning', 'Returning')}${filterBtn('unsure', 'Not sure')}${filterBtn('not_returning', 'Not returning')}</div>
      </div>
      ${visible.length ? visible.map(r => renderSurveyResponseCard(r, survey.questions)).join('') : '<div class="recruit-empty-filter">No responses here yet.</div>'}
    </div>`;

  panel.innerHTML = `
    <div class="season-header">
      <div>
        ${picker}
        <div class="season-title">${escapeHtml(survey.title)}</div>
        <div class="recruit-sub">${isOpen ? `Open since ${surveyDate(survey.opened_at)}. Raiders see a banner asking them to answer.` : `Closed ${surveyDate(survey.closed_at)}.`}</div>
      </div>
      <div class="season-header-actions">${actions}</div>
    </div>

    <div class="stat-grid season-stats">
      <div class="stat-card"><div class="stat-label">Answered</div><div class="stat-value">${tracker.answeredMains}<span class="season-stat-of"> / ${tracker.mains.length}</span></div><div class="stat-sub">roster mains${responses.length > tracker.answeredMains ? ` · ${responses.length} responses` : ''}</div></div>
      <div class="stat-card"><div class="stat-label">Returning</div><div class="stat-value" style="color:#1EFF00;">${counts.returning}</div><div class="stat-sub">coming back</div></div>
      <div class="stat-card"><div class="stat-label">Not sure yet</div><div class="stat-value" style="color:var(--gold);">${counts.unsure}</div><div class="stat-sub">undecided</div></div>
      <div class="stat-card"><div class="stat-label">Not returning</div><div class="stat-value" style="color:#ff6b6b;">${counts.not_returning}</div><div class="stat-sub">leaving</div></div>
    </div>

    ${waitingHtml}

    <div class="season-section">
      <div class="season-section-head">
        <div class="season-section-title">Projected roster <span class="recruit-sub">· first choices · ${projection.counted.length} raiders, ${dpsCount} DPS (${GAME.compLabel} needs ${GAME.compTarget.tank} tanks, ${GAME.compTarget.heal} healers, ${GAME.compTarget.dps} DPS)</span></div>
        <label class="season-toggle"><input type="checkbox" ${SURVEY.includeUnsure ? 'checked' : ''} onchange="setSurveyIncludeUnsure(this.checked)" /> Count "not sure yet"</label>
      </div>
      ${gaps.length
        ? `<div class="season-gaps"><strong>Gaps to recruit for:</strong> ${gaps.map(escapeHtml).join(' · ')}</div>`
        : (projection.counted.length ? '<div class="season-gaps ok">No gaps: every role is covered and every raid buff is in.</div>' : '')}
      <div class="season-role-grid">${roleCards}</div>
      <div class="season-section-title" style="margin-top:18px; font-size:13px;">Raid buffs</div>
      <div class="raid-buffs-grid" id="season-buffs-grid" style="margin-bottom:0;"></div>
    </div>

    ${questionsHtml}
    ${flagsHtml}
    ${responsesHtml}`;

  renderRaidBuffs(projection.counted.map(r => ({ class: r.spec_choices?.[0]?.class })), document.getElementById('season-buffs-grid'));
}

function renderSurveyResponseCard(r, questions) {
  const { fixed, items } = questions;
  const flexLabels = (r.flex_roles || []).map(f => SURVEY_FLEX_LABELS[f]).filter(Boolean);
  const who = r.account?.display_name || r.account?.battletag || '';
  const edited = r.updated_at && r.submitted_at && (new Date(r.updated_at) - new Date(r.submitted_at) > 60000)
    ? ` · edited ${surveyDate(r.updated_at)}` : '';
  const detail = (label, value) => `<div><div class="season-k">${label}</div><div>${value}</div></div>`;
  const answered = items.filter(i => !surveyAnswerBlank(r.answers?.[i.id]));
  return `<div class="season-response">
    <div class="season-response-head">
      ${surveyResponderName(r)}
      <span class="season-status status-${r.status}">${SURVEY_STATUS_LABELS[r.status] || r.status}</span>
      <span class="recruit-sub">${escapeHtml(who)}${who ? ' · ' : ''}answered ${surveyDate(r.submitted_at)}${edited}</span>
    </div>
    ${r.status !== 'not_returning' ? `<div class="season-response-grid">
      ${detail('Specs', (r.spec_choices || []).map((c, i) => `${i + 1}. ${escapeHtml(surveySpecLabel(c))}`).join('<br>') || '—')}
      ${fixed.flex.enabled ? detail('Can flex to', escapeHtml(flexLabels.join(', ') || '—')) : ''}
    </div>` : ''}
    ${answered.map(i => {
      const v = r.answers[i.id];
      const shown = ['short', 'paragraph'].includes(i.type) ? linkifyText(v) : escapeHtml(surveyAnswerText(i, v));
      return `<div class="season-answer"><div class="season-answer-q">${escapeHtml(surveyPromptSnippet(i.prompt))}</div>
        <div${surveyFlaggedOption(i, v) ? ' class="season-answer-flag"' : ''}>${shown}</div></div>`;
    }).join('')}
    ${r.comments ? `<div class="season-answer"><div class="season-answer-q">${escapeHtml(fixed.comments.prompt)}</div><div>${linkifyText(r.comments)}</div></div>` : ''}
  </div>`;
}

function copySurveyLink() {
  const url = `${location.origin}/?survey=${encodeURIComponent(STATE.teamId)}`;
  navigator.clipboard.writeText(url)
    .then(() => showToast('Survey link copied. Paste it in Discord -- it opens the survey for anyone on the team.', 'success'))
    .catch(() => prompt('Copy this link:', url));
}

function copySurveyWaitingNames() {
  const names = surveyTracker(SURVEY.results?.responses || []).waitingClaimed.map(p => p.name).join(', ');
  navigator.clipboard.writeText(names)
    .then(() => showToast('Names copied', 'success'))
    .catch(() => prompt('Copy these names:', names));
}

async function closeSeasonSurvey() {
  const survey = SURVEY.results?.survey;
  if (!survey || !confirm(`Close "${survey.title}"? Raiders won't be able to answer or change their answers. You can reopen it later.`)) return;
  await surveyLifecycle('closeSurvey', 'Survey closed');
}

async function reopenSeasonSurvey() {
  await surveyLifecycle('reopenSurvey', 'Survey reopened');
}

async function deleteSeasonSurvey() {
  const r = SURVEY.results;
  if (!r) return;
  const n = r.responses.length;
  if (!confirm(`Delete "${r.survey.title}"${n ? ` and all ${n} response${n === 1 ? '' : 's'}` : ''}? This can't be undone.`)) return;
  try {
    await recruitingApi('deleteSurvey', { surveyId: r.survey.id });
    SURVEY.selectedId = null;
    SURVEY.results = null;
    showToast('Survey deleted', 'success');
    loadSeasonTab();
    loadMySurvey();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function surveyLifecycle(action, doneMessage) {
  const survey = SURVEY.results?.survey;
  if (!survey) return;
  try {
    await recruitingApi(action, { surveyId: survey.id });
    showToast(doneMessage, 'success');
    loadSeasonTab();
    loadMySurvey(); // the officer's own banner follows the survey
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Officer side: the survey editor ──

// Weekdays that aren't already raid nights are the likely extra-night picks.
function defaultSurveyDefinition() {
  const raidDays = STATE.config?.raidDays || [];
  const offDays = SURVEY_WEEKDAYS.filter((d, i) => !raidDays.includes((i + 1) % 7)); // Monday = JS day 1
  const policy = (prompt, exceptionLabel) => ({ type: 'single', prompt, required: true, audience: 'returning',
    options: [{ label: 'Yes' }, { label: exceptionLabel, flag: true }] });
  return {
    title: 'Next Season Survey',
    intro: "Let us know if you're coming back next season and what you'd like to play. Only officers can see your answers.",
    questions: {
      fixed: JSON.parse(JSON.stringify(SURVEY_FIXED_DEFAULTS)),
      items: [
        policy("We keep a roster bigger than we can bring, so some nights you'll sit out. It's nothing personal. Do you understand?", 'I need to play every raid night'),
        policy("Loot: follow the team's loot rules, and don't roll on items that aren't a real upgrade for you. Do you understand?", 'I have concerns about the loot rules'),
        policy('Gear: keep your item level close to the group average, and enchant and gem your gear for raid. Can you commit to that?', "I can't"),
        { type: 'checkboxes', prompt: 'We may add an extra raid night during progression. Which days would work for you?', required: false, audience: 'returning',
          options: offDays.map(d => ({ label: d })) },
      ],
    },
  };
}

function openSurveyEditor(mode) {
  let base;
  if (mode === 'edit') {
    base = SURVEY.results.survey;
  } else {
    // A new survey starts from the last one's questions, so next season's
    // wording carries over; the very first starts from the defaults.
    const last = SURVEY.surveys[0];
    base = last ? { title: 'Next Season Survey', intro: last.intro, questions: last.questions } : defaultSurveyDefinition();
  }
  const clone = JSON.parse(JSON.stringify(base));
  const q = clone.questions || {};
  SURVEY.editor = {
    mode,
    surveyId:      mode === 'edit' ? base.id : null,
    responseCount: mode === 'edit' ? SURVEY.results.responses.length : 0,
    title:         clone.title || '',
    intro:         clone.intro || '',
    fixed:         q.fixed || JSON.parse(JSON.stringify(SURVEY_FIXED_DEFAULTS)),
    items:         q.items || [],
  };
  document.getElementById('survey-editor-title').textContent = mode === 'edit' ? 'Edit survey' : 'New survey';
  document.getElementById('survey-editor-modal').classList.add('open');
  renderSurveyEditor();
}

function closeSurveyEditor() {
  document.getElementById('survey-editor-modal').classList.remove('open');
  SURVEY.editor = null;
}

function renderSurveyEditor() {
  const ed = SURVEY.editor;
  if (!ed) return;
  const f = ed.fixed;
  const input = (id, value, max, placeholder = '') =>
    `<input type="text" id="${id}" maxlength="${max}" value="${escapeHtml(value || '')}"${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ''} />`;
  const field = (label, html, extraClass = '') => `<div class="form-group${extraClass}"><label>${label}</label>${html}</div>`;
  const card = (title, tag, body) =>
    `<div class="survey-editor-item"><div class="survey-editor-item-head"><div class="survey-editor-item-title">${title}</div>${tag}</div>${body}</div>`;
  const lockedTag = '<span class="survey-editor-tag">Always asked</span>';
  const askToggle = (id, on) =>
    `<label class="season-toggle"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} onchange="surveyEditorRefresh()" /> Ask this</label>`;
  const opts = (map, selected) => Object.entries(map).map(([v, l]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${l}</option>`).join('');

  const fixedHtml = [
    card('Character', lockedTag, field('Question', input('se-fx-character', f.character.prompt, 300), ' full')
      + `<div class="survey-editor-note">Raiders pick one of the characters they've claimed.</div>`),
    card('Coming back?', lockedTag, field('Question', input('se-fx-returning', f.returning.prompt, 300), ' full') + `
      <div class="survey-editor-row three">
        ${[['returning', 'Returning answer'], ['unsure', 'Not-sure answer'], ['not_returning', 'Not-returning answer']]
          .map(([k, l]) => field(l, input('se-fx-status-' + k, f.returning.labels[k], 80))).join('')}
      </div>`),
    card('Class and spec choices', '<span class="survey-editor-tag">First choice always asked</span>', `
      <div class="survey-editor-row">
        ${field('Ask for', `<select id="se-fx-spec-count" onchange="surveyEditorRefresh()">${opts({ 1: 'First choice only', 2: 'First and second choice', 3: 'First, second, and third choice' }, String(f.specs.count))}</select>`)}
      </div>
      ${Array.from({ length: f.specs.count }, (_, i) => `
        <div class="survey-editor-row">
          ${field(`${['First', 'Second', 'Third'][i]} choice question`, input('se-fx-spec-prompt-' + i, f.specs.prompts[i], 300))}
          ${field('Help text', input('se-fx-spec-hint-' + i, f.specs.hints[i], 500, 'Optional'))}
        </div>`).join('')}`),
    card('Flex roles', askToggle('se-fx-flex-on', f.flex.enabled), f.flex.enabled
      ? field('Question', input('se-fx-flex', f.flex.prompt, 300), ' full') + '<div class="survey-editor-note">Answers: Tank, Healer, Melee DPS, Ranged DPS.</div>'
      : '<div class="survey-editor-note">Not asked.</div>'),
    card('Comments', askToggle('se-fx-comments-on', f.comments.enabled), f.comments.enabled
      ? field('Question', input('se-fx-comments', f.comments.prompt, 300), ' full') + '<div class="survey-editor-note">Asked last, of everyone.</div>'
      : '<div class="survey-editor-note">Not asked.</div>'),
  ].join('');

  const itemsHtml = ed.items.map((it, i) => {
    let body = '';
    if (it.type === 'single' || it.type === 'checkboxes') {
      body = `<div class="survey-editor-options">
        <div class="survey-editor-sub">Answers${it.type === 'single' ? ' <span class="recruit-sub">· tick Flag to flag anyone who picks that answer</span>' : ''}</div>
        ${(it.options || []).map((o, j) => `<div class="survey-editor-option">
            <input type="text" id="se-item-${i}-opt-${j}" maxlength="200" value="${escapeHtml(o.label || '')}" placeholder="Answer ${j + 1}" />
            ${it.type === 'single' ? `<label class="season-toggle"><input type="checkbox" id="se-item-${i}-flag-${j}" ${o.flag ? 'checked' : ''} /> Flag</label>` : ''}
            <button class="survey-editor-icon" title="Remove this answer" onclick="surveyEditorRemoveOption(${i}, ${j})">✕</button>
          </div>`).join('')}
        <button class="btn-secondary recruit-small-btn" onclick="surveyEditorAddOption(${i})">+ Add answer</button>
      </div>`;
    } else if (it.type === 'scale') {
      body = `<div class="survey-editor-row three">
        ${field('Scale', `<select id="se-item-${i}-max">${opts({ 5: '1 to 5', 10: '1 to 10' }, String(it.max || 5))}</select>`)}
        ${field('Label for 1', input(`se-item-${i}-low`, it.lowLabel, 60, 'e.g. Not at all'))}
        ${field('Label for the top', input(`se-item-${i}-high`, it.highLabel, 60, 'e.g. Very'))}
      </div>`;
    }
    return `<div class="survey-editor-item">
      <div class="survey-editor-item-head">
        <div class="survey-editor-item-title">Question ${i + 1}</div>
        <div class="survey-editor-item-tools">
          <button class="survey-editor-icon" title="Move up" ${i === 0 ? 'disabled' : ''} onclick="surveyEditorMove(${i}, -1)">↑</button>
          <button class="survey-editor-icon" title="Move down" ${i === ed.items.length - 1 ? 'disabled' : ''} onclick="surveyEditorMove(${i}, 1)">↓</button>
          <button class="survey-editor-remove" onclick="surveyEditorRemove(${i})">Remove</button>
        </div>
      </div>
      <div class="survey-editor-row three">
        ${field('Type', `<select id="se-item-${i}-type" onchange="surveyEditorRefresh()">${opts(SURVEY_TYPE_LABELS, it.type)}</select>`)}
        ${field('Ask', `<select id="se-item-${i}-audience">${opts(SURVEY_AUDIENCE_LABELS, it.audience || 'returning')}</select>`)}
        <div class="survey-editor-required"><label class="season-toggle"><input type="checkbox" id="se-item-${i}-required" ${it.required ? 'checked' : ''} /> Required</label></div>
      </div>
      ${field('Question', `<textarea id="se-item-${i}-prompt" rows="2" maxlength="4000">${escapeHtml(it.prompt || '')}</textarea>`, ' full survey-editor-prompt')}
      ${body}
    </div>`;
  }).join('');

  document.getElementById('survey-editor-body').innerHTML = `
    ${ed.mode === 'edit' && ed.responseCount ? `<div class="recruit-lookup warn" style="margin-bottom:14px;">${ed.responseCount} raider${ed.responseCount === 1 ? ' has' : 's have'} already answered. Rewording keeps their answers; removing a question hides its answers.</div>` : ''}
    ${field('Title', input('se-title', ed.title, 120), ' full')}
    ${field('Intro', `<textarea id="se-intro" rows="3" maxlength="4000">${escapeHtml(ed.intro)}</textarea>`, ' full survey-editor-prompt')}

    <div class="survey-editor-section">
      <div class="season-section-title">Always asked</div>
      <div class="survey-editor-note" style="margin-bottom:10px;">The results page is built on these. Reword any of them; flex roles and comments can be turned off.</div>
      ${fixedHtml}
    </div>

    <div class="survey-editor-section">
      <div class="season-section-title">Your questions</div>
      <div class="survey-editor-note" style="margin-bottom:10px;">Asked after the questions above, in this order.</div>
      ${itemsHtml || '<div class="survey-editor-note">None yet.</div>'}
      <div class="form-group survey-editor-add">
        <select id="se-add" onchange="surveyEditorAdd(this.value)" aria-label="Add a question">
          <option value="">+ Add a question...</option>
          <option value="policy">Policy acknowledgement (Yes, or a flagged answer)</option>
          <option value="single">Multiple choice (pick one)</option>
          <option value="checkboxes">Checkboxes (pick any)</option>
          <option value="short">Short answer</option>
          <option value="paragraph">Paragraph</option>
          <option value="scale">Scale (1 to 5)</option>
        </select>
      </div>
    </div>

    <div id="se-msg" class="status-msg"></div>
    <div class="survey-form-actions">
      <button class="btn-secondary" onclick="closeSurveyEditor()">Cancel</button>
      <button class="btn-primary" id="se-save-btn" onclick="saveSurveyEditor()">${ed.mode === 'edit' ? 'Save changes' : 'Open survey'}</button>
    </div>`;
}

// Pulls whatever's typed into the editor back into SURVEY.editor, so any
// change that re-renders it (adding, removing, moving, switching a type)
// keeps edits. Fields that aren't on screen keep their saved value.
function syncSurveyEditor() {
  const ed = SURVEY.editor;
  const el  = id => document.getElementById(id);
  const val = (id, fallback) => (el(id) ? el(id).value : fallback);
  const on  = (id, fallback) => (el(id) ? el(id).checked : fallback);
  ed.title = val('se-title', ed.title);
  ed.intro = val('se-intro', ed.intro);

  const f = ed.fixed;
  f.character.prompt = val('se-fx-character', f.character.prompt);
  f.returning.prompt = val('se-fx-returning', f.returning.prompt);
  ['returning', 'unsure', 'not_returning'].forEach(k => { f.returning.labels[k] = val('se-fx-status-' + k, f.returning.labels[k]); });
  [0, 1, 2].forEach(i => {
    f.specs.prompts[i] = val('se-fx-spec-prompt-' + i, f.specs.prompts[i]);
    f.specs.hints[i]   = val('se-fx-spec-hint-' + i, f.specs.hints[i]);
  });
  f.specs.count      = Number(val('se-fx-spec-count', f.specs.count)) || f.specs.count;
  f.flex.enabled     = on('se-fx-flex-on', f.flex.enabled);
  f.flex.prompt      = val('se-fx-flex', f.flex.prompt);
  f.comments.enabled = on('se-fx-comments-on', f.comments.enabled);
  f.comments.prompt  = val('se-fx-comments', f.comments.prompt);

  ed.items.forEach((it, i) => {
    it.prompt   = val(`se-item-${i}-prompt`, it.prompt);
    it.audience = val(`se-item-${i}-audience`, it.audience);
    it.required = on(`se-item-${i}-required`, it.required);
    (it.options || []).forEach((o, j) => {
      o.label = val(`se-item-${i}-opt-${j}`, o.label);
      o.flag  = on(`se-item-${i}-flag-${j}`, !!o.flag);
    });
    if (it.type === 'scale') {
      it.max       = Number(val(`se-item-${i}-max`, it.max || 5));
      it.lowLabel  = val(`se-item-${i}-low`, it.lowLabel);
      it.highLabel = val(`se-item-${i}-high`, it.highLabel);
    }
    // Switched type in the dropdown: keep the question and any answers.
    const type = val(`se-item-${i}-type`, it.type);
    if (type !== it.type) {
      it.type = type;
      if ((type === 'single' || type === 'checkboxes') && !(it.options || []).length) it.options = [{ label: '' }, { label: '' }];
      if (type === 'scale' && !it.max) Object.assign(it, { max: 5, lowLabel: '', highLabel: '' });
    }
  });
}

function surveyEditorAdd(kind) {
  if (!kind) return;
  syncSurveyEditor();
  const choice = kind === 'single' || kind === 'checkboxes';
  SURVEY.editor.items.push(kind === 'policy'
    ? { type: 'single', prompt: '', required: true, audience: 'returning',
        options: [{ label: 'Yes' }, { label: "I can't agree to this", flag: true }] }
    : { type: kind, prompt: '', required: false, audience: 'returning',
        ...(choice ? { options: [{ label: '' }, { label: '' }] } : {}),
        ...(kind === 'scale' ? { max: 5, lowLabel: '', highLabel: '' } : {}) });
  renderSurveyEditor();
  document.getElementById(`se-item-${SURVEY.editor.items.length - 1}-prompt`)?.focus();
}

function surveyEditorRemove(index) {
  syncSurveyEditor();
  SURVEY.editor.items.splice(index, 1);
  renderSurveyEditor();
}

async function saveSurveyEditor() {
  syncSurveyEditor();
  const ed = SURVEY.editor;
  const msg = document.getElementById('se-msg');
  const btn = document.getElementById('se-save-btn');
  const fail = text => { msg.className = 'status-msg error'; msg.textContent = text; };
  if (!ed.title.trim()) return fail('Give the survey a title.');

  // Blank questions and blank answers are dropped; a choice question needs
  // something to choose from.
  const items = ed.items.filter(it => (it.prompt || '').trim()).map(it => ({
    ...it, options: it.options ? it.options.filter(o => (o.label || '').trim()) : undefined,
  }));
  for (const it of items) {
    if (it.type !== 'single' && it.type !== 'checkboxes') continue;
    const min = it.type === 'single' ? 2 : 1;
    if (it.options.length < min) return fail(`"${surveyPromptSnippet(it.prompt, 50)}" needs at least ${min === 2 ? 'two answers' : 'one answer'} to pick from.`);
  }

  const body = { surveyId: ed.surveyId, title: ed.title, intro: ed.intro, questions: { fixed: ed.fixed, items } };
  btn.disabled = true;
  try {
    const { survey } = await recruitingApi(ed.mode === 'edit' ? 'updateSurvey' : 'openSurvey', body);
    closeSurveyEditor();
    SURVEY.selectedId = survey.id;
    showToast(ed.mode === 'edit' ? 'Survey updated' : 'Survey opened. Raiders will see a banner asking them to answer.', 'success');
    loadSeasonTab();
    loadMySurvey();
  } catch (e) {
    fail(e.message);
  } finally {
    btn.disabled = false;
  }
}

// Same rule as itemAskedFor in lib/seasonSurvey.js: 'returning' questions go
// to people returning or not sure yet.
function surveyItemAsked(item, status) {
  if (item.audience === 'everyone') return true;
  return (item.audience === 'not_returning') === (status === 'not_returning');
}

function surveyAnswerBlank(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

// First line of a (possibly long, policy-style) question, for labels.
function surveyPromptSnippet(prompt, max = 90) {
  const line = String(prompt || '').split('\n')[0];
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

// An answer as text: option labels for choices, "4 / 5" for scales.
function surveyAnswerText(item, v) {
  if (item.type === 'single') return item.options.find(o => o.id === v)?.label || '';
  if (item.type === 'checkboxes') return item.options.filter(o => (v || []).includes(o.id)).map(o => o.label).join(', ');
  if (item.type === 'scale') return `${v} / ${item.max}`;
  return String(v ?? '');
}

// The picked answer if it's one marked "flag", else null.
function surveyFlaggedOption(item, v) {
  return item.type === 'single' ? item.options.find(o => o.id === v && o.flag) || null : null;
}

function surveyChoice(type, name, value, label, isOn, extra = '') {
  return `<label class="survey-choice"><input type="${type}" name="${name}" value="${escapeHtml(String(value))}"${isOn ? ' checked' : ''}${extra} /> ${escapeHtml(label)}</label>`;
}

// One of the officer's own questions, as raiders see it.
function renderSurveyItem(item, value) {
  const name = 'sv-item-' + item.id;
  let input;
  if (item.type === 'single' || item.type === 'checkboxes') {
    const kind = item.type === 'single' ? 'radio' : 'checkbox';
    const isOn = o => (item.type === 'single' ? value === o.id : (value || []).includes(o.id));
    input = `<div class="survey-choice-row">${item.options.map(o => surveyChoice(kind, name, o.id, o.label, isOn(o))).join('')}</div>`;
  } else if (item.type === 'scale') {
    input = `<div class="survey-scale">
      ${item.lowLabel ? `<span class="survey-scale-label">${escapeHtml(item.lowLabel)}</span>` : ''}
      ${Array.from({ length: item.max }, (_, i) => surveyChoice('radio', name, i + 1, String(i + 1), value === i + 1)).join('')}
      ${item.highLabel ? `<span class="survey-scale-label">${escapeHtml(item.highLabel)}</span>` : ''}
    </div>`;
  } else if (item.type === 'short') {
    input = `<div class="form-group"><input type="text" id="${name}" maxlength="300" autocomplete="off" value="${escapeHtml(value || '')}" /></div>`;
  } else {
    input = `<div class="form-group"><textarea id="${name}" rows="3" maxlength="2000">${escapeHtml(value || '')}</textarea></div>`;
  }
  // Policy-style questions (a flagged answer) sit in a box -- they tend to be long.
  const boxed = item.type === 'single' && item.options.some(o => o.flag);
  return `<div class="survey-q${boxed ? ' survey-ack' : ''}" data-audience="${escapeHtml(item.audience || 'returning')}">
    <div class="${boxed ? 'survey-ack-prompt' : 'survey-q-label survey-item-prompt'}">${linkifyText(item.prompt)}${item.required ? ' <span class="survey-req">*</span>' : ''}</div>
    ${input}
  </div>`;
}

// Results for one choice or scale question: a bar per answer, names on hover.
function surveyItemChart(item, responses) {
  const answered = responses.filter(r => !surveyAnswerBlank(r.answers?.[item.id]));
  const picked = (r, id) => (item.type === 'checkboxes' ? (r.answers[item.id] || []).includes(id) : r.answers[item.id] === id);
  const rows = item.type === 'scale'
    ? Array.from({ length: item.max }, (_, i) => ({ label: String(i + 1), people: answered.filter(r => r.answers[item.id] === i + 1) }))
    : item.options.map(o => ({ label: o.label, flag: !!o.flag, people: answered.filter(r => picked(r, o.id)) }));
  const max = Math.max(1, ...rows.map(x => x.people.length));
  const avg = item.type === 'scale' && answered.length
    ? (answered.reduce((sum, r) => sum + r.answers[item.id], 0) / answered.length).toFixed(1) : null;
  const scaleNote = item.type === 'scale' && (item.lowLabel || item.highLabel)
    ? ` · 1 = ${item.lowLabel || '…'}, ${item.max} = ${item.highLabel || '…'}` : '';
  return `<div class="season-question">
    <div class="season-question-prompt">${escapeHtml(surveyPromptSnippet(item.prompt, 140))}
      <span class="recruit-sub">· ${answered.length} answered${avg ? ` · average ${avg} of ${item.max}` : ''}${escapeHtml(scaleNote)}</span></div>
    <div class="season-bars">${rows.map(x => `
      <div class="season-bar${x.flag ? ' flagged' : ''}" title="${escapeHtml(x.people.map(r => r.character_name).join(', ') || 'Nobody')}">
        <div class="season-bar-label">${escapeHtml(x.label)}</div>
        <div class="season-bar-track"><div style="width:${(x.people.length / max) * 100}%;"></div></div>
        <div class="season-bar-count">${x.people.length}</div>
      </div>`).join('')}
    </div>
  </div>`;
}

function surveyEditorRefresh() {
  syncSurveyEditor();
  renderSurveyEditor();
}

function surveyEditorMove(index, dir) {
  syncSurveyEditor();
  const items = SURVEY.editor.items;
  const to = index + dir;
  if (to < 0 || to >= items.length) return;
  [items[index], items[to]] = [items[to], items[index]];
  renderSurveyEditor();
}

function surveyEditorAddOption(index) {
  syncSurveyEditor();
  const it = SURVEY.editor.items[index];
  (it.options ||= []).push({ label: '' });
  renderSurveyEditor();
  document.getElementById(`se-item-${index}-opt-${it.options.length - 1}`)?.focus();
}

function surveyEditorRemoveOption(index, optionIndex) {
  syncSurveyEditor();
  SURVEY.editor.items[index].options.splice(optionIndex, 1);
  renderSurveyEditor();
}

// ─────────────────────────────────────────────
//  JOIN ORDER
// ─────────────────────────────────────────────
// The order raiders joined this season (Team Management > Join Order). When
// more than 30 -- Heroic's cap -- want to raid, #31 is next in if someone in
// the first 30 is missing. Filled automatically (survey answers in the order
// raiders finish, then roster additions; see lib/joinOrder.js) and editable
// by officers. Raid Night can show each raider's number on their pill
// (officers only).

const JOIN_SOURCE_LABELS = { roster: 'Added to the roster', recruit: 'Added from Recruits', manual: 'Added by an officer' };

const JOIN = {
  lists:          [],    // every order this team has had, newest first
  currentId:      null,  // this season's order
  list:           null,  // the order the Join Order tab is showing
  entries:        [],    // ...and its entries (including people who left)
  currentEntries: null,  // this season's entries, for Raid Night numbers
  loadedFor:      null,  // team id currentEntries belongs to
  busy:           false,
  saving:         null,  // the in-flight order save
  pendingOrder:   null,  // a newer order to send once it finishes
  showOnPlanner:  false, // Raid Night "Show Order Joined"
  numberMaps:     null,  // cached { byChar, byAccount } for the badges
};

const joinActiveEntries = entries => (entries || []).filter(e => !e.left_at);

// Loads an order (this season's by default) into JOIN.
async function loadJoinOrder(listId = null) {
  const data = await recruitingApi('getJoinOrder', listId ? { listId } : {});
  JOIN.lists = data.lists || [];
  JOIN.currentId = data.currentId;
  JOIN.list = data.list;
  JOIN.entries = data.entries || [];
  if (!data.list || data.list.id === data.currentId) setJoinCurrentEntries(JOIN.entries);
  return data;
}

function setJoinCurrentEntries(entries) {
  JOIN.currentEntries = entries;
  JOIN.loadedFor = STATE.teamId;
  JOIN.numberMaps = null;
}

// The roster changed (someone added or removed): Raid Night's numbers reload.
function invalidateJoinOrder() {
  JOIN.loadedFor = null;
  if (JOIN.showOnPlanner) toggleShowOrderJoined(true, { quiet: true });
}

async function loadJoinOrderTab(listId = null) {
  const panel = document.getElementById('join-panel');
  if (!panel) return;
  if (!JOIN.list) panel.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Loading join order...</div></div>';
  try {
    await loadJoinOrder(listId);
  } catch (e) {
    panel.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><h3>Couldn't load the join order</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  renderJoinOrderTab();
}

function selectJoinOrderList(listId) {
  return loadJoinOrderTab(listId);
}

function joinEntryPlayer(e) {
  return (STATE.players || []).find(p => p.id === e.character_id) || null;
}

function joinEntrySource(e) {
  if (e.source === 'survey') return `Survey · ${e.survey_status === 'unsure' ? 'Not sure yet' : 'Returning'}`;
  return JOIN_SOURCE_LABELS[e.source] || '';
}

function renderJoinOrderTab() {
  const panel = document.getElementById('join-panel');
  if (!panel) return;

  if (!JOIN.list) {
    panel.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔢</div><h3>Track the order raiders joined</h3>
      <p>Join Order numbers your raiders by when they joined this season. When more than ${GAME.raidCap} want to raid (${escapeHtml(GAME.raidCapLabel)}),
      #${GAME.raidCap + 1} is next in if someone in the first ${GAME.raidCap} is missing.</p>
      <p>Opening a Next Season survey starts a new order automatically, in the order raiders finish it. You can also start one now from your current roster and arrange it by hand.</p>
      <button class="btn-primary" style="margin-top:14px;" onclick="startJoinOrderFromRoster()">Start from current roster</button></div>`;
    return;
  }

  const isCurrent = JOIN.list.id === JOIN.currentId;
  const active = joinActiveEntries(JOIN.entries);
  const left = JOIN.entries.filter(e => e.left_at).sort((a, b) => String(b.left_at).localeCompare(String(a.left_at)));
  const nameHtml = e => {
    const p = joinEntryPlayer(e);
    return `<span class="recruit-name" style="color:${CLASS_COLORS[p?.class] || 'var(--text)'};">${escapeHtml(p?.name || e.character_name)}</span>`;
  };

  const picker = JOIN.lists.length > 1
    ? `<select class="season-survey-select" onchange="selectJoinOrderList(this.value)" aria-label="Join order">${JOIN.lists.map(l =>
        `<option value="${escapeHtml(l.id)}"${l.id === JOIN.list.id ? ' selected' : ''}>${escapeHtml(l.title)}${l.id === JOIN.currentId ? ' (this season)' : ` (${surveyDate(l.created_at)})`}</option>`).join('')}</select>`
    : '';

  const rows = active.map((e, i) => {
    const tools = isCurrent ? `
      <div class="join-tools">
        <button class="survey-editor-icon" title="Move up" ${i === 0 ? 'disabled' : ''} onclick="joinMove(${jsAttr(e.id)}, -1)">↑</button>
        <button class="survey-editor-icon" title="Move down" ${i === active.length - 1 ? 'disabled' : ''} onclick="joinMove(${jsAttr(e.id)}, 1)">↓</button>
        <input type="number" class="join-moveto" min="1" max="${active.length}" value="${i + 1}" title="Move to this number" aria-label="Move ${escapeHtml(e.character_name)} to number"
          onchange="joinMoveTo(${jsAttr(e.id)}, this.value)" />
        <button class="survey-editor-icon" title="Take out of the order" onclick="joinRemove(${jsAttr(e.id)})">✕</button>
      </div>` : '';
    const row = `<div class="join-row${i >= GAME.raidCap ? ' over-cap' : ''}">
      <div class="join-num">${i + 1}</div>
      <div class="join-main">${nameHtml(e)}<span class="recruit-sub">${escapeHtml(joinEntrySource(e))} · ${surveyDate(e.joined_at)}</span></div>
      ${tools}
    </div>`;
    const capLine = i === GAME.raidCap - 1 && active.length > GAME.raidCap
      ? `<div class="join-cap">${escapeHtml(GAME.raidCapLabel)} (${GAME.raidCap}). Everyone below is next in line, in order.</div>` : '';
    return row + capLine;
  }).join('');

  // Roster Mains who aren't numbered in this season's order.
  const inOrder = e => ({ char: e.character_id, acct: e.account_id });
  const numbered = active.map(inOrder);
  const missing = isCurrent ? (STATE.players || []).filter(p => (p.rank || 'Main') === 'Main'
    && !numbered.some(x => x.char === p.id || (p.account_id && x.acct === p.account_id))) : [];
  const missingHtml = missing.length ? `
    <div class="season-section">
      <div class="season-section-head">
        <div class="season-section-title">On the roster, not in the order (${missing.length})</div>
        <button class="btn-secondary recruit-small-btn" onclick="joinAdd(${jsAttr(missing.map(p => p.id).join(','))})">Add all to the end</button>
      </div>
      <div class="recruit-sub" style="margin-bottom:8px;">Haven't answered the survey yet, or were on the roster before the order started.</div>
      <div class="season-chips">${missing.map(p => `<button class="season-chip join-add-chip" style="color:${CLASS_COLORS[p.class] || 'var(--text)'};"
        title="Add ${escapeHtml(p.name)} to the end" onclick="joinAdd(${jsAttr(p.id)})">+ ${escapeHtml(p.name)}</button>`).join('')}</div>
    </div>` : '';

  const leftHtml = left.length ? `
    <div class="season-section">
      <div class="season-section-title" style="margin-bottom:8px;">Left the order (${left.length})</div>
      ${left.map(e => `<div class="join-row left">
        <div class="join-num">–</div>
        <div class="join-main">${nameHtml(e)}<span class="recruit-sub">${escapeHtml(e.left_reason || 'Left')} · ${surveyDate(e.left_at)} · joined ${surveyDate(e.joined_at)}</span></div>
        ${isCurrent ? `<div class="join-tools"><button class="btn-secondary recruit-small-btn" onclick="joinRestore(${jsAttr(e.id)})">Put back</button></div>` : ''}
      </div>`).join('')}
    </div>` : '';

  panel.innerHTML = `
    <div class="season-header">
      <div>
        ${picker}
        <div class="season-title">${escapeHtml(JOIN.list.title)}</div>
        <div class="recruit-sub">${isCurrent
          ? `This season's order, started ${surveyDate(JOIN.list.created_at)}. Survey answers and new roster Mains are added automatically; move anyone with the arrows or a number.`
          : "A past season's order, kept for history."}</div>
      </div>
      <div class="join-count"><div class="stat-label">Raiders</div><div class="stat-value">${active.length}</div></div>
    </div>
    <div class="season-section">
      ${rows || '<div class="recruit-empty-filter">Nobody yet. Raiders are added as they answer the survey or join the roster.</div>'}
    </div>
    ${missingHtml}
    ${leftHtml}`;
}

function applyJoinOrderLocally(ids) {
  const byId = new Map(JOIN.entries.map(e => [e.id, e]));
  ids.forEach((id, i) => { if (byId.has(id)) byId.get(id).position = i + 1; });
  JOIN.entries.sort((a, b) => a.position - b.position);
}

// Shows a new top-to-bottom order right away, then saves it. Moves made
// while a save is in flight are shown immediately too, and the latest
// order is sent as soon as that save finishes -- quick clicks aren't lost.
async function saveJoinOrderIds(ids) {
  applyJoinOrderLocally(ids);
  renderJoinOrderTab();
  if (JOIN.busy) { JOIN.pendingOrder = ids; return JOIN.saving?.catch(() => {}); } // errors are reported once, below
  JOIN.busy = true;
  JOIN.saving = (async () => {
    let next = ids;
    while (next) {
      JOIN.pendingOrder = null;
      const { entries } = await recruitingApi('saveJoinOrder', { listId: JOIN.list.id, order: next });
      JOIN.entries = entries;
      setJoinCurrentEntries(entries);
      next = JOIN.pendingOrder;
      if (next) applyJoinOrderLocally(next);
    }
  })();
  try {
    await JOIN.saving;
  } catch (e) {
    JOIN.pendingOrder = null;
    showToast('Error: ' + e.message, 'error');
    await loadJoinOrder(JOIN.list.id).catch(() => {});
  } finally {
    JOIN.busy = false;
    renderJoinOrderTab();
  }
}

function joinMove(entryId, dir) {
  const ids = joinActiveEntries(JOIN.entries).map(e => e.id);
  const i = ids.indexOf(entryId);
  const to = i + dir;
  if (i < 0 || to < 0 || to >= ids.length) return;
  [ids[i], ids[to]] = [ids[to], ids[i]];
  return saveJoinOrderIds(ids);
}

function joinMoveTo(entryId, number) {
  const ids = joinActiveEntries(JOIN.entries).map(e => e.id);
  const from = ids.indexOf(entryId);
  const to = Math.min(Math.max(parseInt(number, 10) || 1, 1), ids.length) - 1;
  if (from < 0 || from === to) { renderJoinOrderTab(); return; }
  ids.splice(from, 1);
  ids.splice(to, 0, entryId);
  return saveJoinOrderIds(ids);
}

// Runs one of the Join Order edit actions and shows the result.
async function joinOrderAction(action, body, doneMessage) {
  if (JOIN.saving) await JOIN.saving.catch(() => {}); // let a reorder finish first
  if (JOIN.busy) return;
  JOIN.busy = true;
  try {
    const { entries } = await recruitingApi(action, { listId: JOIN.list.id, ...body });
    JOIN.entries = entries;
    setJoinCurrentEntries(entries);
    if (doneMessage) showToast(doneMessage, 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
    await loadJoinOrder(JOIN.list.id).catch(() => {});
  } finally {
    JOIN.busy = false;
    renderJoinOrderTab();
  }
}

function joinAdd(characterIdsCsv) {
  const characterIds = String(characterIdsCsv).split(',').filter(Boolean);
  return joinOrderAction('addJoinOrderEntries', { characterIds },
    characterIds.length > 1 ? `Added ${characterIds.length} raiders to the end` : 'Added to the end');
}

function joinRemove(entryId) {
  const e = JOIN.entries.find(x => x.id === entryId);
  if (!e || !confirm(`Take ${e.character_name} out of the order? They'll be listed under "Left the order" and can be put back.`)) return;
  return joinOrderAction('removeJoinOrderEntry', { entryId });
}

function joinRestore(entryId) {
  return joinOrderAction('restoreJoinOrderEntry', { entryId }, 'Put back at the end');
}

async function startJoinOrderFromRoster() {
  try {
    await recruitingApi('startJoinOrder');
    showToast('Join order started from your roster. Arrange it by hand if needed.', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
  loadJoinOrderTab();
}

// ── Raid Night: "Show Order Joined" (officers) ──

function joinOrderNumberMaps() {
  const byChar = new Map(), byAccount = new Map();
  joinActiveEntries(JOIN.currentEntries).forEach((e, i) => {
    if (e.character_id) byChar.set(e.character_id, i + 1);
    if (e.account_id && !byAccount.has(e.account_id)) byAccount.set(e.account_id, i + 1);
  });
  return { byChar, byAccount };
}

// "#12" on a Raid Night pill -- a raider's alts share their main's number
// (matched through the account that claimed both).
function joinOrderBadge(player) {
  if (!JOIN.showOnPlanner || !player || !['owner', 'officer'].includes(STATE.myRole) || JOIN.loadedFor !== STATE.teamId) return '';
  const maps = JOIN.numberMaps || (JOIN.numberMaps = joinOrderNumberMaps());
  let n = maps.byChar.get(player.id);
  if (!n && player.account_id) {
    // An alt: borrow the main's number via the claiming account.
    const main = (STATE.players || []).find(p => p.account_id === player.account_id && maps.byChar.has(p.id));
    n = main ? maps.byChar.get(main.id) : maps.byAccount.get(player.account_id);
  }
  return n ? `<span class="join-order-badge${n > GAME.raidCap ? ' over-cap' : ''}" title="Joined #${n} this season">#${n}</span>` : '';
}

async function toggleShowOrderJoined(force, { quiet = false } = {}) {
  JOIN.showOnPlanner = typeof force === 'boolean' ? force : !JOIN.showOnPlanner;
  try { localStorage.setItem('raidlead_show_join_order', JOIN.showOnPlanner ? '1' : ''); } catch (e) {}
  if (JOIN.showOnPlanner && JOIN.loadedFor !== STATE.teamId) {
    try {
      const data = await recruitingApi('getJoinOrder');
      setJoinCurrentEntries(data.list && data.list.id === data.currentId ? data.entries : []);
      if (!data.list && !quiet) showToast('No join order yet. Start one in Team Management > Join Order.', '');
    } catch (e) {
      if (!quiet) showToast('Error: ' + e.message, 'error');
      JOIN.showOnPlanner = false;
    }
  }
  JOIN.numberMaps = null;
  const btn = document.getElementById('planner-join-order-btn');
  if (btn) {
    btn.classList.toggle('active', JOIN.showOnPlanner);
    btn.textContent = JOIN.showOnPlanner ? 'Hide Order Joined' : 'Show Order Joined';
  }
  renderPlannerChecklist();
  renderPlannerRoster();
}

// Officers keep their Show Order Joined choice between visits.
function restoreShowOrderJoined() {
  let saved = false;
  try { saved = localStorage.getItem('raidlead_show_join_order') === '1'; } catch (e) {}
  if (!STATE.teamId || !saved) return;
  if (!JOIN.showOnPlanner || JOIN.loadedFor !== STATE.teamId) toggleShowOrderJoined(true, { quiet: true });
}

// ─────────────────────────────────────────────
//  ROLES (Team Management > Roles)
// ─────────────────────────────────────────────
// Who's on the team and what they can do -- the same member list as My
// Profile's, where officers pick roles, easy to find. Owners also get a
// nudge (loadOfficerNudge) until the team has an officer. Server side:
// api/members.js (get, updateRole, removeMember) and api/guild.js
// (transferOwner).

const ROLE_INFO = [
  ['owner',   'Owner',   'Everything an officer can do, plus handing the team to someone else.'],
  ['officer', 'Officer', 'Runs the team: edits the roster, plans and publishes Raid Night, refreshes WCL scores, invites people, and uses Team Management.'],
  ['member',  'Member',  'A raider: claims their character, marks their own attendance, and answers the season survey.'],
  ['viewer',  'Viewer',  'Read-only, without a character of their own.'],
];
const ROLE_LABELS = Object.fromEntries(ROLE_INFO.map(([k, l]) => [k, l]));
const ROLE_ORDER  = Object.fromEntries(ROLE_INFO.map(([k], i) => [k, i]));

const ROLES = { members: null, busy: false };

function memberAccount(m) {
  return Array.isArray(m.accounts) ? m.accounts[0] : m.accounts;
}

function memberDisplayName(m) {
  const acct = memberAccount(m);
  return acct?.display_name || acct?.battletag || 'Unknown';
}

async function loadRolesTab() {
  const panel = document.getElementById('roles-panel');
  if (!panel) return;
  if (!ROLES.members) panel.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Loading members...</div></div>';
  const teamId = STATE.teamId;
  const data = await fetchMembersFromDB(teamId);
  if (teamId !== STATE.teamId) return;
  ROLES.members = data.members || [];
  renderRolesTab();
}

function renderRolesTab() {
  const panel = document.getElementById('roles-panel');
  if (!panel || !ROLES.members) return;
  const isOwner = STATE.myRole === 'owner';
  const me = AUTH.session?.id;
  const members = [...ROLES.members].sort((a, b) =>
    (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || memberDisplayName(a).localeCompare(memberDisplayName(b)));
  const counts = ROLE_INFO.map(([k, l]) => {
    const n = members.filter(m => m.role === k).length;
    return n ? `${n} ${n === 1 ? l.toLowerCase() : l.toLowerCase() + 's'}` : null;
  }).filter(Boolean).join(' · ');

  const rows = members.map(m => {
    const isSelf = m.account_id === me;
    const chars = mainsFirst(Array.isArray(m.characters) ? m.characters : (m.characters ? [m.characters] : []));
    const charHtml = chars.length
      ? chars.map(c => `<span style="color:${CLASS_COLORS[c.class] || 'var(--text)'};">${escapeHtml(c.name)}</span>${c.claim_verified ? ' <span class="bnet-verified" title="Confirmed by their Battle.net account">✓</span>' : ''}${(c.rank || 'Main') !== 'Main' ? '<span class="recruit-sub"> (alt)</span>' : ''}`).join(', ')
      : '<span class="roles-none">No character claimed</span>';
    const id = jsAttr(m.account_id);
    let control;
    if (m.role === 'owner' || isSelf) {
      control = `<span class="roles-badge role-${escapeHtml(m.role)}">${escapeHtml(ROLE_LABELS[m.role] || m.role)}</span>`;
    } else {
      control = `<select class="roles-select" aria-label="Role for ${escapeHtml(memberDisplayName(m))}" onchange="changeMemberRole(${id}, this.value)"${ROLES.busy ? ' disabled' : ''}>
          ${['viewer', 'member', 'officer'].map(r => `<option value="${r}"${m.role === r ? ' selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}
        </select>
        ${isOwner ? `<button class="btn-secondary recruit-small-btn" title="Hand this team over to them -- you become an officer" onclick="transferTeamOwnership(${id})">Make owner</button>` : ''}
        <button class="survey-editor-icon" title="Remove from the team" onclick="removeTeamMember(${id})">✕</button>`;
    }
    return `<div class="roles-row">
      <div class="roles-main">
        <div class="roles-name">${escapeHtml(memberDisplayName(m))}${isSelf ? '<span class="recruit-sub"> · you</span>' : ''}</div>
        <div class="roles-chars">${charHtml}</div>
      </div>
      <div class="roles-control">${control}</div>
    </div>`;
  }).join('');

  const alone = members.length <= 1;
  panel.innerHTML = `
    <div class="season-header">
      <div>
        <div class="season-title">Roles</div>
        <div class="recruit-sub">${counts || 'Nobody yet'}. Officers can change anyone's role except the owner's.</div>
      </div>
      <div class="season-header-actions"><button class="btn-secondary recruit-small-btn" onclick="showInviteModal()">Invite people</button></div>
    </div>
    <div class="roles-legend">
      ${ROLE_INFO.map(([k, l, d]) => `<div class="roles-legend-item"><span class="roles-badge role-${k}">${l}</span><span>${escapeHtml(d)}</span></div>`).join('')}
    </div>
    <div class="season-section">
      ${rows}
      ${alone ? `<div class="recruit-empty-filter">Nobody else has joined yet. Send your invite link -- once people sign in, pick your officers here.</div>` : ''}
    </div>`;
}

// Runs a role change / removal / transfer, then refreshes this tab and the owner nudge.
async function rolesAction(fn) {
  if (ROLES.busy) return;
  ROLES.busy = true;
  try {
    await fn();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    ROLES.busy = false;
    await loadRolesTab();
    loadOfficerNudge();
  }
}

function changeMemberRole(accountId, role) {
  const m = (ROLES.members || []).find(x => x.account_id === accountId);
  if (!m) return;
  const name = memberDisplayName(m);
  if (role === 'officer' && !confirm(`Make ${name} an Officer? Officers can edit the roster, plan Raid Night, invite people, and use Team Management.`)) {
    renderRolesTab();
    return;
  }
  return rolesAction(async () => {
    await updateMemberInDB(accountId, role, null, STATE.teamId);
    showToast(`${name} is now ${ROLE_LABELS[role] === 'Officer' ? 'an Officer' : 'a ' + ROLE_LABELS[role]}`, 'success');
  });
}

function removeTeamMember(accountId) {
  const m = (ROLES.members || []).find(x => x.account_id === accountId);
  if (!m || !confirm(`Remove ${memberDisplayName(m)} from the team? Their claimed characters are released. They can rejoin with an invite link.`)) return;
  return rolesAction(async () => {
    const resp = await fetch('/api/members?action=removeMember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, targetAccountId: accountId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to remove member');
    showToast(`${memberDisplayName(m)} removed`, 'success');
  });
}

// Hands the team to another member; the owner steps down to officer.
function transferTeamOwnership(accountId) {
  const m = (ROLES.members || []).find(x => x.account_id === accountId);
  if (!m) return;
  const name = memberDisplayName(m);
  if (!confirm(`Make ${name} the owner of this team? You'll become an officer, and only ${name} will be able to hand it back.`)) return;
  return rolesAction(async () => {
    const resp = await fetch('/api/guild?action=transferOwner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, targetAccountId: accountId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to transfer ownership');
    applyRolePermissions('officer');
    showToast(`${name} is now the owner. You're an officer.`, 'success');
  });
}

function openRolesTab() {
  showTab('team');
  const btn = [...document.querySelectorAll('#team-subtab-filter .filter-btn')].find(b => (b.getAttribute('onclick') || '').includes("'roles'"));
  if (btn) setTeamSubTab('roles', btn);
}

// ── Owner nudge: a new team's owner, once there's a roster, is asked to
// pick officers (or, if nobody's joined yet, to invite people first). Gone
// as soon as the team has an officer, or when dismissed for this team. ──
const officerNudgeKey = () => `raidlead_officer_nudge_hidden_${STATE.teamId}`;

// This team's name -- or the guild's, for a guild with a single default "Main Team".
function currentTeamLabel() {
  const name = STATE.teamName && STATE.teamName !== 'Main Team' ? STATE.teamName : STATE.config?.guild;
  return name || 'your team';
}

async function loadOfficerNudge() {
  const el = document.getElementById('officer-nudge-banner');
  if (!el) return;
  const hide = () => { el.style.display = 'none'; el.innerHTML = ''; };
  let dismissed = false;
  try { dismissed = localStorage.getItem(officerNudgeKey()) === '1'; } catch (e) {}
  if (STATE.myRole !== 'owner' || !STATE.teamId || dismissed || !(STATE.players || []).length) return hide();

  const teamId = STATE.teamId;
  const { members } = await fetchMembersFromDB(teamId);
  if (teamId !== STATE.teamId) return;
  if (!members?.length || members.some(m => m.role === 'officer')) return hide();

  const others = members.filter(m => m.account_id !== AUTH.session?.id);
  const team = escapeHtml(currentTeamLabel());
  el.className = 'survey-banner';
  el.style.display = '';
  el.innerHTML = others.length
    ? `<div class="survey-banner-text"><strong>Want help running ${team}?</strong> Make one or more members an Officer so they can edit the roster, plan Raid Night, and help with recruiting.</div>
       <div class="survey-banner-actions">
         <button class="btn-primary recruit-small-btn" onclick="openRolesTab()">Choose officers</button>
         <button class="btn-secondary recruit-small-btn" onclick="dismissOfficerNudge()">Not now</button>
       </div>`
    : `<div class="survey-banner-text"><strong>Your roster's in.</strong> Invite your raiders next. Once they join, you can pick your officers in Team Management &rarr; Roles.</div>
       <div class="survey-banner-actions">
         <button class="btn-primary recruit-small-btn" onclick="showInviteModal()">Invite people</button>
         <button class="btn-secondary recruit-small-btn" onclick="dismissOfficerNudge()">Not now</button>
       </div>`;
}

function dismissOfficerNudge() {
  try { localStorage.setItem(officerNudgeKey(), '1'); } catch (e) {}
  loadOfficerNudge();
}
