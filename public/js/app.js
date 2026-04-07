'use strict';

// ==========================================================================
// OnlineProjectPlanner – Main Application State & UI
// ==========================================================================

// Color utilities (hexToRgb, rgbToHsl, hslToHex, generateColorVariations,
// isColorDark, lightenColor, BASE_COLORS) live in color-utils.js which is
// loaded before this file.

// The following modules are loaded after this file and extend functionality:
//   backup.js      – downloadBackup(), openImportBackupModal()
//   update.js      – openUpdateModal()
//   export.js      – exportCSV(), exportPDF()
//   sync.js        – WebSocket + polling (connectWS, startSync, stopSync…)
//   share-modal.js – showShareModal()
//   gantt.js       – window.ganttModule
//   todo.js        – window.todoModule

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

  // Show admin-only settings if the current user is an admin
  try {
    const adminRes = await api('GET', '/api/admin/status');
    if (adminRes && adminRes.isAdmin) {
      const el = document.getElementById('adminOnlySettings');
      if (el) el.style.display = '';
    }
  } catch (e) { console.warn('Admin status check failed:', e.message); }
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
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        {
          icon: '🗑', label: 'Delete Team', danger: true, action: async () => {
            if (!confirm(`Are you sure you want to delete the team "${team.name}" and all its projects and tasks?`)) return;
            try {
              await api('DELETE', `/api/teams/${team.id}`);
              state.teams = state.teams.filter(t => t.id !== team.id);
              if (state.currentTeam?.id === team.id) {
                state.currentTeam = null;
                state.currentProject = null;
                document.getElementById('projectSection').style.display = 'none';
                document.getElementById('memberSection').style.display = 'none';
                document.getElementById('breadcrumbTeam').textContent = '—';
                showWelcome();
              }
              renderTeamsList();
            } catch (err) {
              alert('Could not delete team: ' + err.message);
            }
          }
        }
      ]);
    });
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
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        {
          icon: '🗑', label: 'Delete Project', danger: true, action: async () => {
            if (!confirm(`Are you sure you want to delete the project "${proj.name}" and all its tasks?`)) return;
            try {
              await api('DELETE', `/api/projects/${proj.id}`);
              const tid = state.currentTeam?.id;
              if (tid) state.projects[tid] = (state.projects[tid] || []).filter(p => p.id !== proj.id);
              if (state.currentProject?.id === proj.id) {
                state.currentProject = null;
                showWelcome();
              }
              renderProjectsList();
            } catch (err) {
              alert('Could not delete project: ' + err.message);
            }
          }
        }
      ]);
    });
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
  syncProjectChanged(state.user.id, project.id);

  window.ganttModule?.init();
  window.todoModule?.render();
  updateUndoRedoBtns();
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
    // On mobile, the sidebar is managed as an overlay by mobile.js.
    if (document.documentElement.classList.contains('is-mobile')) return;
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
  document.getElementById('backupBtn').addEventListener('click', () => downloadBackup());

  // Import backup
  document.getElementById('importBackupBtn').addEventListener('click', () => openImportBackupModal());

  // Show version in user panel
  (async () => {
    const el = document.getElementById('appVersion');
    try {
      const res = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (el && data.version) el.textContent = 'v' + data.version;
      }
    } catch {
      // version.json missing or unreadable – not critical
      if (el) el.textContent = '';
    }
  })();

  // Update app
  document.getElementById('updateBtn').addEventListener('click', () => openUpdateModal());

  // Snap aggressiveness slider (admin-only)
  (function initSnapSlider() {
    const slider = document.getElementById('snapPxSlider');
    const label  = document.getElementById('snapPxLabel');
    if (!slider || !label) return;
    const saved = parseInt(localStorage.getItem('ganttSnapPx') || '5', 10);
    slider.value = saved;
    label.textContent = saved;
    slider.addEventListener('input', () => {
      label.textContent = slider.value;
      if (window.ganttModule && window.ganttModule.setSnapPx) {
        window.ganttModule.setSnapPx(parseInt(slider.value, 10));
      }
    });
  })();

  // Node proximity distance slider (admin-only)
  (function initProximitySlider() {
    const slider = document.getElementById('proximityPxSlider');
    const label  = document.getElementById('proximityPxLabel');
    if (!slider || !label) return;
    const saved = parseInt(localStorage.getItem('ganttProximityPx') || '60', 10);
    slider.value = saved;
    label.textContent = saved;
    slider.addEventListener('input', () => {
      label.textContent = slider.value;
      if (window.ganttModule && window.ganttModule.setProximityPx) {
        window.ganttModule.setProximityPx(parseInt(slider.value, 10));
      }
    });
  })();

  // Enable snap checkbox
  (function initSnapEnabledCheckbox() {
    const checkbox = document.getElementById('settingsSnapEnabled');
    if (!checkbox) return;
    const saved = localStorage.getItem('ganttSnapEnabled');
    const enabled = saved === null ? true : saved === 'true';
    checkbox.checked = enabled;
    checkbox.addEventListener('change', () => {
      const val = checkbox.checked;
      localStorage.setItem('ganttSnapEnabled', val);
      if (window.ganttModule && window.ganttModule.setSnapEnabled) {
        window.ganttModule.setSnapEnabled(val);
      }
    });
  })();

  // Show/hide zoom buttons setting
  (function initShowZoomSetting() {
    const checkbox = document.getElementById('settingsShowZoom');
    const group    = document.getElementById('zoomBtnGroup');
    if (!checkbox || !group) return;
    const saved = localStorage.getItem('ganttShowZoom');
    const show  = saved === null ? true : saved === 'true';
    checkbox.checked  = show;
    group.style.display = show ? '' : 'none';
    checkbox.addEventListener('change', () => {
      const val = checkbox.checked;
      localStorage.setItem('ganttShowZoom', val);
      group.style.display = val ? '' : 'none';
    });
  })();

  // Dark mode toggle
  (function initDarkMode() {
    const checkbox = document.getElementById('settingsDarkMode');
    if (!checkbox) return;
    const saved = localStorage.getItem('ganttDarkMode');
    const dark  = saved === 'true';
    checkbox.checked = dark;
    document.documentElement.classList.toggle('dark-mode', dark);
    checkbox.addEventListener('change', () => {
      const val = checkbox.checked;
      localStorage.setItem('ganttDarkMode', val);
      document.documentElement.classList.toggle('dark-mode', val);
    });
  })();

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

  // Undo
  document.getElementById('undoBtn').addEventListener('click', performUndo);
  // Redo
  document.getElementById('redoBtn').addEventListener('click', performRedo);
  document.addEventListener('keydown', (e) => {
    const inText  = document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA';
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); performUndo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); performRedo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !inText) { e.preventDefault(); window.ganttModule?.copySelected(false); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'x' && !inText) { e.preventDefault(); window.ganttModule?.copySelected(true); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !inText) { e.preventDefault(); window.ganttModule?.pasteAtDate(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (inText) return;
      deleteSelectedGanttEntries();
    }
    // Single-key shortcuts – skip when typing or a modal is open
    const inModal = !document.getElementById('modalOverlay').classList.contains('hidden');
    if (!inText && !inModal) {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); window.ganttModule?.zoomIn(); }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); window.ganttModule?.zoomOut(); }
      // N → add new task
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); window.ganttModule?.showAddEntryModal(); }
      // E or F2 → edit selected task
      if (e.key === 'e' || e.key === 'E' || e.key === 'F2') { e.preventDefault(); window.ganttModule?.editSelected(); }
    }
  });

  // Delete selected (button removed from toolbar; kept for keyboard/context-menu callers)
  const _delBtn = document.getElementById('deleteSelectedBtn');
  if (_delBtn) _delBtn.addEventListener('click', deleteSelectedGanttEntries);

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

  // Toggle dep indicators on todo cards
  const todoDepsBtn = document.getElementById('todoDepsBtn');
  if (todoDepsBtn) {
    todoDepsBtn.addEventListener('click', () => {
      const visible = todoDepsBtn.classList.toggle('active');
      window.todoModule?.setDepsVisible(visible);
    });
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.toolbar-dropdown.open').forEach(d => d.classList.remove('open'));
  }

  // Export CSV
  document.getElementById('exportCsvBtn').addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(); exportCSV(); });

  // Sound settings
  const soundsBtn = document.getElementById('soundsBtn');
  if (soundsBtn) {
    soundsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      window.soundsModule?.openSettingsModal();
    });
  }

  // Export PDF (print)
  document.getElementById('exportPdfBtn').addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(); exportPDF(); });

  // Share with link
  document.getElementById('shareBtn').addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(); window.showShareModal(); });

  // Backup (from export menu)
  const backupBtn2 = document.getElementById('backupBtn2');
  if (backupBtn2) {
    backupBtn2.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      downloadBackup();
    });
  }

  // Import backup (from export menu)
  const importBackupBtn2 = document.getElementById('importBackupBtn2');
  if (importBackupBtn2) {
    importBackupBtn2.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      openImportBackupModal();
    });
  }

  // --- Toolbar dropdown toggles ---
  function syncAriaExpanded() {
    document.querySelectorAll('.toolbar-dropdown').forEach(d => {
      const btn = d.children[0];
      if (btn && btn.hasAttribute('aria-expanded')) {
        btn.setAttribute('aria-expanded', d.classList.contains('open'));
      }
    });
  }
  document.querySelectorAll('.toolbar-dropdown').forEach(dropdown => {
    const triggerBtn = dropdown.children[0]; // first direct child is the trigger button
    if (triggerBtn && triggerBtn.tagName === 'BUTTON') {
      triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const wasOpen = dropdown.classList.contains('open');
        // Close all dropdowns
        document.querySelectorAll('.toolbar-dropdown.open').forEach(d => d.classList.remove('open'));
        // Toggle clicked one
        if (!wasOpen) dropdown.classList.add('open');
        syncAriaExpanded();
      });
    }
    // Keep dropdown open when interacting with inputs inside
    const menu = dropdown.querySelector('.toolbar-dropdown-menu');
    if (menu) {
      menu.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      menu.addEventListener('click', (e) => { e.stopPropagation(); });
    }
  });
  // Close dropdowns when clicking outside
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.toolbar-dropdown')) {
      document.querySelectorAll('.toolbar-dropdown.open').forEach(d => d.classList.remove('open'));
      syncAriaExpanded();
    }
  });

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
  try {
    if (state.currentProject) {
      // Try project-scoped gantt undo first
      try {
        await api('POST', `/api/undo/${state.currentProject.id}`);
        const gdata = await api('GET', `/api/gantt/${state.currentProject.id}`);
        state.ganttEntries = gdata.entries;
        window.ganttModule?.render();
        updateUndoRedoBtns();
        return;
      } catch (_) {
        // Nothing to undo in current project – fall through to global undo
      }
    }
    // No current project or nothing left to undo in current project:
    // check for a team/project deletion to restore
    const globalResult = await api('POST', '/api/undo-global');
    if (globalResult.undone === 'delete_project' && globalResult.project) {
      const proj = globalResult.project;
      const tid = proj.team_id;
      if (!state.projects[tid]) state.projects[tid] = [];
      if (!state.projects[tid].find(p => p.id === proj.id)) {
        state.projects[tid].push(proj);
      }
      renderProjectsList();
      await selectProject(proj);
    } else if (globalResult.undone === 'delete_team' && globalResult.team) {
      const team = globalResult.team;
      if (!state.teams.find(t => t.id === team.id)) {
        state.teams.push(team);
      }
      renderTeamsList();
      await selectTeam(team);
    }
  } catch (e) {
    console.warn('Undo failed:', e.message);
    updateUndoRedoBtns();
  }
}

