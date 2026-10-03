// ============================================================
// settingsWindow.js — the settings window's script (its own file so the
// window's content policy can allow only scripts that ship with the app).
// Talks to main.js only through preload.js's window.raidlead bridge.
// ============================================================
const el = (id) => document.getElementById(id);
let config = {};

function appendLog(line) {
  const box = el('log');
  box.textContent += line + '\n';
  box.scrollTop = box.scrollHeight;
}

async function refreshWowStatus() {
  const running = await window.raidlead.getWowStatus();
  const box = el('wow-status');
  if (running === null || running === undefined) { box.textContent = 'Checking for WoW...'; return; }
  box.textContent = running ? '🟢 WoW is running — actively syncing.' : '⚪ WoW isn\'t running — waiting quietly in the background.';
}

async function refreshUpdateStatus() {
  const status = await window.raidlead.getUpdateStatus();
  const box = el('update-status');
  if (!status || !status.available) { box.style.display = 'none'; return; }
  box.replaceChildren(`An update is available (v${status.version}, you're on v${status.current}) — `);
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = 'download it from RaidLead';
  link.style.cssText = 'color:#4ade80; text-decoration:underline;';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    window.raidlead.openDownloadLink();
  });
  box.append(link);
  box.style.display = 'block';
}

function renderAccountSection() {
  const loggedIn = !!config.loggedIn;
  el('login-section').style.display = loggedIn ? 'none' : 'block';
  el('account-section').style.display = loggedIn ? 'block' : 'none';
  if (loggedIn) el('deviceLabelDisplay').textContent = config.deviceLabel || 'this device';
}

// The code to type on the RaidLead page while a login waits (null when done).
function showLoginCode(code) {
  el('login-code-box').style.display = code ? 'block' : 'none';
  el('login-code').textContent = code || '';
  if (code) el('login-status').textContent = 'Waiting for you to approve this in your browser...';
}

// On more than one team: which one this PC syncs. Nothing looks chosen
// until a team really is saved ("Choose a team..." until then). Options
// are built as plain text -- team names are typed by officers.
async function populateTeamPickerIfNeeded() {
  const row = el('team-picker-row');
  const hint = el('team-picker-hint');
  if (!config.loggedIn) { row.style.display = 'none'; hint.style.display = 'none'; return; }

  const result = await window.raidlead.getMyTeams();
  if (result.error || !result.teams || result.teams.length <= 1) { row.style.display = 'none'; hint.style.display = 'none'; return; }

  const chosen = result.teams.some(t => t.teamId === result.teamId);
  const picker = el('teamPicker');
  picker.replaceChildren();
  const placeholder = new Option('Choose a team…', '');
  placeholder.disabled = true;
  picker.add(placeholder);
  for (const t of result.teams) picker.add(new Option(`${t.guildName || 'Guild'} — ${t.teamName}`, t.teamId));
  picker.value = chosen ? result.teamId : '';
  row.style.display = 'flex';
  hint.style.display = chosen ? 'none' : 'block';
}

// Where WoW is, how it was found, and whether the addon's in place.
function renderWowInstall(info) {
  if (!info) return;
  el('wowRoot').value = info.wowRoot || '';
  el('browseWow').textContent = info.wowRoot ? 'Change...' : 'Browse...';
  el('wow-found-hint').textContent = !info.wowRoot
    ? 'Couldn\'t find World of Warcraft automatically. Click Browse and pick your World of Warcraft folder (or any folder inside it).'
    : info.auto
      ? 'Found automatically, from where Battle.net installed it. Which account is yours is worked out every time, so there\'s nothing to pick.'
      : 'The folder you picked. Which account is yours is worked out every time, so there\'s nothing to pick.';
  const status = el('addon-status');
  status.style.display = info.wowRoot ? 'block' : 'none';
  status.style.color = info.addonInstalled ? '#4ade80' : '#e5a53d';
  status.textContent = info.addonInstalled ? '✓ RaidLead addon installed' : (info.addonProblem || '');
}

async function refreshWowInstall() {
  renderWowInstall(await window.raidlead.getWowInstall());
}

async function init() {
  config = await window.raidlead.getConfig();
  refreshWowInstall();
  el('autoStart').checked = config.autoStart !== false;
  renderAccountSection();
  populateTeamPickerIfNeeded();

  const existingLog = await window.raidlead.getLog();
  existingLog.forEach(appendLog);
  window.raidlead.onLog(appendLog);
  window.raidlead.onLoginCode(showLoginCode);

  refreshWowStatus();
  refreshUpdateStatus();
  setInterval(refreshWowStatus, 10000);
  setInterval(refreshUpdateStatus, 10000);
  setInterval(refreshWowInstall, 10000); // notices the addon being copied in
}

el('browseWow').addEventListener('click', async () => {
  const result = await window.raidlead.browseWowFolder();
  if (!result) return;
  if (result.error) {
    const status = el('addon-status');
    status.textContent = result.error;
    status.style.color = '#e5a53d';
    status.style.display = 'block';
    return;
  }
  config = await window.raidlead.getConfig();
  renderWowInstall(result);
});

el('autoStart').addEventListener('change', async () => {
  config = await window.raidlead.setConfig({ autoStart: el('autoStart').checked });
});

el('syncNow').addEventListener('click', async () => {
  appendLog('Syncing...');
  await window.raidlead.syncNow();
});

el('loginBtn').addEventListener('click', async () => {
  el('loginBtn').disabled = true;
  el('login-status').textContent = 'Opening your browser to approve this app...';
  const result = await window.raidlead.login();
  el('loginBtn').disabled = false;
  showLoginCode(null);
  if (result.error) {
    el('login-status').textContent = 'Error: ' + result.error;
    return;
  }
  el('login-status').textContent = '';
  config = await window.raidlead.getConfig();
  renderAccountSection();
  populateTeamPickerIfNeeded();
});

el('logoutBtn').addEventListener('click', async () => {
  el('logoutBtn').disabled = true;
  config = await window.raidlead.logout();
  el('logoutBtn').disabled = false;
  renderAccountSection();
});

el('teamPicker').addEventListener('change', async () => {
  if (!el('teamPicker').value) return;
  config = await window.raidlead.setTeam(el('teamPicker').value);
  el('team-picker-hint').style.display = 'none';
});

init();
