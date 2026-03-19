'use strict';

// ==========================================================================
// OnlineProjectPlanner – Main Application State & UI
// ==========================================================================

// --- User color system ---
const BASE_COLORS = [
  '#2196F3','#4CAF50','#FF9800','#9C27B0','#F44336',
  '#009688','#E91E63','#3F51B5','#795548','#00BCD4'
];

/**
 * Generate 10 color variations from a base color.
 * Returns array of hex strings.
 */
function generateColorVariations(hex) {
  const [r, g, b] = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  const vars = [];
  // 10 variations: 5 lighter, base, 4 darker/shifted
  const lightnesses = [0.85, 0.75, 0.65, 0.55, 0.45, hsl[2], 0.35, 0.28, 0.22, 0.15];
  for (let i = 0; i < 10; i++) {
    const l = Math.max(0.1, Math.min(0.95, lightnesses[i]));
    vars.push(hslToHex(hsl[0], hsl[1], l));
  }
  return vars;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#',''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, l = (max+min)/2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max) {
      case r: h = ((g-b)/d + (g<b?6:0))/6; break;
      case g: h = ((b-r)/d + 2)/6; break;
      default: h = ((r-g)/d + 4)/6;
    }
  }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p,q,t) => {
      if(t<0)t+=1; if(t>1)t-=1;
      if(t<1/6)return p+(q-p)*6*t;
      if(t<1/2)return q;
      if(t<2/3)return p+(q-p)*(2/3-t)*6;
      return p;
    };
    const q = l<0.5 ? l*(1+s) : l+s-l*s;
    const p = 2*l-q;
    r=hue2rgb(p,q,h+1/3); g=hue2rgb(p,q,h); b=hue2rgb(p,q,h-1/3);
  }
  return '#' + [r,g,b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');
}

// ==========================================================================
// Application State
// ==========================================================================

const state = {
  user: null,
  teams: [],
  members: {},        // teamId -> []
  projects: {},       // teamId -> []
  currentTeam: null,
  currentProject: null,
  ganttEntries: [],   // current project's entries
  todos: [],          // current project's todos
  dependencies: [],   // current project's gantt dependencies
  lastSync: 0,
  selectedGanttIds: new Set(),
  undoStack: [],
};