async function performRedo() {
  if (!state.currentProject) return;
  try {
    await api('POST', `/api/redo/${state.currentProject.id}`);
    const gdata = await api('GET', `/api/gantt/${state.currentProject.id}`);
    state.ganttEntries = gdata.entries;
    window.ganttModule?.render();
    updateUndoRedoBtns();
  } catch (e) {
    console.warn('Redo failed:', e.message);
    updateUndoRedoBtns();
  }
}

async function deleteSelectedGanttEntries() {
  if (!state.selectedGanttIds.size) return;
  if (!confirm(`Delete ${state.selectedGanttIds.size} entry(ies)?`)) return;
  const deletedIds = new Set();
  for (const id of [...state.selectedGanttIds]) {
    try {
      const data = await api('DELETE', `/api/gantt/${id}`);
      (data.deleted_ids || [id]).forEach(did => deletedIds.add(did));
    } catch (_) {
      // Entry may have been recursively deleted along with a parent; treat as deleted
      deletedIds.add(id);
    }
  }
  state.ganttEntries = state.ganttEntries.filter(e => !deletedIds.has(e.id));
  state.selectedGanttIds.clear();
  updateDeleteBtn();
  window.ganttModule?.render();
  updateUndoRedoBtns();
}

function updateDeleteBtn() {
  const btn = document.getElementById('deleteSelectedBtn');
  if (!btn) return;
  if (state.selectedGanttIds.size > 0) btn.classList.remove('hidden');
  else btn.classList.add('hidden');
}

