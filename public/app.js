
// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
const STATE = {
  config:       null,
  players:      [],
  rosterRankFilter: 'all', // 'all' | 'main' | 'alt' -- which characters the Roster tab shows/computes stats over
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
  compareDifficulty: 'mythic',     // difficulty for the Compare tab
  compareDate:       null,         // start date (ms timestamp) for benchmark window
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
function scoresKey() { return SCORES_KEY + '_' + (STATE.scoreDifficulty || 'mythic'); }
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

  // Handle auth errors from Battle.net callback
  const authError = urlParams.get('auth_error');
  if (authError) {
    const banner = document.getElementById('auth-error-banner');
    if (banner) {
      banner.textContent = 'Sign in failed: ' + authError.replace(/_/g, ' ') + '. Please try again.';
      banner.style.display = 'block';
    }
    showLoginScreen();
    window.history.replaceState({}, '', '/');
    return;
  }

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
  if (!sessionAccount) { showLoginScreen(); return; }
  AUTH.session = { id: sessionAccount.id, battletag: sessionAccount.battletag };
  try { localStorage.setItem('raidlead_display', JSON.stringify({ battletag: sessionAccount.battletag, displayName: sessionAccount.display_name })); } catch(e) {}

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

      // Gate: new members must claim a character before accessing the dashboard
      if (!STATE.claimedCharacter) {
        showToast('Welcome to ' + STATE.config.guild + '! Please claim your character to continue.', 'success');
        await showClaimGateScreen();
      } else {
        showDashboard();
        loadCachedScores();
        showToast('Welcome to ' + STATE.config.guild + '!', 'success');
      }
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

    // Gate: block access until this account has claimed a character
    if (!STATE.claimedCharacter) {
      showClaimGateScreen();
      return;
    }

    showDashboard();
    updateRosterTitle();
    loadCachedScores();
    // Pre-load attendance data so marks are available immediately on any tab
    loadAttendanceData();
    return;
  }

  // Fall back to localStorage config (share-link or pre-DB flow)
  const saved = loadSavedConfig();
  if (saved && saved.guild) {
    STATE.config   = saved;
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
          if (detected && detected.id !== saved.zoneId) {
            const ackKey = ZONE_ACK_KEY + '_' + detected.id;
            if (!localStorage.getItem(ackKey)) STATE.detectedZone = detected;
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

// Standard class -> armor-type mapping (unchanged across expansions), used
// to group the Tier Token roster grid into Cloth/Leather/Mail/Plate columns.
const ARMOR_TYPE_BY_CLASS = {
  'warrior':'Plate', 'paladin':'Plate', 'death knight':'Plate',
  'hunter':'Mail', 'shaman':'Mail', 'evoker':'Mail',
  'rogue':'Leather', 'monk':'Leather', 'druid':'Leather', 'demon hunter':'Leather',
  'mage':'Cloth', 'priest':'Cloth', 'warlock':'Cloth',
};
const ARMOR_TYPE_ORDER = ['Cloth', 'Leather', 'Mail', 'Plate'];

const RAID_BUFFS = [
  { class:'demon hunter', buff:'3% Magic'    },
  { class:'druid',        buff:'3% Vers'     },
  { class:'evoker',       buff:'Movement'    },
  { class:'hunter',       buff:'3% Damage'   },
  { class:'mage',         buff:'3% Int'      },
  { class:'monk',         buff:'5% Physical' },
  { class:'paladin',      buff:'3% DR'       },
  { class:'priest',       buff:'5% Stam'     },
  { class:'rogue',        buff:'3% Boss DR'  },
  { class:'shaman',       buff:'2% Mastery'  },
  { class:'warrior',      buff:'5% AP'       },
];

const DIFF_MAP = { lfr:1, normal:3, heroic:4, mythic:5 };

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
      document.getElementById('scores-table-wrap').innerHTML = '<div class="empty-state"><div class="empty-state-icon">🛡</div><h3>No ' + diff.toUpperCase() + ' Mitigation Data</h3><p>Click "Refresh Scores" to fetch mitigation data.</p></div>';
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
      document.getElementById('scores-table-wrap').innerHTML = '<div class="empty-state"><div class="empty-state-icon">🛡</div><h3>No ' + diff.toUpperCase() + ' Survival Data</h3><p>Click "Refresh Scores" to fetch survival data.</p></div>';
    }
    return;
  }

  STATE.scores           = [];
  STATE.bossNames        = [];
  STATE.scoresDifficulty = diff;
  const loaded = loadCachedScores();
  if (!loaded) {
    document.getElementById('scores-table-wrap').innerHTML = '<div class="empty-state"><div class="empty-state-icon">📊</div><h3>No ' + diff.toUpperCase() + ' Scores</h3><p>Click "Fetch Scores" to load ' + diff.toUpperCase() + ' data from Warcraft Logs.</p></div>';
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

    // Team-specific fields start blank -- this is a brand new team
    set('inp-wcl', '');
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
  document.getElementById('setup-subheading').textContent = 'Enter your guild details and data source URLs to get started. You only need to do this once.';
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

    set('inp-wcl',       s.wclUrl);
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
  const wclUrl    = document.getElementById('inp-wcl').value.trim();
  const wclTeamId = document.getElementById('inp-wcl-team').value.trim() || null;
  const raidDays  = getRaidDaysFrom('inp-raid-days');

  if (!teamName) {
    setStatus('Please fill in Team Name.', 'error');
    return;
  }

  const zoneMatch = wclUrl ? wclUrl.match(/zone=(\d+)/) : null;
  const zoneId    = zoneMatch ? parseInt(zoneMatch[1]) : null;

  setStatus('Creating team...', 'loading');
  document.getElementById('load-btn').disabled = true;

  try {
    const resp = await fetch('/api/guild?action=addTeam', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, teamName, wclUrl, wclTeamId, zoneId, raidDays }),
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
  const difficulty = 'mythic'; // difficulty is now set per-fetch in WCL Scores tab
  const wclUrl     = document.getElementById('inp-wcl').value.trim();
  const wclTeamId  = document.getElementById('inp-wcl-team').value.trim() || null;
  const multiTeam  = document.querySelector('input[name="inp-multi-team"]:checked')?.value === 'yes';
  const teamName   = (multiTeam ? document.getElementById('inp-team')?.value.trim() : '') || 'Main Team';
  const raidDays   = getRaidDaysFrom('inp-raid-days');

  if (!guild || !server) {
    setStatus('Please fill in Guild Name and Server.', 'error'); return;
  }

  const zoneMatch = wclUrl ? wclUrl.match(/zone=(\d+)/) : null;
  const zoneId    = zoneMatch ? parseInt(zoneMatch[1]) : (STATE.zoneId || null);

  // Merge onto the existing config rather than replacing it outright -- fields this
  // form doesn't own (hasWclCredentials/wclClientId, zoneName, etc.) must survive a save.
  STATE.config = { ...STATE.config, guild, server, region, difficulty, wclUrl, zoneId, wclTeamId, raidDays };
  STATE.zoneId = zoneId;

  setStatus('Saving...', 'loading');
  document.getElementById('load-btn').disabled = true;

  try {
    // Update this team's (and, since it's shared, the guild's) settings.
    const resp = await fetch('/api/guild?action=update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId, guild, server, region, wclUrl, zoneId, teamName, wclTeamId, raidDays }),
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
  const btn = document.getElementById('wowaudit-import-btn');
  if (btn) { btn.textContent = 'Importing...'; btn.disabled = true; }
  try {
    const resp = await fetch('/api/wowaudit?action=import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: STATE.teamId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Import failed');

    await loadRosterFromDB(true);
    renderRoster();
    loadFlexData();
    showToast(`Imported ${data.imported} character${data.imported === 1 ? '' : 's'} from WowAudit!`, 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
  if (btn) { btn.textContent = '⬇ Import from WowAudit'; btn.disabled = false; }
}

// ── ADD/EDIT/REMOVE CHARACTER MODAL (officers only) ──
let CHARACTER_MODAL_EDIT_ID     = null;
let CHARACTER_MODAL_ORIGINAL_NAME = null;

function populateClassDropdown(selectId, selected) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = Object.keys(CLASS_COLORS).map(c =>
    `<option value="${c}">${c.replace(/\b\w/g, ch => ch.toUpperCase())}</option>`
  ).join('');
  if (selected) sel.value = selected;
}

function openAddCharacterModal() {
  CHARACTER_MODAL_EDIT_ID = null;
  CHARACTER_MODAL_ORIGINAL_NAME = null;
  document.getElementById('character-modal-title').textContent = 'Add Character';
  populateClassDropdown('cm-class');
  document.getElementById('cm-name').value = '';
  document.getElementById('cm-role').value = 'ranged';
  document.getElementById('cm-server').value = titleCaseServer(STATE.config?.server);
  document.getElementById('cm-rank').value = 'Main';
  document.getElementById('cm-msg').textContent = '';
  document.getElementById('cm-rename-warning').style.display = 'none';
  document.getElementById('cm-remove-btn').style.display = 'none';
  document.getElementById('character-modal').classList.add('open');
}

function openEditCharacterModal(characterId) {
  const player = STATE.players.find(p => p.id === characterId);
  if (!player) return;
  CHARACTER_MODAL_EDIT_ID = characterId;
  CHARACTER_MODAL_ORIGINAL_NAME = player.name;
  document.getElementById('character-modal-title').textContent = 'Edit Character';
  populateClassDropdown('cm-class', player.class);
  document.getElementById('cm-name').value = player.name;
  document.getElementById('cm-role').value = ['heal', 'healer'].includes(player.role) ? 'heal' : player.role;
  document.getElementById('cm-server').value = player.serverDisplay || player.server || '';
  document.getElementById('cm-rank').value = player.rank || 'Main';
  document.getElementById('cm-msg').textContent = '';
  document.getElementById('cm-rename-warning').style.display = 'none';
  document.getElementById('cm-remove-btn').style.display = 'inline-block';
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
  const role   = document.getElementById('cm-role').value;
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
      ? { teamId: STATE.teamId, characterId: CHARACTER_MODAL_EDIT_ID, name, class: cls, server, role, rank }
      : { teamId: STATE.teamId, name, class: cls, server, role, rank };

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
    showToast('Character removed.', 'success');
  } catch (e) {
    msg.textContent = e.message;
    msg.className   = 'status-msg error';
  }
}

// ─────────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────────
function getKilledBosses() {
  // A boss is "killed" if at least one player has a non-null score for it
  const killed = new Set();
  if (!STATE.scores || !STATE.bossNames) return killed;
  STATE.scores.forEach(player => {
    if (!player.scores) return;
    player.scores.forEach((score, i) => {
      if (score !== null && score !== undefined && STATE.bossNames[i]) {
        killed.add(STATE.bossNames[i]);
      }
    });
  });
  return killed;
}

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

let CLAIM_GATE_UNCLAIMED = [];

async function showClaimGateScreen() {
  hideBootLoader();
  document.getElementById('setup-screen').style.display       = 'none';
  document.getElementById('dashboard').style.display          = 'none';
  document.getElementById('login-screen').style.display       = 'none';
  document.getElementById('guild-setup-screen').style.display = 'none';
  document.getElementById('landing-choice-screen').style.display = 'none';
  document.getElementById('join-guild-screen').style.display  = 'none';
  document.getElementById('main-nav').style.display            = 'none';
  document.getElementById('guild-badge').style.display         = 'none';
  const _shareBtnGate = document.getElementById('share-btn');
  if (_shareBtnGate) _shareBtnGate.style.display = 'none';
  document.getElementById('account-menu').style.display        = 'none';
  document.getElementById('claim-gate-screen').style.display   = 'flex';

  // Figure out which characters are already claimed by ANY account, so we only offer unclaimed ones
  let claimedNames = [];
  try {
    const data = await fetchMembersFromDB();
    const members = data?.members || [];
    claimedNames = members
      .flatMap(m => Array.isArray(m.characters) ? m.characters : (m.characters ? [m.characters] : []))
      .map(c => c.name?.toLowerCase())
      .filter(Boolean);
  } catch(e) { /* if this fails, fall through and show the full roster rather than blocking entirely */ }

  CLAIM_GATE_UNCLAIMED = (STATE.players || []).filter(p => !claimedNames.includes(p.name.toLowerCase()));
  renderClaimGateList();
}

function renderClaimGateList() {
  const search = (document.getElementById('claim-gate-search')?.value || '').toLowerCase().trim();
  const listEl  = document.getElementById('claim-gate-list');
  const emptyEl = document.getElementById('claim-gate-empty');
  if (!listEl) return;

  const filtered = CLAIM_GATE_UNCLAIMED.filter(p => p.name.toLowerCase().includes(search));

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  listEl.innerHTML = filtered
    .sort((a,b) => a.name.localeCompare(b.name))
    .map(p => {
      const color = CLASS_COLORS[p.class] || '#888';
      return `<div onclick="claimMyCharacter(${jsAttr(p.name)})" style="padding:10px 14px; cursor:pointer; border-radius:4px; border:1px solid var(--border); margin-bottom:6px; display:flex; align-items:center; gap:10px; transition:background 0.15s;" onmouseover="this.style.background='var(--bg4)'" onmouseout="this.style.background='transparent'">
        <div style="width:10px; height:10px; border-radius:50%; background:${color};"></div>
        <span style="color:${color}; font-weight:700; font-size:14px;">${escapeHtml(p.name)}</span>
        <span style="color:var(--text-mute); font-size:12px; margin-left:auto;">${escapeHtml(p.class)} · ${escapeHtml(p.serverDisplay || p.server)}</span>
      </div>`;
    }).join('');
}

async function claimMyCharacter(characterName) {
  try {
    const player = STATE.players.find(p => p.name === characterName);
    const resp = await fetch('/api/members?action=claimCharacter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        characterName, teamId: STATE.teamId,
        characterClass: player?.class, characterServer: player?.server, characterRole: player?.role,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Claim failed');
    STATE.claimedCharacter = characterName;
    STATE.claimedCharacters = [{
      id: null, name: characterName, class: player?.class || 'unknown',
      primary_role: player?.role || 'ranged', rank: player?.rank || 'Main',
    }];
    showToast('Character claimed: ' + characterName, 'success');
    showDashboard();
    updateRosterTitle();
    loadCachedScores();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

function showDashboard() {
  hideBootLoader();
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('dashboard').style.display    = 'block';
  document.getElementById('main-nav').style.display     = 'flex';
  document.getElementById('guild-badge').style.display  = 'flex';

  document.getElementById('badge-guild').textContent  = STATE.config.guild;
  document.getElementById('badge-server').textContent = titleCaseServer(STATE.config.server);
  document.getElementById('login-screen').style.display       = 'none';
  document.getElementById('guild-setup-screen').style.display = 'none';
  document.getElementById('claim-gate-screen').style.display  = 'none';
  document.getElementById('landing-choice-screen').style.display = 'none';
  document.getElementById('join-guild-screen').style.display  = 'none';
  document.getElementById('account-menu').style.display       = 'flex';
  if (AUTH.session && AUTH.session.battletag) {
    document.getElementById('account-battletag').textContent  = AUTH.session.battletag;
    document.getElementById('dropdown-battletag').textContent = AUTH.session.battletag;
  }
  if (AUTH.session?.battletag) {
    document.getElementById('account-battletag').textContent  = AUTH.session.battletag;
    document.getElementById('dropdown-battletag').textContent = AUTH.session.battletag;
  }

  // Load cached scores if available for current zone
  loadCachedScores();

  // Restore non-authoritative IDs only until Supabase responds.
  // Role-based UI is applied from DB data, not cached browser state.
  const cachedTeamId  = localStorage.getItem('raidlead_team_id');
  const cachedGuildId = localStorage.getItem('raidlead_guild_id');
  if (!STATE.teamId && cachedTeamId)   STATE.teamId  = cachedTeamId;
  if (!STATE.guildId && cachedGuildId) STATE.guildId = cachedGuildId;

  loadFlexData();
  renderRoster();
  renderPlannerChecklist();
  renderPlannerRoster();

  const cached = loadCachedScores();
  if (cached && cached.zoneId === STATE.zoneId) {
    STATE.scores    = cached.scores;
    STATE.bossNames = cached.bossNames;
    updateScoresFetchBtn(cached.fetchedAt);
  }

  // Fetch guild/role/teamId from Supabase
  fetchActiveGuildData().then(async data => {
    if (data && data.team) {
      applyGuildData(data);
      updateRosterTitle();
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
          // Fetch the plan for that specific date -- NOT the most-recently-published
          // plan overall, which could be for a raid night that's already passed and
          // would otherwise clobber the auto-advanced date.
          const planData = await fetchRaidPlanFromDB(STATE.plannerDate);
          console.log('[Planner] showDashboard fetch:', STATE.teamId, planData?.plan ? 'plan found, members:' + (planData.plan.raid_plan_members?.length || 0) : 'no plan for ' + STATE.plannerDate);
          if (planData && planData.plan) {
            applyPlanData(planData);
          }
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
    if (wrap) wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><h3>Couldn't load attendance</h3><p>${e.message}</p></div>`;
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
    ? `<span style="color:#5865F2;">🔗 Connected</span> <span style="color:var(--text-mute);">(Server ID: ${STATE.discordGuildId})</span>`
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
    content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><h3>Couldn't load progress</h3><p>${e.message}</p></div>`;
  }
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
          ? `Couldn't match your zone ("${data.zoneName || STATE.config?.zoneName || ''}") to a raid on Raider.io yet. This should resolve once Raider.io has indexed the current tier.`
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
      ${boss.iconUrl ? `<img class="progress-boss-icon" src="${boss.iconUrl}" alt="">` : ''}
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
    if (el) el.innerHTML = `<div style="color:var(--text-mute); font-size:13px;">Error loading loot: ${e.message}</div>`;
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
              ${name} <span style="color:var(--gold); font-weight:700;">×${tokensByHolder[name]}</span>
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

  const byArmor = { Plate: [], Mail: [], Leather: [], Cloth: [] };
  chars.forEach(c => {
    const armor = ARMOR_TYPE_BY_CLASS[(c.class || '').toLowerCase()];
    if (armor) byArmor[armor].push(c);
  });
  Object.values(byArmor).forEach(list => list.sort((a, b) => (a.name || '').localeCompare(b.name || '')));

  el.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
      <div class="section-title" style="font-size:14px;">Tier Token Checklist</div>
      ${isOfficer ? `<button class="btn-secondary" style="padding:4px 10px; font-size:12px;" onclick="resetTierChecklist()">Reset for New Tier</button>` : ''}
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:14px;">
      ${ARMOR_TYPE_ORDER.map(armor => `
        <div style="background:var(--bg3); border:1px solid var(--border); border-radius:6px; padding:10px;">
          <div style="font-weight:700; font-size:12px; color:var(--text-mute); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">${armor}</div>
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

    return `
      <div style="background:var(--bg3); border:1px solid ${likelyPug ? 'rgba(196,30,58,0.4)' : 'var(--border)'}; border-radius:6px; padding:14px; margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div>
            <span style="font-weight:700;">${raidDate}</span>
            <span style="color:var(--text-mute); font-size:12px; margin-left:8px;">${bossCount} boss${bossCount === 1 ? '' : 'es'} · ${items.length} item${items.length === 1 ? '' : 's'}</span>
            ${likelyPug ? '<span style="margin-left:8px; font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#ff6b6b; border:1px solid rgba(196,30,58,0.4); border-radius:3px; padding:2px 6px;">Likely PUG</span>' : ''}
          </div>
          ${isOfficer && allowDeleteRun ? `<button class="btn-secondary" style="padding:4px 10px; font-size:12px;" onclick="deleteLootRun('${sessionId}')">Delete Run</button>` : ''}
        </div>
        <div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">
          ${items.map(d => renderLootRow(d, isOfficer)).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function renderLootRow(d, isOfficer) {
  const traded = d.current_holder_name && d.current_holder_name !== d.recipient_name;
  const trackColor = QUALITY_TRACK_COLORS[d.item_quality_track];
  const trackBadge = d.item_quality_track
    ? `<span style="color:${trackColor || 'var(--text-mute)'}; margin-left:6px;">${d.item_quality_track}${d.upgrade_level ? ` ${d.upgrade_level}/${d.upgrade_level_max || '?'}` : ''}</span>`
    : '';
  const metaBits = [d.item_slot, d.armor_type].filter(Boolean).join(' · ');
  return `
    <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:6px 8px; background:var(--bg2); border-radius:4px;">
      <div>
        <span style="font-weight:600;">${d.item_name || ('Item ' + d.item_id)}</span>
        ${d.is_tier_token ? '<span style="color:var(--gold); margin-left:6px;">Tier Token</span>' : ''}
        ${d.is_boe ? '<span style="color:var(--text-mute); margin-left:6px;">BoE</span>' : ''}
        ${trackBadge}
        <span style="color:var(--text-mute); margin-left:6px;">${d.boss_name || 'Trash'}</span>
        ${metaBits ? `<span style="color:var(--text-mute); margin-left:6px;">(${metaBits})</span>` : ''}
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span>${d.current_holder_name || '?'}${traded ? ` <span style="color:var(--text-mute);">(was ${d.recipient_name})</span>` : ''}</span>
        ${isOfficer ? `
          <button class="btn-secondary" style="padding:2px 8px; font-size:11px;" onclick="reassignLootItem('${d.id}')">Reassign</button>
          <button class="btn-secondary" style="padding:2px 8px; font-size:11px; color:#ff6b6b;" onclick="deleteLootItem('${d.id}')">✕</button>
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

  Object.entries(RESOURCES).forEach(([category, items]) => {
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
          <div style="font-size:12px; color:var(--text-mute); line-height:1.5;">${escapeHtml(item.description)}</div>
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

function renderRoster() {
  const players = STATE.rosterRankFilter === 'all'
    ? STATE.players
    : STATE.players.filter(p => (p.rank || 'Main').toLowerCase() === STATE.rosterRankFilter);

  // Stats
  document.getElementById('stat-total').textContent = players.length;
  const zoneDisplay = STATE.zoneName && STATE.zoneName !== '—' ? STATE.zoneName : 'Zone ' + STATE.zoneId;
  document.getElementById('stat-zone').textContent  = zoneDisplay;
  document.getElementById('stat-difficulty').textContent = 'Zone ' + STATE.zoneId;

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

  // Roster by role
  const roles = [
    { key: ['tank'],           label: 'TANKS',   color: '#C79C6E' },
    { key: ['heal', 'healer'], label: 'HEALERS', color: '#1EFF00' },
    { key: ['melee'],          label: 'MELEE',   color: '#FF8000' },
    { key: ['ranged'],         label: 'RANGED',  color: '#69CCF0' },
  ];

  const rosterEl = document.getElementById('roster-by-role');
  rosterEl.innerHTML = '';

  let buffCount = 0;
  const presentClasses = new Set(players.map(p => p.class));
  RAID_BUFFS.forEach(b => { if (presentClasses.has(b.class)) buffCount++; });
  document.getElementById('stat-buffs').textContent = buffCount;

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

function renderRaidBuffs(players) {
  const presentClasses = new Set(players.map(p => p.class));
  const grid = document.getElementById('raid-buffs-grid');
  grid.innerHTML = '';

  RAID_BUFFS.forEach(b => {
    const covered = presentClasses.has(b.class);
    const color   = CLASS_COLORS[b.class] || '#888';
    const card    = document.createElement('div');
    card.className = 'buff-card';
    const buffInner = covered
      ? `<div class="buff-name" style="color:${color};">${b.buff}</div><div class="buff-class" style="color:${color};">${b.class.toUpperCase()}</div>`
      : `<div class="buff-name" style="color:var(--text-dim);">${b.class.toUpperCase()}</div>`;
    card.innerHTML = `
      <div class="buff-indicator ${covered ? 'covered' : 'missing'}"></div>
      <div style="flex:1;">${buffInner}</div>
    `;
    grid.appendChild(card);
  });
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
    // Filter to non-frozen zones (active tiers), take the highest ID
    const active = zones.filter(z => !z.frozen);
    if (active.length === 0) return null;
    active.sort((a, b) => b.id - a.id);
    return active[0];
  } catch(e) {
    console.warn('Zone auto-detect failed:', e);
    return null;
  }
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

async function fetchScores() {
  const btn = document.getElementById('fetch-scores-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Fetching...';

  const wrap = document.getElementById('scores-table-wrap');
  wrap.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><div class="loading-text">Fetching scores from Warcraft Logs...</div></div>';

  try {
    const zoneId = STATE.zoneId;
    const diffId = DIFF_MAP[STATE.scoreDifficulty] || 5;
    const region = toWclRegion(STATE.config.region);
    const healRoles = ['heal', 'healer'];

    const results    = [];
    const bossNames  = [];
    let   bossesSet  = false;

    // Fetch boss IDs for encounterRankings first-kill queries -- re-fetch if we don't
    // have any yet, or if what's cached was fetched for a different zone (e.g. the
    // guild progressed to a new tier since the last time this ran).
    if (!STATE.bossIds || STATE.bossIds.length === 0 || STATE.bossIdsZoneId !== zoneId) {
      try {
        const bosses = await fetchZoneBosses(zoneId);
        STATE.bossIds       = bosses.map(b => b.id);
        STATE.bossOrder     = bosses.map(b => b.name);
        STATE.bossIdsZoneId = zoneId;
      } catch(e) { STATE.bossIds = []; STATE.bossOrder = []; }
    }
    const bossIds   = STATE.bossIds   || [];

    for (const player of STATE.players) {
      const isHealer   = healRoles.includes(player.role);
      const metric     = isHealer ? ', metric: hps' : ', metric: dps';
      const oppoMetric = isHealer ? ', metric: dps' : ', metric: hps';
      const serverSlug = player.server.toLowerCase().replace(/\s+/g, '-').replace(/'/g, '').replace(/[^a-z0-9-]/g, '');

      // Build encounterRankings aliases for each boss (first kill per boss)
      // encounterRankings is also a JSON scalar — alias each boss
      // encounterRankings returns all kills — we sort by startTime to find first kill
      const bossAliases = bossIds.map((id, i) =>
        `boss${i}: encounterRankings(encounterID: ${id}, difficulty: ${diffId}${metric})`
      ).join(' ');

      const query = `query { characterData { character(name: "${player.name}", serverSlug: "${serverSlug}", serverRegion: "${region}") {
        name
        best: zoneRankings(zoneID: ${zoneId}, difficulty: ${diffId}${metric})
        oppo: zoneRankings(zoneID: ${zoneId}, difficulty: ${diffId}${oppoMetric})
        ${bossAliases}
      } } }`;

      try {
        const data     = await wclQuery(query);
        if (data.errors) {
          console.warn('WCL error for', player.name, JSON.stringify(data.errors));
          results.push({ ...player, error: data.errors[0]?.message || 'API error' });
          continue;
        }
        const charData = data?.data?.characterData?.character;
        console.log('WCL result for', player.name, ':', charData ? 'found' : 'not found', '| server:', serverSlug, '| zone:', zoneId);
        // Log raw data for first player to see structure
        if (results.length === 0) {
          console.log('[WCL raw best]', JSON.stringify(charData.best)?.slice(0, 500));
  
        }

        if (!charData || !charData.best) {
          results.push({ ...player, error: 'Not found' });
          continue;
        }

        const parsejson = v => {
          if (!v) return {};
          if (typeof v === 'object') return v;
          try { return JSON.parse(v); } catch(e) { return {}; }
        };
        const zr       = parsejson(charData.best);
        const oppoZr   = parsejson(charData.oppo);
        const rankings = zr.rankings || [];
        const oppoRankings = oppoZr.rankings || [];

        // Always update bossNames from player with most kills
        if (rankings.length > bossNames.length) {
          bossNames.length = 0;
          rankings.forEach(r => bossNames.push(r.encounter?.name || 'Unknown'));
        }

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

        // Death %
        const deaths     = zr.deaths     || 0;
        const totalKills = zr.totalKills || 0;
        const deathPct   = totalKills > 0 ? Math.min(100, ((deaths / totalKills) * 100)).toFixed(1) : 'N/A';

        // First Kill: use per-boss encounterRankings aliases
        // encounterRankings with killType:FastestKills returns all kills sorted fastest first
        // The LAST entry (highest index) per boss = the first kill chronologically (slowest = earliest)
        // Actually we want lowest startTime — sort and take first
        const firstKillMap = {};
        bossIds.forEach((id, i) => {
          const bossName = STATE.bossOrder?.[i];
          if (!bossName) return;
          const raw = charData[`boss${i}`];
          const enc = parsejson(raw);
          const kills = enc.ranks || enc.rankings || enc.data || [];
          if (kills.length === 0) return;
          // Sort by startTime ascending — first entry = first kill
          // Sort by startTime ascending — lowest startTime = earliest kill = first kill
          const sorted = [...kills].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
          const first  = sorted[0];
          if (first?.rankPercent != null) {
            firstKillMap[bossName] = fmt(first.rankPercent);
          }
        });

        // Log first player's first kill data for verification
        if (results.length === 0) {
          console.log('[FirstKill] bossOrder:', STATE.bossOrder);
          console.log('[FirstKill] firstKillMap:', JSON.stringify(firstKillMap));
          // Raw DPS/HPS verification -- check these logged keys for the actual field name
          // if rawMap/oppoRawMap come back empty after deploying.
          console.log('[WCL ranking keys]', rankings[0] ? Object.keys(rankings[0]).join(',') : 'no rankings', '| sample:', JSON.stringify(rankings[0]));
        }

        results.push({
          ...player,
          bestAvg:      fmt(zr.bestPerformanceAverage),
          medianAvg:    fmt(zr.medianPerformanceAverage),
          oppoBestAvg:  fmt(oppoZr.bestPerformanceAverage),
          oppoMedianAvg: fmt(oppoZr.medianPerformanceAverage),
          deathPct,
          rankingMap:   Object.fromEntries(rankings.map(r => [r.encounter?.name, fmt(r.rankPercent)])),
          oppoRankingMap: Object.fromEntries(oppoRankings.map(r => [r.encounter?.name, fmt(r.rankPercent)])),
          rawMap:       Object.fromEntries(rankings.map(r => [r.encounter?.name, rawOf(r)])),
          oppoRawMap:   Object.fromEntries(oppoRankings.map(r => [r.encounter?.name, rawOf(r)])),
          rawNumMap:      Object.fromEntries(rankings.map(r => [r.encounter?.name, rawNumOf(r)])),
          oppoRawNumMap:  Object.fromEntries(oppoRankings.map(r => [r.encounter?.name, rawNumOf(r)])),
          firstKillMap,
          rankings:     rankings.map(r => fmt(r.rankPercent)),
          error:        null,
        });

        await sleep(200);
      } catch(e) {
        results.push({ ...player, error: e.message });
      }
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
          difficulty: STATE.scoreDifficulty || 'mythic',
        }),
      }).catch(() => {});
    }

    const count = results.filter(r => !r.error).length;
    showToast(`Scores fetched for ${count} of ${STATE.players.length} players.`, 'success');
    updateScoresTimestamp(Date.now());
    const fetchBtn = document.getElementById('fetch-scores-btn');
    if (fetchBtn) fetchBtn.textContent = '↻ Refresh Scores';

  } catch(e) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><h3>Error</h3><p>${e.message}</p></div>`;
    showToast('Error: ' + e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = '↻ Refresh Scores';
}

function renderScoresTable(roleFilter) {
  const wrap   = document.getElementById('scores-table-wrap');
  const bosses = STATE.bossNames;
  const view   = STATE.scoreView || 'performance';

  if (!STATE.config?.hasWclCredentials) {
    const isOfficer = ['owner', 'officer'].includes(STATE.myRole);
    wrap.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">🔒</div>
      <h3>Warcraft Logs Not Connected</h3>
      <p>${isOfficer
        ? 'Your guild needs its own Warcraft Logs API credentials before WCL Scores will work.'
        : "Your guild hasn't connected Warcraft Logs API credentials yet — ask an officer to set this up."}</p>
      ${isOfficer ? `
        <div style="display:flex; gap:10px; margin-top:12px;">
          <a class="btn-secondary" style="padding:8px 16px; font-size:13px; text-decoration:none; display:inline-flex; align-items:center;" href="https://www.warcraftlogs.com/api/clients/" target="_blank" rel="noopener noreferrer">Create WCL Credentials ↗</a>
          <button class="btn-primary" onclick="showSetup()">Go to Guild Settings</button>
        </div>
      ` : ''}
    </div>`;
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

  const roleGroups = [
    { keys: ['tank'],                   label: 'TANKS'   },
    { keys: ['heal','healer'],          label: 'HEALERS' },
    { keys: ['melee','ranged','dps'],   label: 'DPS'     },
  ];

  // Sort by whichever column header was last clicked (defaults to 'best'), always
  // highest-to-lowest -- there's no ascending mode, it's not a useful view for this data.
  const sortCol = STATE.scoreSortCol || 'best';
  const sortFn = (a, b) => {
    const av = getScoreSortValue(a, view, sortCol);
    const bv = getScoreSortValue(b, view, sortCol);
    if (isNaN(av) && isNaN(bv)) return 0;
    if (isNaN(av)) return 1;  // NaN always sorts to the bottom
    if (isNaN(bv)) return -1;
    return bv - av;
  };
  const sortArrow = col => STATE.scoreSortCol === col ? ' ▼' : '';

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
    <th style="width:52px; min-width:52px; max-width:52px; text-align:center; cursor:pointer;" onclick="setScoreSort('best')" title="Sort by ${col1Label === 'Average' ? 'Best' : col1Label}">Best${sortArrow('best')}</th><th class="sep-col"></th>
    <th style="width:52px; min-width:52px; max-width:52px; text-align:center; cursor:pointer;" onclick="setScoreSort('median')" title="Sort by Median">Median${sortArrow('median')}</th><th class="sep-col"></th>`
  : `<th style="width:52px; min-width:52px; max-width:52px; text-align:center; cursor:pointer;" onclick="setScoreSort('best')" title="Sort by ${col1Label}">${col1Label}${sortArrow('best')}</th><th class="sep-col"></th>`;

  const bossHeaders = bosses.map(b =>
    `<th style="width:52px; min-width:52px; max-width:52px; overflow:hidden; text-align:center; cursor:pointer;" title="Sort by ${b}" onclick="setScoreSort('${b.replace(/'/g,"\\'")}')">
      <span style="display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px;">${b.substring(0,5)}${sortArrow(b)}</span>
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
    let players = STATE.scores.filter(p => group.keys.includes(p.role));
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
          return `<td class="score-cell" title="${bossName}" style="width:52px; min-width:52px; max-width:52px; background:${bg}; color:${fg}; font-family:Rajdhani,sans-serif; font-weight:700; font-size:13px; text-align:center;">${disp}</td>`;
        }).join('');
        html += `<tr>
          <td style="width:110px; max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            <div class="player-name-cell">
              <div class="class-dot" style="background:${color};"></div>
              <span style="color:${color}; font-family:'Rajdhani',sans-serif; font-weight:600; cursor:pointer;"
                onclick="openProfileByName(${jsAttr(p.name)})">${escapeHtml(p.name)}</span>
            </div>
          </td>
          <td style="color:var(--text-mute); font-family:'Rajdhani',sans-serif;">${escapeHtml(p.serverDisplay || p.server || '—')}</td>
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
          return `<td class="score-cell" title="${bossName}" style="width:52px; min-width:52px; max-width:52px; background:${bg}; color:${fg}; font-family:Rajdhani,sans-serif; font-weight:700; font-size:13px; text-align:center;">${disp}</td>`;
        }).join('');
        html += `<tr>
          <td style="width:110px; max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            <div class="player-name-cell">
              <div class="class-dot" style="background:${color};"></div>
              <span style="color:${color}; font-family:'Rajdhani',sans-serif; font-weight:600; cursor:pointer;"
                onclick="openProfileByName(${jsAttr(p.name)})">${escapeHtml(p.name)}</span>
            </div>
          </td>
          <td style="color:var(--text-mute); font-family:'Rajdhani',sans-serif;">${escapeHtml(p.serverDisplay || p.server || '—')}</td>
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
          return `<td class="score-cell" title="${bossName}" style="width:52px; min-width:52px; max-width:52px; background:${bg}; color:${fg}; font-family:Rajdhani,sans-serif; font-weight:700; font-size:13px; text-align:center;">${val}</td>`;
        }).join('');
        // Return early with firstkill-specific row
        html += `<tr>
          <td style="width:110px; max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            <div class="player-name-cell">
              <div class="class-dot" style="background:${color};"></div>
              <span style="color:${color}; font-family:'Rajdhani',sans-serif; font-weight:600; cursor:pointer;"
                onclick="openProfileByName(${jsAttr(p.name)})">${escapeHtml(p.name)}</span>
            </div>
          </td>
          <td style="color:var(--text-mute); font-family:'Rajdhani',sans-serif;">${escapeHtml(p.serverDisplay || p.server || '—')}</td>
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
        <td class="score-cell" style="width:52px; background:${bestColor}; color:${bestColor ? '#000' : 'var(--text-mute)'}; font-weight:700; font-size:13px; text-align:center;">${bestAvgVal || '—'}</td>
        <td class="sep-col"></td>
        <td class="score-cell" style="width:52px; min-width:52px; max-width:52px; background:${col2Bg}; color:${col2Fg}; font-weight:700; font-size:13px; text-align:center;">${col2Val}</td>
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
        const showVal = STATE.scoreShowRaw ? (raw || '—') : val;
        const bg = !STATE.scoreShowRaw && val !== 'N/A' ? parseColor(parseFloat(val)) : '';
        const fg = STATE.scoreShowRaw ? 'var(--text-dim)' : (bg ? (parseFloat(val) < 25 ? '#fff' : '#000') : 'var(--text-mute)');
        const fw = STATE.scoreShowRaw ? 400 : 700;
        return `<td class="score-cell" title="${bossName}" style="width:52px; min-width:52px; max-width:52px; background:${bg}; color:${fg}; font-family:Rajdhani,sans-serif; font-weight:${fw}; font-size:13px; text-align:center;">${showVal}</td>`;
      }).join('');

      if (view !== 'firstkill') {
        html += `<tr>
          <td style="width:110px; max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            <div class="player-name-cell">
              <div class="class-dot" style="background:${color};"></div>
              <span style="color:${color}; font-family:'Rajdhani',sans-serif; font-weight:600; cursor:pointer;"
                onclick="openProfileByName(${jsAttr(p.name)})">${escapeHtml(p.name)}</span>
            </div>
          </td>
          <td style="color:var(--text-mute); font-family:'Rajdhani',sans-serif;">${escapeHtml(p.serverDisplay || p.server || '—')}</td>
          ${summaryCols}
          ${bossCols}
        </tr>`;
      }
    });
  });

  html += '</tbody></table></div>';
  wrap.innerHTML = html;
}

// Debug function — call from console: diagSurvival('REPORTCODE', fightId, startTime, endTime)
window.diagSurvival = async function(reportCode, fightId, startTime, endTime) {
  const resp = await fetch('/api/roster?action=diagSurvival', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: STATE.teamId, reportCode, fightId, startTime, endTime }),
  });
  const data = await resp.json();
  console.log('[diagSurvival] result:', JSON.stringify(data, null, 2));
  return data;
};

// Debug function — call from console: diagMitigation('REPORTCODE', fightId, startTime, endTime)
window.diagMitigation = async function(reportCode, encounterID, targetName) {
  const resp = await fetch('/api/roster?action=diagMitigation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: STATE.teamId, reportCode, encounterID, targetName }),
  });
  const data = await resp.json();
  console.log('[diagMitigation] result:', JSON.stringify(data, null, 2));
  return data;
};

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
  const diffId     = DIFF_MAP[STATE.scoreDifficulty] || 5;
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
        guildName, serverSlug, region, zoneId, diffId,
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
    const mitKey = 'raidlead_mitigation_' + zoneId + '_' + (STATE.scoreDifficulty || 'mythic');
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
  const diff   = STATE.scoreDifficulty || 'mythic';
  const diffId = {'lfr':1,'normal':3,'heroic':4,'mythic':5}[diff] || 5;
  const key    = 'raidlead_mitigation_' + zoneId + '_' + diff;
  if (STATE.teamId) {
    fetch('/api/roster?action=getMitigationCache&teamId=' + STATE.teamId + '&zoneId=' + (STATE.zoneId||'') + '&diffId=' + diffId)
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
  const diffId     = DIFF_MAP[STATE.scoreDifficulty] || 5;
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
      guildName, serverSlug, region, zoneId, diffId,
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
    const survivalCacheKey = 'raidlead_survival_' + zoneId + '_' + STATE.scoreDifficulty;
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
        difficulty: 'surv_' + (STATE.scoreDifficulty || 'mythic'),
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
  const diff   = STATE.scoreDifficulty || 'mythic';
  const diffId = {'lfr':1,'normal':3,'heroic':4,'mythic':5}[diff] || 5;
  const key    = 'raidlead_survival_' + zoneId + '_' + diff;

  // Always check Supabase for latest (cross-device sync)
  if (STATE.teamId) {
    fetch(`/api/roster?action=getSurvivalCache&teamId=${STATE.teamId}&zoneId=${STATE.zoneId || ''}&diffId=${diffId}`)
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

function filterScores(role, btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  STATE.scoreRoleFilter = role;
  renderScoresTable(role);
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
// current score view. `column` is either 'best', 'median', or a boss name.
function getScoreSortValue(player, view, column) {
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
  if (STATE.scoreShowRaw && ['performance','oppoparse'].includes(view)) {
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
        <div class="profile-stat-value" style="color:${bestColor};">${scoreData.bestAvg}</div>
      </div>
      <div class="profile-stat">
        <div class="profile-stat-label">Median Avg</div>
        <div class="profile-stat-value" style="color:${medianColor};">${scoreData.medianAvg}</div>
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
          <div class="boss-name">${boss}</div>
          <div class="boss-bar"><div class="boss-bar-fill" style="width:${w}%; background:${c};"></div></div>
          <div class="boss-parse" style="color:${c};">${val}</div>
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
  const requestedDifficulty = STATE.scoreDifficulty || 'mythic';
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
  const zoneEl = document.getElementById('stat-zone');
  if (zoneEl) zoneEl.textContent = STATE.zoneName || 'Zone ' + STATE.zoneId;
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

function loadPlannerState() {
  try {
    const saved = localStorage.getItem(PLANNER_KEY);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  } catch(e) { return new Set(); }
}

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
    document.getElementById('planner-edit-btn').style.display    = 'block';
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

// Load the plan for a specific raid date, clearing selections if none exists
async function loadPlanForDate(dateStr) {
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

  const planData = await fetchRaidPlanFromDB(dateStr);
  console.log('[Planner] loadPlanForDate', dateStr, planData?.plan ? 'found' : 'none');
  if (planData?.plan) {
    applyPlanData(planData);
  }
  // No plan: already cleared above
  // Reflect published state in the badge
  const badge = document.getElementById('plan-status-badge');
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
    if (editBtn) editBtn.style.display = 'block';
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
    if (pubBtn) pubBtn.style.display = 'block';
    const importBtn = document.getElementById('planner-import-btn');
    if (importBtn) importBtn.style.display = 'inline-flex';
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
    pill.innerHTML = `<div class="class-dot" style="background:${color}; border:1px solid ${color};"></div><span style="color:${color};">${escapeHtml(p.name)}</span><span style="margin-left:auto; font-size:10px; color:#FF6666; text-transform:uppercase; letter-spacing:1px;">Out</span>`;
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
      <span style="color:${textColor}; text-shadow: 0 1px 2px rgba(0,0,0,0.4);">${escapeHtml(name)}</span>
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
        ${outTag}
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

  // Raid buffs for tonight
  const presentClasses = new Set(selected.map(p => p.class));
  const buffsEl = document.getElementById('plan-buffs');
  buffsEl.innerHTML = '';
  RAID_BUFFS.forEach(b => {
    const covered = presentClasses.has(b.class);
    const color   = CLASS_COLORS[b.class] || '#888';
    const card    = document.createElement('div');
    card.style.cssText = `
      background: var(--bg2);
      border: 1px solid ${covered ? color + '66' : 'var(--border)'};
      border-radius: 6px;
      padding: 8px 10px;
      display: flex; align-items: center; gap: 8px;
      min-width: 130px;
    `;
    card.innerHTML = `
      <div class="buff-indicator ${covered ? 'covered' : 'missing'}"></div>
      <div>
        <div style="font-size:12px; font-weight:700; color:${covered ? color : 'var(--text-mute)'};">${covered ? b.buff : b.class.toUpperCase()}</div>
        ${covered ? `<div style="font-size:10px; color:${color}; letter-spacing:1px;">${b.class.toUpperCase()}</div>` : ''}
      </div>
    `;
    buffsEl.appendChild(card);
  });

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
        pill.innerHTML = `<div class="class-dot" style="background:${textColor}22; border:1px solid ${textColor}44;"></div><span style="color:${textColor}; text-shadow: 0 1px 2px rgba(0,0,0,0.4);">${escapeHtml(p.name)}</span>`;
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

// saveSession / loadSession are no longer used for auth —
// session is now an HttpOnly cookie managed server-side.
// These stubs remain so any lingering call sites don't throw.
function saveSession(_token) {}
function loadSession() { return null; }

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
    item.className = 'dropdown-item mobile-nav-item' + (btn.classList.contains('active') ? ' active' : '');
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
  document.getElementById('claim-gate-screen').style.display  = 'none';
  document.getElementById('main-nav').style.display           = 'none';
  document.getElementById('guild-badge').style.display        = 'none';
  const _shareBtnSetup = document.getElementById('share-btn');
  if (_shareBtnSetup) _shareBtnSetup.style.display = 'none';
  document.getElementById('account-menu').style.display       = 'flex';
  document.getElementById('landing-choice-screen').style.display = 'flex';
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
  document.getElementById('claim-gate-screen').style.display     = 'none';
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

  const freshData = await fetchGuildFromDB(joinData.teamId);
  if (!freshData || !freshData.team) throw new Error('Joined, but could not load team data. Try refreshing the page.');
  applyGuildData(freshData);
  await loadRosterFromDB();

  if (!STATE.claimedCharacter) {
    showToast('Welcome to ' + STATE.config.guild + '! Please claim your character to continue.', 'success');
    await showClaimGateScreen();
  } else {
    showDashboard();
    loadCachedScores();
    showToast('Welcome to ' + STATE.config.guild + '!', 'success');
  }
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
  const guild      = document.getElementById('gs-guild').value.trim();
  const server     = document.getElementById('gs-server').value.trim();
  const region     = document.getElementById('gs-region').value;
  const difficulty = 'mythic'; // difficulty is now set per-fetch in WCL Scores tab
  const multiTeam = document.querySelector('input[name="multi-team"]:checked')?.value === 'yes';
  const teamNameEl = document.getElementById('gs-team');
  const teamName   = multiTeam && teamNameEl ? teamNameEl.value.trim() || 'Main Team' : 'Main Team';
  const wclUrl     = document.getElementById('gs-wcl').value.trim();
  const wclTeamId  = document.getElementById('gs-wcl-team').value.trim() || null;
  const raidDays   = getRaidDaysFrom('gs-raid-days');

  if (!guild || !server) {
    document.getElementById('gs-status').textContent = 'Please fill in Guild Name and Server.';
    document.getElementById('gs-status').className   = 'status-msg error';
    return;
  }

  const zoneMatch = wclUrl.match(/zone=(\d+)/);
  const zoneId    = zoneMatch ? parseInt(zoneMatch[1]) : null;

  document.getElementById('gs-status').textContent = 'Creating guild...';
  document.getElementById('gs-status').className   = 'status-msg loading';

  try {
    const resp = await fetch('/api/guild?action=create', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        },
      body: JSON.stringify({ guild, server, region, difficulty, teamName, wclUrl, zoneId, wclTeamId, raidDays, confirmNewTeam: !!confirmNewTeam }),
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

    // Populate full STATE (including the teams list) now that the team row exists
    const freshGuildData = await fetchGuildFromDB(data.team?.id);
    if (!freshGuildData || !freshGuildData.team) throw new Error('Created, but could not load team data. Try refreshing the page.');
    applyGuildData(freshGuildData);

    await loadRosterFromDB();

    // A brand-new guild has no roster yet (no WowAudit import or manual adds
    // have happened), so there's nothing to claim from -- skip straight to
    // the dashboard rather than showing a claim gate with nobody to pick.
    if (!STATE.claimedCharacter && STATE.players.length > 0) {
      await showClaimGateScreen();
    } else {
      showDashboard();
      loadCachedScores();
    }

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
function renderMemberClaimSection(members) {
  const claimedEl = document.getElementById('member-claimed-char');
  const pickerEl  = document.getElementById('member-claim-picker');
  if (!claimedEl || !pickerEl) return;

  const me = (members || []).find(m => m.account_id === AUTH.session?.id);
  const chars = Array.isArray(me?.characters) ? me.characters : (me?.characters ? [me.characters] : []);

  if (chars.length === 0) {
    claimedEl.textContent = 'No character claimed yet — claim one below:';
  } else {
    claimedEl.innerHTML = chars.map(c => {
      const color = CLASS_COLORS[c.class] || '#888';
      const rankBadge = c.rank ? `<span style="color:var(--text-mute); font-size:11px; text-transform:uppercase; letter-spacing:1px;">${escapeHtml(c.rank)}</span>` : '';
      return `<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
        <span style="color:${color}; font-weight:700; font-size:16px;">${escapeHtml(c.name)}</span>
        <span style="color:var(--text-mute); font-size:12px;">${escapeHtml(c.class)} · ${escapeHtml(c.primary_role)}</span>
        ${rankBadge}
        <button onclick="releaseCharacterClaim('${escapeHtml(c.name)}')" title="Release this character" style="background:none; border:none; color:var(--text-mute); cursor:pointer; font-size:14px; line-height:1; padding:0 2px;">✕</button>
      </div>`;
    }).join('');
  }

  pickerEl.innerHTML = `<button class="btn-secondary" style="font-size:12px; padding:6px 12px;" onclick="showClaimCharacter('${AUTH.session?.id}')">+ Claim ${chars.length ? 'Another ' : 'a '}Character</button>`;
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
      STATE.claimedCharacter  = guildData.claimedCharacter || null;
      STATE.claimedCharacters = guildData.claimedCharacters || [];
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

  const isOwner   = STATE.myRole === 'owner';
  const isOfficer = ['owner','officer'].includes(STATE.myRole);

  el.innerHTML = members.map(m => {
    // accounts may be an object or array depending on Supabase join
    const acct = Array.isArray(m.accounts) ? m.accounts[0] : m.accounts;
    const bt          = acct?.battletag || 'Unknown';
    const displayName = acct?.display_name || null;
    // characters may also be array -- a member can claim more than one (Main + Alt(s))
    const chars = Array.isArray(m.characters) ? m.characters : (m.characters ? [m.characters] : []);
    const charNames = chars.map(c => c.name).filter(Boolean);
    const accountId = m.account_id;
    const isSelf = AUTH.session?.id === accountId;
    const discordId = acct?.discord_id || null;

    return `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:var(--bg3); border:1px solid var(--border); border-radius:6px; margin-bottom:8px;">
      <div>
        <div style="font-size:14px; font-weight:700;">
          <span style="color:${displayName ? 'var(--text)' : 'var(--gold)'};">${displayName || bt}</span>
          ${isSelf ? '<span style="font-size:10px; color:var(--text-mute);"> · you</span>' : ''}
        </div>
        <div style="font-size:12px; color:var(--text-mute); margin-top:2px;">
          ${charNames.length
            ? `<span style="color:var(--text-dim);">Character${charNames.length > 1 ? 's' : ''}: <strong>${charNames.join(', ')}</strong></span>`
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
              ? `<span style="font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:var(--gold);" title="Change ownership from Guild Settings">Owner</span>`
              : `<select onchange="updateRoleFromDB('${accountId}', this.value)"
                  style="background:var(--bg2); border:1px solid var(--border); border-radius:4px; color:var(--text); font-family:'Rajdhani',sans-serif; font-size:13px; padding:4px 8px; cursor:pointer;">
                  <option value="viewer"  ${m.role==='viewer'  ?'selected':''}>Viewer</option>
                  <option value="member"  ${m.role==='member'  ?'selected':''}>Member</option>
                  <option value="officer" ${m.role==='officer'?'selected':''}>Officer</option>
                  ${isOwner ? `<option value="owner" ${m.role==='owner'?'selected':''}>Owner</option>` : ''}
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
        STATE.claimedCharacter  = guildData.claimedCharacter || null;
        STATE.claimedCharacters = guildData.claimedCharacters || [];
        renderAttendanceCharacterPicker();
      }
    }
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

function renderMembersList() {
  const el = document.getElementById('members-list');
  // For now show stored guild members from localStorage
  // Will be replaced with Supabase query once DB integration is complete
  const members = JSON.parse(localStorage.getItem('raidlead_members') || '[]');

  if (members.length === 0) {
    el.innerHTML = '<div style="color:var(--text-mute); font-size:13px; padding:8px 0;">No members have signed in yet. Share the invite link to get started.</div>';
    return;
  }

  el.innerHTML = members.map(m => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:var(--bg3); border:1px solid var(--border); border-radius:6px; margin-bottom:8px;">
      <div>
        <div style="font-size:14px; font-weight:700; color:var(--gold);">${escapeHtml(m.battletag)}</div>
        <div style="font-size:12px; color:var(--text-mute);">
          ${m.character ? `<span style="color:var(--text-dim);">Playing: ${escapeHtml(m.character)}</span>` : '<span style="color:#ff6b6b;">No character claimed</span>'}
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <select onchange="updateMemberRole(${jsAttr(m.battletag)}, this.value)"
          style="background:var(--bg2); border:1px solid var(--border); border-radius:4px; color:var(--text); font-family:'Rajdhani',sans-serif; font-size:13px; padding:4px 8px; cursor:pointer;">
          <option value="viewer"  ${m.role === 'viewer'  ? 'selected' : ''}>Viewer</option>
          <option value="member"  ${m.role === 'member'  ? 'selected' : ''}>Member</option>
          <option value="officer" ${m.role === 'officer' ? 'selected' : ''}>Officer</option>
          <option value="owner"   ${m.role === 'owner'   ? 'selected' : ''}>Owner</option>
        </select>
      </div>
    </div>
  `).join('');
}

function renderUnclaimedList() {
  const el = document.getElementById('unclaimed-list');
  const members = JSON.parse(localStorage.getItem('raidlead_members') || '[]');
  const claimedChars = members.filter(m => m.character).map(m => m.character.toLowerCase());

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

function updateMemberRole(battletag, role) {
  const members = JSON.parse(localStorage.getItem('raidlead_members') || '[]');
  const idx = members.findIndex(m => m.battletag === battletag);
  if (idx >= 0) {
    members[idx].role = role;
    localStorage.setItem('raidlead_members', JSON.stringify(members));
    showToast('Updated ' + battletag + ' to ' + role, 'success');
  }
}

// Register new member when they join via invite
function registerMember(battletag) {
  const members = JSON.parse(localStorage.getItem('raidlead_members') || '[]');
  if (!members.find(m => m.battletag === battletag)) {
    members.push({ battletag, role: 'member', character: null, joinedAt: Date.now() });
    localStorage.setItem('raidlead_members', JSON.stringify(members));
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

  const config = {
    guild:       t.guilds?.name || null,
    server:      t.guilds?.server || null,
    region:      t.guilds?.region || 'us',
    difficulty:  t.difficulty || 'mythic',
    wclUrl:      t.wcl_url || '',
    wclTeamId:   t.wcl_team_id || null,
    zoneId:      t.zone_id || null,
    zoneName:    t.zone_name || '',
    raidDays:    t.raid_days || [],
    hasWclCredentials: t.hasWclCredentials || false,
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
  STATE.claimedCharacter  = guildData.claimedCharacter || null;
  STATE.claimedCharacters = guildData.claimedCharacters || [];
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
  applyRolePermissions(STATE.myRole);
  renderTeamSwitcher();
  return true;
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
  if (!STATE.claimedCharacter) { showClaimGateScreen(); return; }
  showDashboard();
  updateRosterTitle();
  STATE.scores = []; STATE.bossNames = []; STATE.scoresDifficulty = null;
  STATE.survivorMap = {}; STATE.survivorFetched = false; STATE.survivorMapDifficulty = null;
  STATE.mitigationMap = {}; STATE.mitigationFetched = false; STATE.mitigationMapDifficulty = null;
  loadCachedScores();
  loadAttendanceData();
  if (typeof loadPlanForDate === 'function' && STATE.plannerDate) loadPlanForDate(STATE.plannerDate);
}

// Renders the team switcher in the header -- only shown when the account
// belongs to more than one team, invisible otherwise.
function renderTeamSwitcher() {
  const wrap = document.getElementById('team-switcher-wrap');
  if (!wrap) return;
  if (!STATE.teams || STATE.teams.length < 2) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = 'inline-block';
  wrap.innerHTML = `<select onchange="switchActiveTeam(this.value)" style="background:var(--bg3); border:1px solid var(--border); border-radius:4px; color:var(--gold); font-family:'Rajdhani',sans-serif; font-size:13px; font-weight:600; padding:6px 10px; cursor:pointer;">
    ${STATE.teams.map(t => `<option value="${t.teamId}" ${t.teamId === STATE.teamId ? 'selected' : ''}>${escapeHtml(t.guildName || '')} — ${escapeHtml(t.teamName || '')}</option>`).join('')}
  </select>`;
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

  // Compare tab fetch button — officers only
  const compareFetchBtn = document.getElementById('compare-fetch-btn');
  if (compareFetchBtn) compareFetchBtn.style.display = isOfficer ? 'inline-flex' : 'none';

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
}

// The Import button is officer-only AND needs a WowAudit key connected --
// called both from applyRolePermissions (role changes) and after
// saving/clearing the key in Guild Settings (STATE.config changes).
function updateWowauditImportBtn() {
  const btn = document.getElementById('wowaudit-import-btn');
  if (!btn) return;
  const isOfficer = ['owner', 'officer'].includes(STATE.myRole);
  btn.style.display = (isOfficer && STATE.config?.hasWowauditKey) ? 'inline-flex' : 'none';
}

// ─────────────────────────────────────────────
//  DISPLAY NAME
// ─────────────────────────────────────────────
async function saveDisplayName(name) {
  if (!token || !name.trim()) return;
  try {
    await fetch('/api/members?action=updateDisplayName', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: name.trim() }),
    });
    if (AUTH.session) AUTH.session.displayName = name.trim();
    ORIGINAL_DISPLAY_NAME = name.trim();
    updateDisplayNameSaveState();
    showToast('Display name saved!', 'success');
  } catch(e) {
    showToast('Error saving display name', 'error');
  }
}

function showToast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast ' + type + ' show';
  setTimeout(() => t.className = 'toast ' + type, 3000);
}
// ═══════════════════════════════════════════════════════════════
//  COMPARE TAB — Progression Benchmark
// ═══════════════════════════════════════════════════════════════

// ── Init: set default date and region badge when tab first opens ──
function initCompareTab() {
  // Only initialise once
  if (document.getElementById('compare-date-input').value) return;

  // Default: 7 days ago
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const yyyy = sevenDaysAgo.getFullYear();
  const mm   = String(sevenDaysAgo.getMonth() + 1).padStart(2, '0');
  const dd   = String(sevenDaysAgo.getDate()).padStart(2, '0');
  document.getElementById('compare-date-input').value = `${yyyy}-${mm}-${dd}`;
  // Use local midnight so the date doesn't shift due to UTC offset
  const [y, m, d] = [`${sevenDaysAgo.getFullYear()}`, String(sevenDaysAgo.getMonth()+1).padStart(2,'0'), String(sevenDaysAgo.getDate()).padStart(2,'0')];
  STATE.compareDate = new Date(parseInt(y), parseInt(m)-1, parseInt(d), 0, 0, 0).getTime();

  // Show region badge from guild config
  const region = STATE.config?.region || localStorage.getItem('raidlead_config')
    ? JSON.parse(localStorage.getItem('raidlead_config') || '{}').region
    : 'us';
  const badge = document.getElementById('compare-region-badge');
  if (badge) badge.textContent = (region || 'US').toUpperCase();

  // Load cached benchmark data if available (so all members see last fetch)
  try {
    const cacheKey = 'raidlead_benchmark_' + STATE.zoneId + '_' + (STATE.compareDifficulty || 'mythic');
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.benchmarkData && cached.bosses) {
      const ageHours = (Date.now() - cached.fetchedAt) / 3600000;
      document.getElementById('compare-content').innerHTML =
        `<div style="padding:8px 0 12px; font-size:11px; color:var(--text-mute); letter-spacing:1px;">
          SHOWING CACHED DATA FROM ${new Date(cached.fetchedAt).toLocaleString()} — ${ageHours < 1 ? 'Just fetched' : Math.round(ageHours) + 'h ago'}
        </div>`;
      renderCompareTab(cached.bosses, cached.benchmarkData, {}, cached.startMs);
    }
  } catch(e) {}
}

function setCompareDifficulty(diff, btn) {
  STATE.compareDifficulty = diff;
  document.querySelectorAll('#compare-diff-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function onCompareDateChange() {
  const val = document.getElementById('compare-date-input').value;
  if (val) {
    // Parse as local time to avoid UTC offset shifting the date back by one day
    const [y, m, d] = val.split('-').map(Number);
    STATE.compareDate = new Date(y, m - 1, d, 0, 0, 0).getTime();
  }
}

// ── Main fetch orchestrator ──
async function fetchCompareData() {
  const btn = document.getElementById('compare-fetch-btn');
  const content = document.getElementById('compare-content');
  if (!STATE.config) {
    showToast('Guild not configured', 'error'); return;
  }
  if (!STATE.config.wclUrl) {
    showToast('WCL Guild Progress URL not set in Guild Settings', 'error'); return;
  }

  btn.textContent = '⟳ Loading...';
  btn.disabled = true;
  content.innerHTML = '<div class="empty-state" style="padding:60px;"><div class="empty-state-icon" style="font-size:32px; animation: spin 1s linear infinite;">⟳</div><p style="margin-top:16px; color:var(--text-mute);">Fetching progression data…</p></div>';

  // Add spinner keyframe if not already present
  if (!document.getElementById('compare-spin-style')) {
    const s = document.createElement('style');
    s.id = 'compare-spin-style';
    s.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
    document.head.appendChild(s);
  }

  try {
    const diffId     = DIFF_MAP[STATE.compareDifficulty] || 5;
    const zoneId     = STATE.zoneId;
    const region     = toWclRegion((STATE.config.region || 'us').toLowerCase());
    const guildName  = STATE.config.guild;
    const serverSlug = (STATE.config.server || '').toLowerCase().replace(/\s+/g, '-');
    const startMs    = STATE.compareDate || (Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endMs      = Date.now();

    // Extract WCL guild ID from the progress URL (e.g. /guild/progress/201271?zone=46)
    const wclUrl    = STATE.config.wclUrl || '';
    const guildIdMatch = wclUrl.match(/\/guild\/progress\/(\d+)/);
    const wclGuildId   = guildIdMatch ? parseInt(guildIdMatch[1]) : null;

    if (!zoneId) { showToast('Zone ID not set — check Guild Settings', 'error'); return; }

    // ── Step 1: Get boss list for the zone ──
    const bosses = await fetchZoneBosses(zoneId);
    if (!bosses.length) { showToast('Could not load boss list for this zone', 'error'); return; }

    // ── Step 2: Single server-side call for own guild + benchmark ──
    console.log('[Compare] sending:', { guildName, serverSlug, region, zoneId, diffId, startMs: new Date(startMs).toISOString(), bossCount: bosses.length });
    const resp = await fetch('/api/roster?action=progression', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId: STATE.teamId,
        guildName, serverSlug, region, zoneId, diffId,
        startMs, endMs,
        wclGuildId,
        bossIds: bosses.map(b => b.id),
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to fetch progression data');
    }
    const { benchmark: benchmarkData } = await resp.json();

    // Cache results locally so non-officers see last fetched data
    try {
      localStorage.setItem('raidlead_benchmark_' + STATE.zoneId + '_' + STATE.compareDifficulty,
        JSON.stringify({ benchmarkData, bosses, startMs, fetchedAt: Date.now() }));
    } catch(e) {}
    const killedBosses = getKilledBosses();
    renderCompareTab(bosses, benchmarkData, killedBosses, startMs);
  } catch(err) {
    console.error('Compare fetch error:', err);
    content.innerHTML = `<div class="empty-state" style="padding:60px;"><div class="empty-state-icon">⚠</div><h3>Error Loading Data</h3><p>${err.message}</p></div>`;
  } finally {
    btn.textContent = '⚔ Fetch Data';
    btn.disabled = false;
  }
}

// ── Fetch your own guild's reports and aggregate pull counts ──
async function fetchOwnProgression(guildName, serverSlug, region, zoneId, diffId) {
  const query = `query {
    reportData {
      reports(
        guildName: "${guildName}"
        guildServerSlug: "${serverSlug}"
        guildServerRegion: "${region}"
        zoneID: ${zoneId}
        limit: 100
        startTime: 0
      ) {
        data {
          code
          startTime
          fights(killType: All) {
            id
            encounterID
            name
            kill
            averageItemLevel
            startTime
            endTime
            difficulty
          }
        }
      }
    }
  }`;

  const resp = await wclQuery(query);
  const reports = resp?.data?.reportData?.reports?.data || [];

  // Aggregate pulls per encounter
  const byEncounter = {};
  for (const report of reports) {
    for (const fight of (report.fights || [])) {
      if (!fight.encounterID || fight.encounterID === 0) continue;
      // Filter to selected difficulty
      if (fight.difficulty && fight.difficulty !== diffId) continue;
      if (!byEncounter[fight.encounterID]) {
        byEncounter[fight.encounterID] = {
          encounterID: fight.encounterID,
          name:        fight.name,
          pulls:       0,
          kills:       [],
        };
      }
      byEncounter[fight.encounterID].pulls++;
      if (fight.kill) {
        byEncounter[fight.encounterID].kills.push({
          date:  new Date(report.startTime + fight.startTime).getTime(),
          ilvl:  fight.averageItemLevel || 0,
          duration: Math.round((fight.endTime - fight.startTime) / 1000),
        });
      }
    }
  }
  return byEncounter;
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

// ── Fetch benchmark (guild rankings) per boss ──
async function fetchBenchmarkData(bosses, diffId, region, startMs, endMs) {
  const results = {};
  // Run up to 3 boss queries at a time to stay within rate limits
  const chunkSize = 3;
  for (let i = 0; i < bosses.length; i += chunkSize) {
    const chunk = bosses.slice(i, i + chunkSize);
    await Promise.all(chunk.map(async boss => {
      try {
        const query = `query {
          worldData {
            encounter(id: ${boss.id}) {
              id
              name
              guildRankings(
                difficulty: ${diffId}
                serverRegion: "${region}"
                page: 1
              )
            }
          }
        }`;
        const resp = await wclQuery(query);
        const raw  = resp?.data?.worldData?.encounter?.guildRankings;

        // guildRankings returns JSON scalar — parse if string
        let rankings = [];
        if (typeof raw === 'string') {
          try { rankings = JSON.parse(raw).rankings || []; } catch(e) {}
        } else if (raw?.rankings) {
          rankings = raw.rankings;
        }

        // Filter to date window
        const filtered = rankings.filter(r => {
          const ts = r.startTime || r.start_time || 0;
          return ts >= startMs && ts <= endMs;
        });

        results[boss.id] = filtered;
      } catch(e) {
        results[boss.id] = [];
      }
    }));
  }
  return results;
}

// ── Render the full Compare tab ──
function renderCompareTab(bosses, benchmarkData, killedBosses, startMs) {

  console.log('[Compare] bosses:', bosses.map(b => b.id + ':' + b.name));
  // Log full benchmark for first 2 bosses
  const benchEntries = Object.entries(benchmarkData).slice(0,2);
  benchEntries.forEach(([id, rows]) => {
    console.log('[Compare] benchmark boss', id, '— count:', rows.length, '— first row:', rows[0] ? JSON.stringify(rows[0]) : 'none');
  });
  const startLabel = new Date(startMs).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  const region     = (STATE.config?.region || 'US').toUpperCase();
  const diff       = STATE.compareDifficulty.charAt(0).toUpperCase() + STATE.compareDifficulty.slice(1);

  let html = '';
  for (const boss of bosses) {
    const killed     = killedBosses.has(boss.name);
    const benchObj   = benchmarkData[boss.id] || {};
    const bench      = benchObj.kills || (Array.isArray(benchObj) ? benchObj : []);
    const hitMaxPages = benchObj.hitMaxPages || false;
    html += renderBossCard(boss, killed, bench, hitMaxPages, startLabel, region, diff);
  }

  document.getElementById('compare-content').innerHTML = html ||
    '<div class="empty-state" style="padding:60px;"><div class="empty-state-icon">🔍</div><h3>No Boss Data Found</h3><p>Check that your WCL Zone and Guild Name are configured correctly.</p></div>';
}

function renderBossCard(boss, killed, bench, hitMaxPages, startLabel, region, diff) {
  // ── Benchmark section ──
  const benchCount = bench.length;
  const hasBench   = benchCount > 0;
  // hitMaxPages: boss was killed by many guilds, all before the date window

  const benchRows = hasBench ? bench.slice(0, 50).map((r, i) => {
    const gName   = r.guild?.name   || r.guildName  || '—';
    const server  = r.guild?.server?.name || r.server?.name || r.serverName || '—';
    const ts      = r.startTime     || r.start_time || 0;
    const dateStr = ts ? new Date(ts).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '—';
    // bracketData holds ilvl in WCL guild rankings; may also be under ilvl or averageItemLevel
    const ilvlRaw = r.bracketData ?? r.ilvl ?? r.averageItemLevel ?? '—';
    const ilvl    = typeof ilvlRaw === 'number' ? ilvlRaw.toFixed(1) : ilvlRaw;
    // duration is in ms in WCL guild rankings
    const durSec  = r.duration ? (r.duration > 100000 ? Math.round(r.duration / 1000) : r.duration) : 0;
    const dur     = durSec ? formatDuration(durSec) : '—';
    const rank    = r.rank  || (i + 1);
    return `<tr>
      <td style="color:var(--text-mute); font-size:11px;">${rank}</td>
      <td style="color:var(--gold); font-weight:600;">${gName}</td>
      <td style="color:var(--text-mute); font-size:12px;">${server}</td>
      <td style="color:var(--text-dim);">${dateStr}</td>
      <td style="color:var(--text-dim);">${typeof ilvl === 'number' ? ilvl.toFixed(1) : ilvl}</td>
      <td style="color:var(--text-dim);">${dur}</td>
    </tr>`;
  }).join('') : '';

  return `
  <div class="compare-boss-card" style="
    background:var(--bg2); border:1px solid var(--border); border-radius:6px;
    margin-bottom:16px; overflow:hidden;">

    <!-- Boss header -->
    <div style="display:flex; align-items:center; justify-content:space-between;
                padding:12px 16px; border-bottom:1px solid var(--border);
                background:var(--bg3);">
      <div style="font-family:'Cinzel',serif; font-size:15px; color:var(--gold); letter-spacing:1px;">
        ${escapeHtml(boss.name)}
      </div>
      <div style="font-size:11px; color:var(--text-mute); letter-spacing:1px; text-transform:uppercase;">
        ${diff}
      </div>
    </div>

    <div>

      <!-- BENCHMARK -->
      <div style="padding:14px 16px;">

        ${killed ? `
        <div style="padding:10px 14px; margin-bottom:12px; background:rgba(30,255,0,0.05);
                    border:1px solid rgba(30,255,0,0.2); border-radius:4px;
                    font-family:'Cinzel',serif; font-size:13px; color:#1EFF00; letter-spacing:1px;">
          ⚔ ${escapeHtml(STATE.config?.guild || 'Your Guild')} has defeated ${escapeHtml(boss.name)}!
        </div>` : ''}
        <div style="font-size:11px; letter-spacing:1px; color:var(--text-dim); font-weight:600; text-transform:uppercase; margin-bottom:10px;">
          ${region} Guilds — Since ${startLabel}
          <span style="margin-left:8px; background:rgba(200,168,75,0.1); border:1px solid var(--border);
                       border-radius:10px; padding:1px 8px; color:var(--gold-dim);">
            ${benchCount} kill${benchCount !== 1 ? 's' : ''}
          </span>
        </div>
        ${hasBench ? `
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:12px; font-family:'Rajdhani',sans-serif;">
            <thead>
              <tr style="border-bottom:1px solid var(--border);">
                <th style="text-align:left; padding:4px 6px; color:var(--text-mute); font-size:10px; letter-spacing:1px;">#</th>
                <th style="text-align:left; padding:4px 6px; color:var(--text-mute); font-size:10px; letter-spacing:1px;">GUILD</th>
                <th style="text-align:left; padding:4px 6px; color:var(--text-mute); font-size:10px; letter-spacing:1px;">SERVER</th>
                <th style="text-align:left; padding:4px 6px; color:var(--text-mute); font-size:10px; letter-spacing:1px;">DATE</th>
                <th style="text-align:left; padding:4px 6px; color:var(--text-mute); font-size:10px; letter-spacing:1px;">ILVL</th>
                <th style="text-align:left; padding:4px 6px; color:var(--text-mute); font-size:10px; letter-spacing:1px;">DURATION</th>
              </tr>
            </thead>
            <tbody>${benchRows}</tbody>
          </table>
        </div>` :
        `<div style="padding:16px 0; display:flex; align-items:center; gap:12px;">
          <div style="font-size:24px; opacity:0.4;">${hitMaxPages ? '📅' : '🔍'}</div>
          <div>
            <div style="font-size:13px; color:var(--text-dim); font-weight:600; margin-bottom:2px;">
              ${hitMaxPages ? 'All recent kills are before this window' : 'No first kills found in this window'}
            </div>
            <div style="font-size:11px; color:var(--text-mute);">
              ${hitMaxPages
                ? 'This boss was killed by many guilds before ' + startLabel + '. Try an earlier date to see recent results.'
                : 'No ' + diff + ' guilds in ' + region + ' have killed this boss since ' + startLabel + '.'}
            </div>
          </div>
        </div>`}
      </div>
    </div>
  </div>`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