// ==========================================================================
// API Helpers
// ==========================================================================

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(apiUrl(url), opts);
  if (!res.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The server did not return a valid response. Check that the api/ folder is uploaded and PHP is enabled.');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

// ==========================================================================
// WebSocket
// ==========================================================================

let ws = null;
let wsReconnectTimer = null;
let wsFailCount = 0;
const WS_MAX_RETRIES = 3; // Stop trying after a few failures (e.g. PHP hosting)

function connectWS() {
  if (wsFailCount >= WS_MAX_RETRIES) return; // Give up – rely on polling
  if (ws && ws.readyState === WebSocket.OPEN) return;
  let wsUrl;
  if (API_BASE && API_BASE !== '.') {
    // Derive WebSocket URL from the configured API_BASE
    try {
      const url = new URL(API_BASE);
      const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${proto}//${url.host}/ws`;
    } catch { return; } // Invalid API_BASE for WS
  } else {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${proto}//${location.host}/ws`;
  }
  try {
    ws = new WebSocket(wsUrl);
  } catch { wsFailCount++; return; }

  ws.onopen = () => {
    wsFailCount = 0;
    setSyncStatus('synced');
    if (state.user) ws.send(JSON.stringify({ type: 'auth', userId: state.user.id, projectId: state.currentProject?.id }));
  };

  ws.onmessage = (evt) => {
    try { handleWSMessage(JSON.parse(evt.data)); } catch {}
  };

  ws.onclose = () => {
    wsFailCount++;
    if (wsFailCount < WS_MAX_RETRIES) {
      setSyncStatus('error');
      wsReconnectTimer = setTimeout(connectWS, 3000);
    } else {
      // WS unavailable (e.g. PHP hosting) – polling handles sync
      setSyncStatus('synced');
    }
  };

  ws.onerror = () => { ws.close(); };
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'gantt_created':
      if (msg.entry.project_id === state.currentProject?.id) {
        const existing = state.ganttEntries.findIndex(e => e.id === msg.entry.id);
        if (existing === -1) state.ganttEntries.push(msg.entry);
        else state.ganttEntries[existing] = msg.entry;
        window.ganttModule?.render();
      }
      break;
    case 'gantt_updated':
      if (msg.entry.project_id === state.currentProject?.id) {
        const idx = state.ganttEntries.findIndex(e => e.id === msg.entry.id);
        if (idx !== -1) state.ganttEntries[idx] = msg.entry;
        else state.ganttEntries.push(msg.entry);
        window.ganttModule?.render();
      }
      break;
    case 'gantt_deleted':
      if (msg.project_id === state.currentProject?.id) {
        state.ganttEntries = state.ganttEntries.filter(e => e.id !== msg.entry_id);
        window.ganttModule?.render();
      }
      break;
    case 'todo_created':
    case 'todo_updated':
      if (msg.todo.project_id === state.currentProject?.id) {
        const idx = state.todos.findIndex(t => t.id === msg.todo.id);
        if (idx !== -1) state.todos[idx] = msg.todo;
        else state.todos.push(msg.todo);
        window.todoModule?.render();
      }
      break;
    case 'todo_deleted':
      if (msg.project_id === state.currentProject?.id) {
        state.todos = state.todos.filter(t => t.id !== msg.todo_id);
        window.todoModule?.render();
      }
      break;
    case 'dep_created':
      if (msg.dep && msg.dep.project_id === state.currentProject?.id) {
        if (!state.dependencies.some(d => d.id === msg.dep.id)) {
          state.dependencies.push(msg.dep);
        }
        window.ganttModule?.render();
      }
      break;
    case 'dep_deleted':
      if (msg.project_id === state.currentProject?.id) {
        state.dependencies = state.dependencies.filter(d => d.id !== msg.dep_id);
        window.ganttModule?.render();
      }
      break;
    case 'project_created':
    case 'project_updated': {
      const teamId = msg.project.team_id;
      if (!state.projects[teamId]) state.projects[teamId] = [];
      const idx = state.projects[teamId].findIndex(p => p.id === msg.project.id);
      if (idx !== -1) state.projects[teamId][idx] = msg.project;
      else state.projects[teamId].push(msg.project);
      if (state.currentTeam?.id === teamId) renderProjectsList();
      break;
    }
    case 'project_deleted': {
      for (const tid of Object.keys(state.projects)) {
        state.projects[tid] = state.projects[tid].filter(p => p.id !== msg.project_id);
      }
      if (state.currentProject?.id === msg.project_id) {
        state.currentProject = null;
        showWelcome();
      }
      if (state.currentTeam) renderProjectsList();
      break;
    }
    case 'member_added': {
      if (!state.members[msg.team_id]) state.members[msg.team_id] = [];
      const exists = state.members[msg.team_id].some(m => m.id === msg.user.id);
      if (!exists) state.members[msg.team_id].push({ ...msg.user, role: 'member' });
      if (state.currentTeam?.id === msg.team_id) renderMembersList();
      break;
    }
    case 'member_removed': {
      if (state.members[msg.team_id]) {
        state.members[msg.team_id] = state.members[msg.team_id].filter(m => m.id !== msg.user_id);
      }
      if (state.currentTeam?.id === msg.team_id) renderMembersList();
      break;
    }
    case 'team_updated': {
      const idx = state.teams.findIndex(t => t.id === msg.team.id);
      if (idx !== -1) state.teams[idx] = { ...state.teams[idx], ...msg.team };
      if (state.currentTeam?.id === msg.team.id) {
        state.currentTeam = state.teams[idx];
        document.getElementById('capacityInput').value = state.currentTeam.capacity_hours_month;
        window.ganttModule?.render();
      }
      break;
    }
  }
}

// ==========================================================================
// Sync (polling fallback every 2 seconds)
// ==========================================================================

let syncTimer = null;

function startSync() {
  stopSync();
  syncTimer = setInterval(async () => {
    if (!state.currentProject) return;
    // Skip polling if WebSocket is active and connected
    if (ws && ws.readyState === WebSocket.OPEN && wsFailCount === 0) return;
    try {
      setSyncStatus('syncing');
      const data = await api('GET', `/api/sync/${state.currentProject.id}?since=${state.lastSync}`);
      state.lastSync = data.server_time;
      let changed = false;
      for (const entry of data.gantt) {
        const idx = state.ganttEntries.findIndex(e => e.id === entry.id);
        if (idx !== -1) state.ganttEntries[idx] = entry;
        else state.ganttEntries.push(entry);
        changed = true;
      }
      for (const todo of data.todos) {
        const idx = state.todos.findIndex(t => t.id === todo.id);
        if (idx !== -1) state.todos[idx] = todo;
        else state.todos.push(todo);
        changed = true;
      }
      for (const dep of (data.dependencies || [])) {
        if (!state.dependencies.some(d => d.id === dep.id)) {
          state.dependencies.push(dep);
          changed = true;
        }
      }
      if (changed) {
        window.ganttModule?.render();
        window.todoModule?.render();
      }
      setSyncStatus('synced');
    } catch { setSyncStatus('error'); }
  }, 2000);
}

function stopSync() {
  if (syncTimer) clearInterval(syncTimer);
}

function setSyncStatus(status) {
  const dot = document.querySelector('.sync-dot');
  const label = document.querySelector('.sync-label');
  dot.className = 'sync-dot';
  if (status === 'syncing') { dot.classList.add('syncing'); label.textContent = 'Syncing…'; }
  else if (status === 'error') { dot.classList.add('error'); label.textContent = 'Offline'; }
  else { label.textContent = 'Synced'; }
}

// ==========================================================================
// Init
// ==========================================================================

async function init() {
  try {
    const data = await api('GET', '/api/auth/me');
    state.user = data.user;
  } catch {
    window.location.href = 'index.html';
    return;
  }

  renderUserAvatar();
  renderBaseColorPicker();
  await loadTeams();
  connectWS();
  startSync();
  setupEventListeners();
}