async function updateUndoRedoBtns() {
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  if (!undoBtn || !redoBtn || !state.currentProject) {
    if (undoBtn) undoBtn.disabled = true;
    if (redoBtn) redoBtn.disabled = true;
    return;
  }
  try {
    const status = await api('GET', `/api/undo-status/${state.currentProject.id}`);
    undoBtn.disabled = !status.canUndo;
    redoBtn.disabled = !status.canRedo;
  } catch (_) {
    // Silently ignore – buttons remain in their current state
  }
}

// ==========================================================================
// Modal helpers
// ==========================================================================

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalCancel').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
});

// ==========================================================================
// Utilities
// ==========================================================================

function getUserColor(userId, variation) {
  const member = Object.values(state.members).flat().find(m => m.id === userId);
  const baseColor = member?.base_color || state.user?.base_color || '#2196F3';
  const vars = generateColorVariations(baseColor);
  return vars[Math.min(variation || 0, vars.length - 1)];
}

// Expose globally for cross-module use
window.appState = state;
window.appAPI = api;
window.appUtils = { escHtml, formatDate, getUserColor, isColorDark, lightenColor, darkenColor, generateColorVariations, openModal, closeModal, showContextMenu, updateDeleteBtn, updateUndoRedoBtns };

// Start app
init();
