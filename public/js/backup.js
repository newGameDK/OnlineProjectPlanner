'use strict';

// ==========================================================================
// OnlineProjectPlanner – Backup & Import
// Shared helpers used by both the user-panel and export-menu backup buttons.
// Depends on: config.js (apiUrl), ui-utils.js (openModal, closeModal),
//             app.js (window.appAPI)
// Loaded after app.js.
// ==========================================================================

const _bkpAPI = (m, u, b) => window.appAPI(m, u, b);

/**
 * Download a full JSON backup of all user data.
 */
async function downloadBackup() {
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
}

/**
 * Open the import-backup modal.
 * Existing data is never overwritten – only missing items are added.
 */
function openImportBackupModal() {
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
      const data = await _bkpAPI('POST', '/api/backup/import', backup);
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
}