// ==========================================================================
// Render helpers
// ==========================================================================

function renderUserAvatar() {
  const btn = document.getElementById('userAvatarBtn');
  const initial = document.getElementById('userInitial');
  initial.textContent = state.user.username[0].toUpperCase();
  btn.style.background = state.user.base_color;
  document.getElementById('panelUsername').textContent = state.user.username;
  document.getElementById('panelEmail').textContent = state.user.email;
}

function renderBaseColorPicker() {
  const container = document.getElementById('baseColorPicker');
  container.innerHTML = '';
  BASE_COLORS.forEach(color => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (color === state.user.base_color ? ' selected' : '');
    sw.style.background = color;
    sw.title = color;
    sw.addEventListener('click', async () => {
      await api('PUT', '/api/auth/me', { base_color: color });
      state.user.base_color = color;
      renderUserAvatar();
      renderBaseColorPicker();
    });
    container.appendChild(sw);
  });
}

async function loadTeams() {
  const data = await api('GET', '/api/teams');
  state.teams = data.teams;
  renderTeamsList();
}

function renderTeamsList() {
  const list = document.getElementById('teamsList');
  list.innerHTML = '';
  state.teams.forEach(team => {
    const li = document.createElement('div');
    li.className = 'sidebar-item' + (state.currentTeam?.id === team.id ? ' active' : '');
    li.innerHTML = `<span class="sidebar-item-name">${escHtml(team.name)}</span>`;
    li.addEventListener('click', () => selectTeam(team));
    list.appendChild(li);
  });
}

async function selectTeam(team) {
  state.currentTeam = team;
  renderTeamsList();
  document.getElementById('projectSection').style.display = '';
  document.getElementById('memberSection').style.display = '';
  document.getElementById('teamNameLabel').textContent = escHtml(team.name);
  document.getElementById('breadcrumbTeam').textContent = team.name;

  // Load projects
  const pdata = await api('GET', `/api/projects?team_id=${team.id}`);
  state.projects[team.id] = pdata.projects;
  renderProjectsList();

  // Load members
  const tdata = await api('GET', `/api/teams/${team.id}`);
  state.members[team.id] = tdata.members;
  renderMembersList();

  // Update capacity input
  document.getElementById('capacityInput').value = team.capacity_hours_month;
}

function renderProjectsList() {
  const list = document.getElementById('projectsList');
  list.innerHTML = '';
  const projects = state.projects[state.currentTeam?.id] || [];
  projects.forEach(proj => {
    const li = document.createElement('div');
    li.className = 'sidebar-item' + (state.currentProject?.id === proj.id ? ' active' : '');
    li.innerHTML = `<span class="sidebar-item-name">${escHtml(proj.name)}</span>`;
    li.addEventListener('click', () => selectProject(proj));
    list.appendChild(li);
  });
}

function renderMembersList() {
  const list = document.getElementById('membersList');
  list.innerHTML = '';
  const members = state.members[state.currentTeam?.id] || [];
  members.forEach(m => {
    const li = document.createElement('div');
    li.className = 'sidebar-item';
    const initials = m.username[0].toUpperCase();
    li.innerHTML = `
      <span class="sidebar-item-dot" style="background:${m.base_color}"></span>
      <span class="sidebar-item-name">${escHtml(m.username)}</span>
      <span style="font-size:10px;color:var(--text-muted)">${m.role}</span>
    `;
    list.appendChild(li);
  });
}

async function selectProject(project) {
  state.currentProject = project;
  state.selectedGanttIds.clear();
  renderProjectsList();
  document.getElementById('breadcrumbProject').textContent = project.name;
  document.getElementById('welcomeScreen').classList.add('hidden');
  document.getElementById('projectView').classList.remove('hidden');

  // Load gantt + todos + dependencies
  const [gdata, tdata, ddata] = await Promise.all([
    api('GET', `/api/gantt/${project.id}`),
    api('GET', `/api/todos/${project.id}`),
    api('GET', `/api/dependencies/${project.id}`),
  ]);
  state.ganttEntries = gdata.entries;
  state.todos = tdata.todos;
  state.dependencies = ddata.dependencies;
  state.lastSync = Date.now();

  // Init WS with project context
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'auth', userId: state.user.id, projectId: project.id }));
  }

  window.ganttModule?.init();
  window.todoModule?.render();
}

function showWelcome() {
  document.getElementById('welcomeScreen').classList.remove('hidden');
  document.getElementById('projectView').classList.add('hidden');
  document.getElementById('breadcrumbProject').textContent = '—';
}

// ==========================================================================
// Event listeners
// ==========================================================================

