'use strict';

// ==========================================================================
// OnlineProjectPlanner – Application Update
// Handles admin-status check, GitHub release listing, and ZIP install.
// Depends on: config.js (apiUrl), ui-utils.js (openModal, closeModal),
//             app.js (window.appAPI)
// Loaded after app.js.
// ==========================================================================

// Maximum number of older (rollback) releases shown in the update modal.
const MAX_ROLLBACK_VERSIONS = 5;

const _updAPI = (m, u, b) => window.appAPI(m, u, b);

function toBriefReleaseNote(text, maxWords = 30) {
  const plain = String(text || '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return 'No release notes provided for this version.';
  const words = plain.split(' ');
  if (words.length <= maxWords) return plain;
  return words.slice(0, maxWords).join(' ') + '…';
}

/**
 * Refresh the label of the #updateBtn in the user panel based on what
 * action would be taken (update, rollback, or generic install).
 * Called once on page load so the button reflects release state before
 * the modal is opened.
 */
async function refreshUpdateBtnLabel() {
  const btn = document.getElementById('updateBtn');
  if (!btn) return;
  try {
    let currentVersion = '';
    try {
      const vRes = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
      if (vRes.ok) { const vData = await vRes.json(); currentVersion = vData.version || ''; }
    } catch { /* ignore */ }

    const res = await fetch(apiUrl('/api/github-releases'), { credentials: 'include' });
    if (!res.ok) return;
    const releases = await res.json();
    if (!Array.isArray(releases) || !releases.length) return;

    const stripV = tag => tag.replace(/^v/, '');
    const currentIdx = releases.findIndex(r => stripV(r.tag) === currentVersion);

    let hasNewer = false;
    let hasOlder = false;
    for (let i = 0; i < releases.length; i++) {
      const r = releases[i];
      if (currentVersion && stripV(r.tag) === currentVersion) continue;
      if (!r.assets || !r.assets.find(a => a.name.endsWith('.zip'))) continue;
      if (currentIdx >= 0 && i > currentIdx) {
        hasOlder = true;
      } else {
        hasNewer = true;
      }
    }

    if (hasNewer) {
      btn.textContent = '⬆ Update';
    } else if (hasOlder) {
      btn.textContent = '⏪ Rollback Version';
    } else if (!currentVersion) {
      btn.textContent = '⬇ Install Selected Version';
    }
    // else: already on latest or no assets – leave original label unchanged
  } catch { /* silently ignore – button keeps its default label */ }
}

/**
 * Open the Update Application modal.
 *
 * Checks admin status first, then lists available GitHub releases and allows
 * the user to install a selected version (browser-download path) or upload
 * a ZIP file manually.
 */
async function openUpdateModal() {
  // Check admin status before showing update UI
  try {
    const adminRes = await _updAPI('GET', '/api/admin/status');
    if (!adminRes.hasAdmin) {
      // No admin set yet – offer to become admin
      openModal('Set Admin', `
        <p style="font-size:13px;margin-bottom:12px">No admin has been set yet. Only admins can update the application.</p>
        <p style="font-size:13px;margin-bottom:12px">Would you like to set yourself as the admin?</p>
      `, async () => {
        try {
          await _updAPI('POST', '/api/admin/set', {});
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
        <div id="ghReleaseNote" style="display:none;margin-top:8px;font-size:12px;color:var(--text-muted);line-height:1.4"></div>
      </div>
      <button type="button" id="ghInstallBtn" class="btn btn-primary btn-full" style="display:none;margin-bottom:12px">⬇ Install Selected Version</button>
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
    const loadingEl  = document.getElementById('ghReleasesLoading');
    const selectEl   = document.getElementById('ghReleaseSelect');
    const noteEl     = document.getElementById('ghReleaseNote');
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
        opt.dataset.note = toBriefReleaseNote(r.body, 30);
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
      if (noteEl) noteEl.style.display = '';

      // Update button label based on the selected version's group
      const updateInstallBtnLabel = () => {
        const opt = selectEl.options[selectEl.selectedIndex];
        const group = opt && opt.parentElement && opt.parentElement.tagName === 'OPTGROUP'
          ? opt.parentElement.label : '';
        if (group.includes('Older') || group.includes('rollback')) {
          installBtn.textContent = '⏪ Roll Back to This Version';
        } else if (group.includes('Newer') || group.includes('update')) {
          installBtn.textContent = '⬆ Update App';
        } else {
          installBtn.textContent = '⬇ Install Selected Version';
        }
      };
      const updateReleaseNote = () => {
        if (!noteEl) return;
        const opt = selectEl.options[selectEl.selectedIndex];
        noteEl.textContent = opt?.dataset?.note || '';
      };
      updateInstallBtnLabel();
      updateReleaseNote();
      selectEl.addEventListener('change', () => {
        updateInstallBtnLabel();
        updateReleaseNote();
      });
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
    progressBar.style.width = '10%';
    statusEl.textContent = 'Downloading from GitHub…';
    statusEl.className = 'update-status';

    try {
      let data;

      // Step 1: Try to download the ZIP directly in the browser.
      // This avoids server-side download timeouts (nginx proxy_read_timeout,
      // PHP execution limits, allow_url_fopen restrictions).
      // If the browser download fails (e.g. CORS), fall back to the server-side
      // download path.  If it succeeds but the subsequent upload fails (e.g.
      // auth error), surface that error directly – the server-side path would
      // fail for the same reason.
      let zipBlob = null;
      try {
        const zipRes = await fetch(url);
        if (!zipRes.ok) throw new Error('HTTP ' + zipRes.status);
        zipBlob = await zipRes.blob();
      } catch (downloadErr) {
        // Browser-side download failed (CORS, network, etc.) – will use
        // server-side fallback below.
        console.debug('Browser download failed, falling back to server:', downloadErr);
      }

      if (zipBlob) {
        // Primary path: upload the browser-downloaded ZIP to the server.
        progressBar.style.width = '60%';
        statusEl.textContent = 'Installing…';

        const formData = new FormData();
        formData.append('zipfile', zipBlob, 'update.zip');

        const res = await fetch(apiUrl('/api/update'), {
          method: 'POST',
          credentials: 'include',
          body: formData
        });
        progressBar.style.width = '90%';
        if (!res.headers.get('content-type')?.includes('application/json')) {
          throw new Error('Server did not return a valid response. Check that PHP zip extension is enabled.');
        }
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Update failed');
      } else {
        // Fallback: ask the server to download from GitHub.
        // This may fail on hosting environments with restrictive timeouts.
        progressBar.style.width = '30%';
        statusEl.textContent = 'Downloading via server…';

        const res = await fetch(apiUrl('/api/update-from-github'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        progressBar.style.width = '90%';
        if (!res.headers.get('content-type')?.includes('application/json')) {
          throw new Error('Server did not return a valid response.');
        }
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Update failed');
      }

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
}
