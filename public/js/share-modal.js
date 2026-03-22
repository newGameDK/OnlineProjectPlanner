'use strict';

// ==========================================================================
// OnlineProjectPlanner – Share Modal (app.html only)
// Manages the share-link modal: generate, copy, revoke.
// Depends on: app.js (window.appState, window.appAPI, window.appUtils)
// Loaded after app.js.
// ==========================================================================

const S = () => window.appState;

async function showShareModal() {
  if (!S().currentProject) return alert('Open a project first.');

  const project   = S().currentProject;
  const token     = project.share_token || null;
  // Build share URL relative to the current page's directory so it works
  // even when the app is deployed at a subdirectory path.
  const basePath  = location.origin + location.pathname.replace(/[^/]*$/, '');
  const shareUrl  = token ? basePath + 'share.html?token=' + token : null;

  const U = window.appUtils;

  const bodyHtml = token
    ? `<div class="form-group">
        <label>Share Link</label>
        <div style="display:flex;gap:6px">
          <input type="text" id="shareUrlInput" value="${U.escHtml(shareUrl)}" readonly
            style="flex:1;font-size:12px;background:var(--surface2)">
          <button type="button" id="copyShareBtn" class="btn btn-secondary btn-sm">📋 Copy</button>
        </div>
        <small style="color:var(--text-muted);margin-top:4px;display:block">
          Anyone with this link can view the plan (read-only, no login required).
          <a href="${U.escHtml(shareUrl)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
        </small>
      </div>
      <button type="button" id="revokeShareBtn" class="btn btn-danger btn-sm">Revoke Link</button>`
    : `<p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
        Create a read-only link that anyone can use to view this plan — no login required.
       </p>`;

  const okLabel = token ? 'Close' : 'Generate Link';

  U.openModal('Share with Link 🔗', bodyHtml, async () => {
    if (!token) {
      // Generate a new share token
      try {
        const data = await window.appAPI('POST', `/api/projects/${project.id}/share`);
        project.share_token = data.token;
        U.closeModal();
        showShareModal(); // Reopen with new token
      } catch (e) {
        alert('Could not generate share link: ' + e.message);
      }
    } else {
      U.closeModal();
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
          await window.appAPI('DELETE', `/api/projects/${project.id}/share`);
          project.share_token = null;
          U.closeModal();
          showShareModal(); // Reopen showing "no link" state
        } catch (e) {
          alert('Could not revoke link: ' + e.message);
        }
      });
    }
  }, 80);
}

// Expose globally so app.js event listeners can call window.showShareModal()
window.showShareModal = showShareModal;