function setupEventListeners() {
  // Sidebar toggle
  document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });

  // User panel toggle
  document.getElementById('userAvatarBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('userPanel').classList.toggle('hidden');
  });
  document.addEventListener('click', () => {
    document.getElementById('userPanel').classList.add('hidden');
    document.getElementById('contextMenu').classList.add('hidden');
  });

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    window.location.href = 'index.html';
  });

  // Backup
  document.getElementById('backupBtn').addEventListener('click', async () => {
    try {
      const res = await fetch(apiUrl('/api/backup'), { credentials: 'include' });
      if (!res.ok) throw new Error('Backup failed');
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'planner_backup_' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Backup failed: ' + e.message);
    }
  });

  // Show version in user panel
  (async () => {
    try {
      const res = await fetch('version.json', { cache: 'no-cache' });
      if (res.ok) {
        const data = await res.json();
        const el = document.getElementById('appVersion');
        if (el) el.textContent = 'v' + data.version;
      }
    } catch {}
  })();

  // Update app
  document.getElementById('updateBtn').addEventListener('click', () => {
    openModal('Update Application', `
      <div style="display:flex;gap:0;margin-bottom:12px;border-bottom:2px solid var(--border)">
        <button type="button" id="updateTabGithub" class="btn btn-secondary" style="border-radius:6px 6px 0 0;border-bottom:2px solid var(--primary);font-size:13px;padding:6px 16px">From GitHub</button>
        <button type="button" id="updateTabUpload" class="btn btn-secondary" style="border-radius:6px 6px 0 0;border-bottom:2px solid transparent;font-size:13px;padding:6px 16px;opacity:.6">Upload ZIP</button>
      </div>
      <div id="updatePanelGithub">
        <p style="font-size:13px;margin-bottom:12px;color:var(--text-muted)">
          Select a version from the GitHub repository to download and install.
          Your database and all user data will be preserved.
        </p>
        <div class="form-group">
          <label>Available versions</label>
          <select id="ghVersionSelect" style="width:100%;padding:6px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text)">
            <option value="">Loading…</option>
          </select>
        </div>
        <div id="ghReleaseNotes" style="display:none;font-size:12px;color:var(--text-muted);margin-bottom:10px;max-height:100px;overflow:auto;padding:6px 8px;background:var(--bg-secondary);border-radius:4px;white-space:pre-wrap"></div>
      </div>
      <div id="updatePanelUpload" style="display:none">
        <p style="font-size:13px;margin-bottom:12px;color:var(--text-muted)">
          Upload a ZIP file containing the new version of the <strong>public</strong> folder.
          Your database and all user data will be preserved.
        </p>
        <div class="form-group">
          <label>Select update ZIP file</label>
          <input type="file" id="updateZipFile" accept=".zip" style="font-size:13px">
        </div>
      </div>
      <div id="updateProgress" class="update-progress" style="display:none">
        <div class="progress-bar"><div class="progress-bar-fill" id="updateProgressBar" style="width:0%"></div></div>
        <div class="update-status" id="updateStatus">Uploading…</div>
      </div>
    `, async () => {
      const progressDiv = document.getElementById('updateProgress');
      const progressBar = document.getElementById('updateProgressBar');
      const statusEl = document.getElementById('updateStatus');

      // Determine which tab is active
      const isGithubTab = document.getElementById('updatePanelGithub').style.display !== 'none';

      if (isGithubTab) {
        // --- GitHub download flow ---
        const select = document.getElementById('ghVersionSelect');
        if (!select.value) { alert('Please select a version'); return; }

        progressDiv.style.display = '';
        statusEl.textContent = 'Downloading from GitHub…';
        statusEl.className = 'update-status';
        progressBar.style.width = '20%';
        progressBar.style.background = '';

        try {
          progressBar.style.width = '40%';
          const res = await fetch(apiUrl('/api/update-from-github'), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: select.value })
          });

          progressBar.style.width = '80%';

          if (!res.headers.get('content-type')?.includes('application/json')) {
            throw new Error('Server did not return a valid response.');
          }

          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Update failed');

          progressBar.style.width = '100%';
          statusEl.textContent = 'Update complete! Version: v' + (data.version || 'unknown') + '. Reloading…';
          statusEl.className = 'update-status success';
          document.getElementById('modalOk').style.display = 'none';
          setTimeout(() => { window.location.reload(true); }, 2000);
        } catch (e) {
          progressBar.style.width = '100%';
          progressBar.style.background = 'var(--danger)';
          statusEl.textContent = 'Update failed: ' + e.message;
          statusEl.className = 'update-status error';
        }
      } else {
        // --- Manual ZIP upload flow ---
        const fileInput = document.getElementById('updateZipFile');
        if (!fileInput.files.length) { alert('Please select a ZIP file'); return; }

        const file = fileInput.files[0];
        if (!file.name.toLowerCase().endsWith('.zip')) { alert('Please select a .zip file'); return; }

        progressDiv.style.display = '';
        statusEl.textContent = 'Uploading…';
        statusEl.className = 'update-status';
        progressBar.style.width = '30%';
        progressBar.style.background = '';

        try {
          const formData = new FormData();
          formData.append('zipfile', file);

          const res = await fetch(apiUrl('/api/update'), {
            method: 'POST',
            credentials: 'include',
            body: formData
          });

          progressBar.style.width = '80%';

          if (!res.headers.get('content-type')?.includes('application/json')) {
            throw new Error('Server did not return a valid response. Check that PHP zip extension is enabled.');
          }

          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Update failed');

          progressBar.style.width = '100%';
          statusEl.textContent = 'Update complete! New version: v' + (data.version || 'unknown') + '. Reloading…';
          statusEl.className = 'update-status success';
          document.getElementById('modalOk').style.display = 'none';
          setTimeout(() => { window.location.reload(true); }, 2000);
        } catch (e) {
          progressBar.style.width = '100%';
          progressBar.style.background = 'var(--danger)';
          statusEl.textContent = 'Update failed: ' + e.message;
          statusEl.className = 'update-status error';
        }
      }
    }, 'Update');

    // --- Tab switching logic ---
    const tabGh = document.getElementById('updateTabGithub');
    const tabUp = document.getElementById('updateTabUpload');
    const panelGh = document.getElementById('updatePanelGithub');
    const panelUp = document.getElementById('updatePanelUpload');

    tabGh.addEventListener('click', () => {
      panelGh.style.display = ''; panelUp.style.display = 'none';
      tabGh.style.borderBottomColor = 'var(--primary)'; tabGh.style.opacity = '1';
      tabUp.style.borderBottomColor = 'transparent';    tabUp.style.opacity = '.6';
    });
    tabUp.addEventListener('click', () => {
      panelUp.style.display = ''; panelGh.style.display = 'none';
      tabUp.style.borderBottomColor = 'var(--primary)'; tabUp.style.opacity = '1';
      tabGh.style.borderBottomColor = 'transparent';    tabGh.style.opacity = '.6';
    });

    // --- Fetch GitHub releases ---
    const select = document.getElementById('ghVersionSelect');
    const notesDiv = document.getElementById('ghReleaseNotes');
    let ghData = null;

    (async () => {
      try {
        const res = await fetch(apiUrl('/api/github-releases'), { credentials: 'include' });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'HTTP ' + res.status); }
        ghData = await res.json();

        select.innerHTML = '';
        const allVersions = [...(ghData.releases || []), ...(ghData.tags || [])];
        if (allVersions.length === 0) {
          select.innerHTML = '<option value="">No versions found</option>';
          return;
        }

        allVersions.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.tag;
          let label = v.name || v.tag;
          if (v.type === 'release' && v.date) label += ' (' + new Date(v.date).toLocaleDateString() + ')';
          if (v.prerelease) label += ' [pre-release]';
          if (v.type === 'tag') label += ' [tag]';
          opt.textContent = label;
          select.appendChild(opt);
        });

        // Show release notes for selected version
        select.addEventListener('change', () => {
          const ver = allVersions.find(v => v.tag === select.value);
          if (ver && ver.body) {
            notesDiv.textContent = ver.body;
            notesDiv.style.display = '';
          } else {
            notesDiv.style.display = 'none';
          }
        });
        select.dispatchEvent(new Event('change'));
      } catch (e) {
        select.innerHTML = '<option value="">Error: ' + e.message + '</option>';
      }
    })();
  });

  // New team
  document.getElementById('newTeamBtn').addEventListener('click', () => {
    openModal('New Team', `
      <div class="form-group"><label>Team Name</label><input type="text" id="mTeamName" placeholder="My Team"></div>
      <div class="form-group"><label>Capacity (hours/month)</label><input type="number" id="mCapacity" value="160" min="1"></div>
    `, async () => {
      const name = document.getElementById('mTeamName').value.trim();
      const cap = parseInt(document.getElementById('mCapacity').value) || 160;
      if (!name) return alert('Name required');
      const data = await api('POST', '/api/teams', { name, capacity_hours_month: cap });
      state.teams.push(data.team);
      renderTeamsList();
      selectTeam(data.team);
      closeModal();
    });
  });

  // New project
  document.getElementById('newProjectBtn').addEventListener('click', () => {
    if (!state.currentTeam) return;
    openModal('New Project', `
      <div class="form-group"><label>Project Name</label><input type="text" id="mProjName" placeholder="My Project"></div>
      <div class="form-group"><label>Description</label><textarea id="mProjDesc" placeholder="Optional"></textarea></div>
    `, async () => {
      const name = document.getElementById('mProjName').value.trim();
      const desc = document.getElementById('mProjDesc').value.trim();
      if (!name) return alert('Name required');
      const data = await api('POST', '/api/projects', { team_id: state.currentTeam.id, name, description: desc });
      if (!state.projects[state.currentTeam.id]) state.projects[state.currentTeam.id] = [];
      state.projects[state.currentTeam.id].push(data.project);
      renderProjectsList();
      selectProject(data.project);
      closeModal();
    });
  });

  // Invite member
  document.getElementById('inviteBtn').addEventListener('click', () => {
    if (!state.currentTeam) return;
    openModal('Invite Member', `
      <div class="form-group"><label>Email address</label><input type="email" id="mInviteEmail" placeholder="user@example.com"></div>
      <div id="inviteResult" class="info-msg" style="margin-top:8px"></div>
    `, async () => {
      const email = document.getElementById('mInviteEmail').value.trim();
      if (!email) return;
      const data = await api('POST', `/api/teams/${state.currentTeam.id}/invite`, { email });
      const resultEl = document.getElementById('inviteResult');
      if (data.added) {
        resultEl.textContent = data.message;
        // Refresh members
        const tdata = await api('GET', `/api/teams/${state.currentTeam.id}`);
        state.members[state.currentTeam.id] = tdata.members;
        renderMembersList();
      } else {
        resultEl.textContent = `Invitation token: ${data.token}`;
      }
      document.getElementById('modalOk').style.display = 'none';
    }, 'Send Invite');
  });

  // View tabs
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('ganttPanel').classList.toggle('hidden', tab.dataset.view !== 'gantt');
      document.getElementById('todoPanel').classList.toggle('hidden', tab.dataset.view !== 'todo');
    });
  });

  // Add gantt entry
  document.getElementById('addGanttBtn').addEventListener('click', () => {
    if (!state.currentProject) return;
    window.ganttModule?.showAddEntryModal();
  });

  // Undo
  document.getElementById('undoBtn').addEventListener('click', performUndo);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); performUndo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      deleteSelectedGanttEntries();
    }
  });

  // Delete selected
  document.getElementById('deleteSelectedBtn').addEventListener('click', deleteSelectedGanttEntries);

  // Capacity input
  document.getElementById('capacityInput').addEventListener('change', async (e) => {
    if (!state.currentTeam) return;
    const val = parseInt(e.target.value);
    if (!val || val < 1) return;
    await api('PUT', `/api/teams/${state.currentTeam.id}`, { capacity_hours_month: val });
    state.currentTeam.capacity_hours_month = val;
    window.ganttModule?.render();
  });

  // Add todo
  document.getElementById('addTodoBtn').addEventListener('click', () => {
    if (!state.currentProject) return;
    window.todoModule?.showAddModal();
  });

  // Export CSV
  document.getElementById('exportCsvBtn').addEventListener('click', (e) => { e.stopPropagation(); exportCSV(); });

  // Export PDF (print)
  document.getElementById('exportPdfBtn').addEventListener('click', (e) => { e.stopPropagation(); exportPDF(); });

  // Share with link
  document.getElementById('shareBtn').addEventListener('click', (e) => { e.stopPropagation(); showShareModal(); });

  // Todo filters
  document.querySelectorAll('.todo-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.todo-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      window.todoModule?.setFilter(btn.dataset.status);
    });
  });
}

