'use strict';

// ==========================================================================
// OnlineProjectPlanner – Sync (WebSocket + polling fallback)
// Depends on: config.js (API_BASE), app.js (window.appState, window.appAPI)
// Loaded after app.js so that window.appState and app-level functions are
// available at runtime (sync functions are only called after the first await
// inside init(), by which time all scripts have executed).
// ==========================================================================

(function () {

const S   = () => window.appState;
const API = (m, u, b) => window.appAPI(m, u, b);

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
    const state = S();
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

// Notify sync module when the user selects a project (updates WS subscription).
function syncProjectChanged(userId, projectId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'auth', userId, projectId }));
  }
}

function handleWSMessage(msg) {
  const state = S();
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
        // Clear stale same_row references pointing to the deleted entry.
        state.ganttEntries.forEach(e => {
          if (e.same_row === msg.entry_id) e.same_row = null;
        });
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
    case 'team_deleted': {
      state.teams = state.teams.filter(t => t.id !== msg.team_id);
      if (state.currentTeam?.id === msg.team_id) {
        state.currentTeam = null;
        state.currentProject = null;
        document.getElementById('projectSection').style.display = 'none';
        document.getElementById('memberSection').style.display = 'none';
        document.getElementById('breadcrumbTeam').textContent = '—';
        showWelcome();
      }
      renderTeamsList();
      break;
    }
  }
}

// ==========================================================================
// Sync (polling fallback every 10 seconds)
// ==========================================================================

let syncTimer = null;

function startSync() {
  stopSync();
  syncTimer = setInterval(async () => {
    const state = S();
    if (!state.currentProject) return;
    // Skip polling if WebSocket is active and connected
    if (ws && ws.readyState === WebSocket.OPEN && wsFailCount === 0) return;
    try {
      setSyncStatus('syncing');
      const data = await API('GET', `/api/sync/${state.currentProject.id}?since=${state.lastSync}`);
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
  }, 10000);
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

// Expose public API so app.js can call these functions directly.
window.connectWS          = connectWS;
window.startSync          = startSync;
window.stopSync           = stopSync;
window.syncProjectChanged = syncProjectChanged;
window.setSyncStatus      = setSyncStatus;

})();
