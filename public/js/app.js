'use strict';

// ==========================================================================
// OnlineProjectPlanner – Main Application State & UI
// ==========================================================================

// Color utilities (hexToRgb, rgbToHsl, hslToHex, generateColorVariations,
// isColorDark, lightenColor, BASE_COLORS) live in color-utils.js which is
// loaded before this file.

// Export logic (exportCSV, exportPDF) lives in export.js which is loaded
// after this file.

// Sync logic (WebSocket + polling fallback, setSyncStatus, connectWS,
// startSync, stopSync, handleWSMessage, syncProjectChanged) lives in
// sync.js which is loaded after this file.

// ==========================================================================
// Application State
// ==========================================================================

// Maximum number of older (rollback) releases shown in the update modal.
const MAX_ROLLBACK_VERSIONS = 5;

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

  // Import backup
  document.getElementById('importBackupBtn').addEventListener('click', () => {
    openModal('Import Backup', `
      <p style="font-size:13px;margin-bottom:12px;color:var(--text-muted)">
        Select a previously exported backup JSON file to restore.
        Existing data will not be overwritten — only missing items are added.
      </p>
      <div class="form-group">
        <label>Select backup file</label>
        <input type="file" id="importBackupFile" accept=".json" style="font-size:13px">
      </div>
    `, async () => {
      const input = document.getElementById('importBackupFile');
      if (!input.files.length) return alert('Please select a backup JSON file');
      const file = input.files[0];
      try {
        const text = await file.text();
        const backup = JSON.parse(text);
        if (!backup.teams || !Array.isArray(backup.teams)) throw new Error('Invalid backup format');
        const data = await api('POST', '/api/backup/import', backup);
        closeModal();
        const imp = data.imported || {};
        alert('Import complete!\n' +
          'Teams: ' + (imp.teams || 0) + ', Projects: ' + (imp.projects || 0) +
          ', Entries: ' + (imp.entries || 0) + ', Todos: ' + (imp.todos || 0) +
          ', Dependencies: ' + (imp.dependencies || 0));
        window.location.reload();
      } catch (e) {
        alert('Import failed: ' + e.message);
      }
    });
  });

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
  document.getElementById('updateBtn').addEventListener('click', async () => {
    // Check admin status before showing update UI
    try {
      const adminRes = await api('GET', '/api/admin/status');
      if (!adminRes.hasAdmin) {
        // No admin set yet – offer to become admin
        openModal('Set Admin', `
          <p style="font-size:13px;margin-bottom:12px">No admin has been set yet. Only admins can update the application.</p>
          <p style="font-size:13px;margin-bottom:12px">Would you like to set yourself as the admin?</p>
        `, async () => {
          try {
            await api('POST', '/api/admin/set', {});
            closeModal();
            alert('You are now the admin. Click Update App again to proceed.');
          } catch (e) { alert('Failed: ' + e.message); }
        });
        return;
      }
      if (!adminRes.isAdmin) {
        alert('Only the admin can update the application.');
        return;
      }
    } catch (e) {
      // If admin endpoints not available (older backend), fall through
    }

    openModal('Update Application', `
      <p style="font-size:13px;margin-bottom:12px;color:var(--text-muted)">
        Install a version from GitHub or upload a ZIP manually.
        Your database and all user data will be preserved.
      </p>
      <div id="ghReleasesSection">
        <div class="form-group">
          <label>Available versions from GitHub</label>
          <div id="ghReleasesLoading" style="font-size:12px;color:var(--text-muted)">Loading releases…</div>
          <select id="ghReleaseSelect" class="form-control" style="display:none;font-size:13px"></select>
        </div>
        <button type="button" id="ghInstallBtn" class="btn btn-primary btn-full" style="display:none;margin-bottom:12px">⬇ Install selected version</button>
      </div>
      <details style="margin-bottom:12px">
        <summary style="font-size:12px;cursor:pointer;color:var(--text-muted)">Or upload a ZIP file manually</summary>
        <div class="form-group" style="margin-top:8px">
          <label>Select update ZIP file</label>
          <input type="file" id="updateZipFile" accept=".zip" style="font-size:13px">
        </div>
        <button type="button" id="manualUploadBtn" class="btn btn-secondary btn-full">Upload &amp; Update</button>
      </details>
      <div id="updateProgress" class="update-progress" style="display:none">
        <div class="progress-bar"><div class="progress-bar-fill" id="updateProgressBar" style="width:0%"></div></div>
        <div class="update-status" id="updateStatus">Working…</div>
      </div>
    `, null);

    // Hide modal OK button – we use our own buttons
    document.getElementById('modalOk').style.display = 'none';

    // Fetch releases from GitHub
    (async () => {
      const loadingEl = document.getElementById('ghReleasesLoading');
      const selectEl  = document.getElementById('ghReleaseSelect');
      const installBtn = document.getElementById('ghInstallBtn');
      try {
        // Read the currently installed version so we can exclude it from the list
        let currentVersion = '';
        try {
          const vRes = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
          if (vRes.ok) { const vData = await vRes.json(); currentVersion = vData.version || ''; }
        } catch { /* ignore – version unknown */ }

        const res = await fetch(apiUrl('/api/github-releases'), { credentials: 'include' });
        if (!res.ok) throw new Error('Could not fetch releases');
        const releases = await res.json();
        if (!releases.length) { loadingEl.textContent = 'No releases found'; return; }

        selectEl.innerHTML = '';

        // GitHub returns releases newest-first.  Find where the installed version sits
        // so we can split the list into "newer" (updates) and "older" (rollback).
        const currentIdx = releases.findIndex(r => r.tag.replace(/^v/, '') === currentVersion);

        let newerGroup = null;
        let olderGroup = null;
        let olderCount = 0;

        for (let i = 0; i < releases.length; i++) {
          const r = releases[i];
          const asset = r.assets.find(a => a.name.endsWith('.zip'));
          if (!asset) continue;

          const releaseVersion = r.tag.replace(/^v/, '');
          // Skip the currently installed version
          if (currentVersion && releaseVersion === currentVersion) continue;

          const isOlder = currentIdx >= 0 && i > currentIdx;
          if (isOlder) {
            // Limit how far back the user can roll back
            if (olderCount >= MAX_ROLLBACK_VERSIONS) continue;
            olderCount++;
            if (!olderGroup) {
              olderGroup = document.createElement('optgroup');
              olderGroup.label = 'Older versions \u2014 rollback';
              selectEl.appendChild(olderGroup);
            }
          } else {
            // Newer than current (or position unknown) – these are updates
            if (!newerGroup && currentIdx >= 0) {
              newerGroup = document.createElement('optgroup');
              newerGroup.label = 'Newer versions \u2014 update';
              selectEl.insertBefore(newerGroup, olderGroup || null);
            }
          }

          const opt = document.createElement('option');
          opt.value = asset.download_url;
          const size = asset.size ? ' (' + (asset.size / 1024 / 1024).toFixed(1) + ' MB)' : '';
          opt.textContent = r.name + size;
          (isOlder ? olderGroup : (newerGroup || selectEl)).appendChild(opt);
        }
        if (!selectEl.options.length) {
          loadingEl.textContent = currentVersion
            ? 'You are already on the latest version (v' + currentVersion + ')'
            : 'No ZIP assets found in releases';
          return;
        }
        loadingEl.style.display = 'none';
        selectEl.style.display = '';
        installBtn.style.display = '';
      } catch {
        loadingEl.textContent = 'Could not load releases from GitHub';
      }
    })();

    // Install from GitHub handler
    document.getElementById('ghInstallBtn').onclick = async () => {
      const selectEl = document.getElementById('ghReleaseSelect');
      const url = selectEl.value;
      if (!url) return;

      const progressDiv = document.getElementById('updateProgress');
      const progressBar = document.getElementById('updateProgressBar');
      const statusEl    = document.getElementById('updateStatus');
      progressDiv.style.display = '';
      progressBar.style.background = '';
      progressBar.style.width = '20%';
      statusEl.textContent = 'Downloading from GitHub…';
      statusEl.className = 'update-status';

      try {
        const res = await fetch(apiUrl('/api/update-from-github'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        progressBar.style.width = '80%';
        if (!res.headers.get('content-type')?.includes('application/json')) {
          throw new Error('Server did not return a valid response.');
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Update failed');

        progressBar.style.width = '100%';
        statusEl.textContent = 'Update complete! New version: v' + (data.version || 'unknown') + '. Reloading…';
        statusEl.className = 'update-status success';
        document.getElementById('ghInstallBtn').style.display = 'none';

        setTimeout(() => {
          const u = new URL(window.location.href);
          u.searchParams.set('_updated', Date.now());
          window.location.href = u.toString();
        }, 2000);
      } catch (e) {
        progressBar.style.width = '100%';
        progressBar.style.background = 'var(--danger)';
        statusEl.textContent = 'Update failed: ' + e.message;
        statusEl.className = 'update-status error';
      }
    };

    // Manual upload handler
    document.getElementById('manualUploadBtn').onclick = async () => {
      const fileInput = document.getElementById('updateZipFile');
      if (!fileInput.files.length) { alert('Please select a ZIP file'); return; }

      const file = fileInput.files[0];
      if (!file.name.toLowerCase().endsWith('.zip')) { alert('Please select a .zip file'); return; }

      const progressDiv = document.getElementById('updateProgress');
      const progressBar = document.getElementById('updateProgressBar');
      const statusEl    = document.getElementById('updateStatus');
      progressDiv.style.display = '';
      progressBar.style.background = '';
      statusEl.textContent = 'Uploading…';
      statusEl.className = 'update-status';
      progressBar.style.width = '30%';

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
        document.getElementById('manualUploadBtn').style.display = 'none';

        setTimeout(() => {
          const u = new URL(window.location.href);
          u.searchParams.set('_updated', Date.now());
          window.location.href = u.toString();
        }, 2000);
      } catch (e) {
        progressBar.style.width = '100%';
        progressBar.style.background = 'var(--danger)';
        statusEl.textContent = 'Update failed: ' + e.message;
        statusEl.className = 'update-status error';
      }
    };
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

  // Export PDF (print)
  document.getElementById('exportPdfBtn').addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(); exportPDF(); });

  // Share with link
  document.getElementById('shareBtn').addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(); showShareModal(); });

  // Backup (from export menu)
  const backupBtn2 = document.getElementById('backupBtn2');
  if (backupBtn2) {
    backupBtn2.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeAllDropdowns();
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
  }

  // Import backup (from export menu)
  const importBackupBtn2 = document.getElementById('importBackupBtn2');
  if (importBackupBtn2) {
    importBackupBtn2.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      openModal('Import Backup', `
        <p style="font-size:13px;margin-bottom:12px;color:var(--text-muted)">
          Select a previously exported backup JSON file to restore.
          Existing data will not be overwritten — only missing items are added.
        </p>
        <div class="form-group">
          <label>Select backup file</label>
          <input type="file" id="importBackupFile" accept=".json" style="font-size:13px">
        </div>
      `, async () => {
        const input = document.getElementById('importBackupFile');
        if (!input.files.length) return alert('Please select a backup JSON file');
        const file = input.files[0];
        try {
          const text = await file.text();
          const backup = JSON.parse(text);
          if (!backup.teams || !Array.isArray(backup.teams)) throw new Error('Invalid backup format');
          const data = await api('POST', '/api/backup/import', backup);
          closeModal();
          const imp = data.imported || {};
          alert('Import complete!\n' +
            'Teams: ' + (imp.teams || 0) + ', Projects: ' + (imp.projects || 0) +
            ', Entries: ' + (imp.entries || 0) + ', Todos: ' + (imp.todos || 0) +
            ', Dependencies: ' + (imp.dependencies || 0));
          window.location.reload();
        } catch (e) {
          alert('Import failed: ' + e.message);
        }
      });
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
  for (const id of [...state.selectedGanttIds]) {
    await api('DELETE', `/api/gantt/${id}`);
    state.ganttEntries = state.ganttEntries.filter(e => e.id !== id);
  }
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

// ==========================================================================
// Export: exportCSV() and exportPDF() live in export.js (loaded after app.js)
// ==========================================================================

// ==========================================================================
// Share with link
// ==========================================================================

async function showShareModal() {
  if (!state.currentProject) return alert('Open a project first.');

  const project   = state.currentProject;
  const token     = project.share_token || null;
  // Build share URL relative to the current page's directory so it works
  // even when the app is deployed at a subdirectory path.
  const basePath  = location.origin + location.pathname.replace(/[^/]*$/, '');
  const shareUrl  = token ? basePath + 'share.html?token=' + token : null;

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
window.appUtils = { escHtml, formatDate, getUserColor, isColorDark, lightenColor, generateColorVariations, openModal, closeModal, showContextMenu, updateDeleteBtn, updateUndoRedoBtns };

// Start app
init();