async function performUndo() {
  if (!state.currentProject) return;
  try {
    const data = await api('POST', `/api/undo/${state.currentProject.id}`);
    // Re-fetch full gantt to be safe
    const gdata = await api('GET', `/api/gantt/${state.currentProject.id}`);
    state.ganttEntries = gdata.entries;
    window.ganttModule?.render();
  } catch (e) {
    console.warn('Undo failed:', e.message);
  }
}

async function deleteSelectedGanttEntries() {
  if (!state.selectedGanttIds.size) return;
  if (!confirm(`Delete ${state.selectedGanttIds.size} entry(ies)?`)) return;
  for (const id of [...state.selectedGanttIds]) {
    await api('DELETE', `/api/gantt/${id}`);
    state.ganttEntries = state.ganttEntries.filter(e => e.id !== id);
  }
  state.selectedGanttIds.clear();
  updateDeleteBtn();
  window.ganttModule?.render();
}

function updateDeleteBtn() {
  const btn = document.getElementById('deleteSelectedBtn');
  if (state.selectedGanttIds.size > 0) btn.classList.remove('hidden');
  else btn.classList.add('hidden');
}

// ==========================================================================
// Modal helpers
// ==========================================================================

function openModal(title, bodyHtml, onOk, okLabel = 'Save') {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalOk').textContent = okLabel;
  document.getElementById('modalOk').style.display = '';
  document.getElementById('modalOverlay').classList.remove('hidden');
  document.getElementById('modalOk').onclick = onOk;
  // Focus first input
  setTimeout(() => { document.querySelector('#modalBody input')?.focus(); }, 50);
}

function closeModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
}

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalCancel').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
});

// ==========================================================================
// Context menu helpers
// ==========================================================================

function showContextMenu(x, y, items) {
  const menu = document.getElementById('contextMenu');
  const list = document.getElementById('contextMenuList');
  list.innerHTML = '';
  items.forEach(item => {
    if (item.separator) {
      const li = document.createElement('li');
      li.className = 'separator';
      list.appendChild(li);
      return;
    }
    const li = document.createElement('li');
    if (item.danger) li.className = 'danger';
    li.innerHTML = `${item.icon || ''} ${escHtml(item.label)}`;
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.add('hidden');
      item.action();
    });
    list.appendChild(li);
  });
  menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 10) + 'px';
  menu.classList.remove('hidden');
}

// ==========================================================================
// Utilities
// ==========================================================================

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getUserColor(userId, variation) {
  const member = Object.values(state.members).flat().find(m => m.id === userId);
  const baseColor = member?.base_color || state.user?.base_color || '#2196F3';
  const vars = generateColorVariations(baseColor);
  return vars[Math.min(variation || 0, vars.length - 1)];
}

/**
 * Returns true if the given hex colour is "dark" (relative luminance < 0.45).
 * Uses ITU-R BT.601 luma coefficients for perceived brightness.
 */
function isColorDark(hex) {
  const [r, g, b] = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.45;
}

// ==========================================================================
// Export: Excel (XLSX) with visual Gantt chart
// ==========================================================================

async function exportCSV() {
  if (!state.currentProject) return alert('Open a project first.');
  if (typeof ExcelJS === 'undefined') return alert('ExcelJS library not loaded. Check your internet connection.');

  const members = Object.values(state.members).flat();
  const titleById = {};
  state.ganttEntries.forEach(e => { titleById[e.id] = e.title; });

  // Build a flat list with hierarchy: parents first, then children indented below
  const flatRows = [];
  function collectEntries(parentId, depth) {
    const children = state.ganttEntries.filter(e => (e.parent_id || null) === parentId);
    children.forEach(e => {
      flatRows.push({ entry: e, depth });
      collectEntries(e.id, depth + 1);
    });
  }
  collectEntries(null, 0);

  if (!flatRows.length) return alert('No entries to export.');

  // Determine chart date range
  let earliest = null, latest = null;
  flatRows.forEach(({ entry }) => {
    const s = new Date(entry.start_date + 'T00:00:00');
    const e = new Date(entry.end_date + 'T00:00:00');
    if (!earliest || s < earliest) earliest = s;
    if (!latest || e > latest) latest = e;
  });
  // Add padding
  earliest.setDate(earliest.getDate() - 1);
  latest.setDate(latest.getDate() + 1);

  // Generate date columns
  const dateCols = [];
  const cur = new Date(earliest);
  while (cur <= latest) {
    dateCols.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }

  const DATA_COLS = 6; // Title, Parent, Start, End, Hours, Assignee
  const CHART_START_COL = DATA_COLS + 1; // 1-indexed

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Gantt Chart');

  // --- Header Row ---
  const headerRow = ['Title', 'Parent', 'Start Date', 'End Date', 'Hours', 'Assignee'];
  dateCols.forEach(d => {
    const dayStr = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
    headerRow.push(dayStr);
  });
  ws.addRow(headerRow);

  // Style header
  const hRow = ws.getRow(1);
  hRow.font = { bold: true, size: 10 };
  hRow.alignment = { horizontal: 'center', vertical: 'middle' };
  hRow.height = 22;
  for (let c = 1; c <= headerRow.length; c++) {
    const cell = hRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } };
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
  }

  // Set column widths
  ws.getColumn(1).width = 30; // Title
  ws.getColumn(2).width = 18; // Parent
  ws.getColumn(3).width = 12; // Start
  ws.getColumn(4).width = 12; // End
  ws.getColumn(5).width = 8;  // Hours
  ws.getColumn(6).width = 14; // Assignee
  for (let i = 0; i < dateCols.length; i++) {
    ws.getColumn(CHART_START_COL + i).width = 3.5;
  }

  // --- Data Rows with Gantt bars ---
  flatRows.forEach(({ entry, depth }) => {
    const member = members.find(m => m.id === entry.user_id);
    const parentTitle = entry.parent_id ? (titleById[entry.parent_id] || '') : '';
    const indent = depth > 0 ? '  '.repeat(depth) : '';

    const rowData = [
      indent + entry.title,
      parentTitle,
      entry.start_date,
      entry.end_date,
      entry.hours_estimate || 0,
      member ? member.username : '',
    ];

    // Fill date columns with empty strings
    dateCols.forEach(() => rowData.push(''));

    ws.addRow(rowData);
    const excelRow = ws.getRow(ws.rowCount);
    excelRow.height = 20;

    // Get bar color
    const color = getUserColor(entry.user_id, entry.color_variation);
    const argbColor = 'FF' + color.replace('#', '');
    const fontColor = isColorDark(color) ? 'FFFFFFFF' : 'FF000000';

    // Style depth with indentation and font
    if (depth > 0) {
      excelRow.getCell(1).font = { size: 10, italic: depth > 1 };
    } else {
      excelRow.getCell(1).font = { bold: true, size: 10 };
    }

    // Color the Gantt bar cells
    const startDate = new Date(entry.start_date + 'T00:00:00');
    const endDate = new Date(entry.end_date + 'T00:00:00');

    dateCols.forEach((d, i) => {
      const colIdx = CHART_START_COL + i;
      const cell = excelRow.getCell(colIdx);

      if (d >= startDate && d <= endDate) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argbColor } };
        // Show title on the first day of the bar
        if (d.getTime() === startDate.getTime()) {
          cell.value = entry.title;
          cell.font = { size: 8, color: { argb: fontColor } };
        }
      }
    });

    // Add notes as comment on title cell if present
    if (entry.notes) {
      excelRow.getCell(1).note = entry.notes;
    }

    // Light alternating row background for data columns
    if (ws.rowCount % 2 === 0) {
      for (let c = 1; c <= DATA_COLS; c++) {
        const cell = excelRow.getCell(c);
        if (!cell.fill || !cell.fill.fgColor) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
        }
      }
    }
  });

  // Add borders to data section
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= DATA_COLS; c++) {
      row.getCell(c).border = {
        right: c === DATA_COLS ? { style: 'medium', color: { argb: 'FF000000' } } : { style: 'thin', color: { argb: 'FFE0E0E0' } },
        bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
      };
    }
  }

  // Freeze panes: freeze header row and data columns
  ws.views = [{ state: 'frozen', xSplit: DATA_COLS, ySplit: 1 }];

  // --- Generate and download ---
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (state.currentProject.name || 'project').replace(/[^a-z0-9_\-]/gi, '_') + '.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ==========================================================================
// Export: PDF via browser print (A4, multi-page)
// ==========================================================================

function exportPDF() {
  if (!state.currentProject) return alert('Open a project first.');

  // Temporarily remove overflow restrictions so the full chart prints
  const ids = ['ganttTimeline', 'ganttTaskList', 'ganttHoursPanel'];
  const saved = ids.map(id => {
    const el = document.getElementById(id);
    if (!el) return null;
    const s = { el, overflow: el.style.overflow, height: el.style.height, maxHeight: el.style.maxHeight };
    el.style.overflow  = 'visible';
    el.style.height    = 'auto';
    el.style.maxHeight = 'none';
    return s;
  }).filter(Boolean);

  const body = document.querySelector('.gantt-body');
  const savedBodyOverflow = body ? body.style.overflow : '';
  if (body) body.style.overflow = 'visible';

  document.body.classList.add('print-gantt');

  const afterPrint = () => {
    document.body.classList.remove('print-gantt');
    saved.forEach(s => {
      s.el.style.overflow  = s.overflow;
      s.el.style.height    = s.height;
      s.el.style.maxHeight = s.maxHeight;
    });
    if (body) body.style.overflow = savedBodyOverflow;
    window.removeEventListener('afterprint', afterPrint);
  };

  window.addEventListener('afterprint', afterPrint);
  window.print();
}

// ==========================================================================
// Share with link
// ==========================================================================

async function showShareModal() {
  if (!state.currentProject) return alert('Open a project first.');

  const project   = state.currentProject;
  const token     = project.share_token || null;
  const shareUrl  = token ? `${location.origin}/share.html?token=${token}` : null;

  const bodyHtml = token
    ? `<div class="form-group">
        <label>Share Link</label>
        <div style="display:flex;gap:6px">
          <input type="text" id="shareUrlInput" value="${escHtml(shareUrl)}" readonly
            style="flex:1;font-size:12px;background:var(--surface2)">
          <button type="button" id="copyShareBtn" class="btn btn-secondary btn-sm">📋 Copy</button>
        </div>
        <small style="color:var(--text-muted);margin-top:4px;display:block">
          Anyone with this link can view the plan (read-only, no login required).
          <a href="${escHtml(shareUrl)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
        </small>
      </div>
      <button type="button" id="revokeShareBtn" class="btn btn-danger btn-sm">Revoke Link</button>`
    : `<p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
        Create a read-only link that anyone can use to view this plan — no login required.
       </p>`;

  const okLabel = token ? 'Close' : 'Generate Link';

  openModal('Share with Link 🔗', bodyHtml, async () => {
    if (!token) {
      // Generate a new share token
      try {
        const data = await api('POST', `/api/projects/${project.id}/share`);
        project.share_token = data.token;
        closeModal();
        showShareModal(); // Reopen with new token
      } catch (e) {
        alert('Could not generate share link: ' + e.message);
      }
    } else {
      closeModal();
    }
  }, okLabel);

  // Attach copy / revoke button handlers after the modal DOM is created
  setTimeout(() => {
    const copyBtn = document.getElementById('copyShareBtn');
    if (copyBtn && shareUrl) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard?.writeText(shareUrl).then(() => {
          copyBtn.textContent = '✓ Copied!';
          setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
        }).catch(() => {
          // Clipboard API unavailable – prompt user to copy manually
          const inp = document.getElementById('shareUrlInput');
          if (inp) { inp.focus(); inp.select(); }
          copyBtn.textContent = '⚠ Copy manually';
          setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 3000);
        });
      });
    }

    const revokeBtn = document.getElementById('revokeShareBtn');
    if (revokeBtn) {
      revokeBtn.addEventListener('click', async () => {
        if (!confirm('Revoke share link?\nAnyone with the current link will lose access immediately.')) return;
        try {
          await api('DELETE', `/api/projects/${project.id}/share`);
          project.share_token = null;
          closeModal();
          showShareModal(); // Reopen showing "no link" state
        } catch (e) {
          alert('Could not revoke link: ' + e.message);
        }
      });
    }
  }, 80);
}

// Expose globally for cross-module use
window.appState = state;
window.appAPI = api;
window.appUtils = { escHtml, formatDate, getUserColor, isColorDark, generateColorVariations, openModal, closeModal, showContextMenu, updateDeleteBtn };

// Start app
init();
