'use strict';

// ==========================================================================
// OnlineProjectPlanner – Sounds Module
// Manages UI sound effects: upload, preview, playback, and export/import.
// Sounds are stored in IndexedDB (browser) and take priority over server files.
// Server-side sounds live in public/sounds/ (see sounds-config.json).
// ==========================================================================

(function () {

  const DB_NAME    = 'OPP_Sounds';
  const DB_VERSION = 1;
  const STORE      = 'sounds';

  const SOUND_EVENTS = [
    { key: 'stretch',        label: 'Stretch task',            desc: 'Resize a task wider' },
    { key: 'compress',       label: 'Compress task',           desc: 'Resize a task narrower' },
    { key: 'anchor_click',   label: 'Anchor point click',      desc: 'Start drawing a dependency arrow' },
    { key: 'anchor_connect', label: 'Anchor point connect',    desc: 'Dependency arrow attached' },
    { key: 'task_done',      label: 'Task done',               desc: 'Task marked as done' },
    { key: 'task_placed',    label: 'Task placed',             desc: 'Task placed after being moved' },
    { key: 'snap_line',      label: 'Snap line appears',       desc: 'Blue snap alignment line shown' },
  ];

  // Cached AudioBuffers / object-URLs per event key
  const _cache = {};
  // IDB handle
  let _db = null;

  // =========================================================================
  // IndexedDB helpers
  // =========================================================================

  function openDB() {
    return new Promise((resolve, reject) => {
      if (_db) { resolve(_db); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function dbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function dbPut(key, blob, name) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, blob, name });
      tx.oncomplete = resolve;
      tx.onerror    = (e) => reject(e.target.error);
    });
  }

  async function dbDelete(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror    = (e) => reject(e.target.error);
    });
  }

  async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  // =========================================================================
  // Playback
  // =========================================================================

  async function play(eventKey) {
    try {
      // 1. Try IndexedDB first
      const record = await dbGet(eventKey);
      if (record && record.blob) {
        const url = URL.createObjectURL(record.blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
        return;
      }

      // 2. Fall back to server-side file from sounds-config.json
      const configKey = 'opp_sounds_config';
      let config = null;
      try {
        const cached = sessionStorage.getItem(configKey);
        if (cached) {
          config = JSON.parse(cached);
        } else {
          const resp = await fetch('sounds/sounds-config.json', { cache: 'no-store' });
          if (resp.ok) {
            config = await resp.json();
            sessionStorage.setItem(configKey, JSON.stringify(config));
          }
        }
      } catch { /* config not available */ }

      if (config && config.sounds && config.sounds[eventKey]) {
        const filename = config.sounds[eventKey].file;
        const audio = new Audio('sounds/' + filename);
        await audio.play();
      }
    } catch (err) {
      // Ignore playback errors (missing file, user hasn't interacted, etc.)
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        console.debug('[sounds] play error:', eventKey, err.message);
      }
    }
  }

  // =========================================================================
  // Settings modal
  // =========================================================================

  async function openSettingsModal() {
    const U = window.appUtils;
    if (!U) return;

    const records = await dbGetAll();
    const byKey = {};
    records.forEach(r => { byKey[r.key] = r; });

    const rows = SOUND_EVENTS.map(ev => {
      const has = !!byKey[ev.key];
      const name = has ? U.escHtml(byKey[ev.key].name || ev.key) : '<em style="color:var(--text-muted)">No sound uploaded</em>';
      return `
        <tr data-event-key="${ev.key}">
          <td style="padding:6px 8px;white-space:nowrap">
            <strong>${U.escHtml(ev.label)}</strong><br>
            <small style="color:var(--text-muted)">${U.escHtml(ev.desc)}</small>
          </td>
          <td style="padding:6px 8px;font-size:12px">${name}</td>
          <td style="padding:6px 8px;white-space:nowrap">
            <label class="btn btn-secondary btn-sm" style="cursor:pointer;display:inline-block;margin-right:4px"
              title="Upload a sound file for this event">
              📁 Upload
              <input type="file" accept="audio/*" style="display:none" data-upload-key="${ev.key}">
            </label>
            ${has ? `<button class="btn btn-secondary btn-sm snd-preview" data-preview-key="${ev.key}" title="Preview this sound">▶</button>
            <button class="btn btn-secondary btn-sm snd-delete" data-delete-key="${ev.key}" style="color:var(--danger)" title="Remove this sound">✕</button>` : ''}
          </td>
        </tr>`;
    }).join('');

    const html = `
      <p style="margin:0 0 12px;font-size:13px;color:var(--text-muted)">
        Upload sound files for each event. Sounds are stored in your browser.
        Use <strong>Download Pack</strong> to export them for server-side deployment.
      </p>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px" id="soundsTable">
          <thead>
            <tr style="border-bottom:2px solid var(--border)">
              <th style="padding:6px 8px;text-align:left">Event</th>
              <th style="padding:6px 8px;text-align:left">Current sound</th>
              <th style="padding:6px 8px;text-align:left">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
        <button id="sndDownloadPack" class="btn btn-primary btn-sm">⬇ Download Pack</button>
        <button id="sndClearAll" class="btn btn-secondary btn-sm" style="color:var(--danger)">🗑 Clear All Sounds</button>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--text-muted)">
        <strong>Server-side deployment:</strong> Click "Download Pack" to get a JSON bundle.
        Extract the audio files and place them in <code>public/sounds/</code>.
        See <code>public/sounds/sounds-config.json</code> for file names and instructions.
      </div>`;

    U.openModal('🔊 Sound Settings', html, () => {}, 'Close');

    // Wire up events after modal is open
    setTimeout(() => {
      // File upload handlers
      document.querySelectorAll('input[data-upload-key]').forEach(input => {
        input.addEventListener('change', async (e) => {
          const key  = e.target.dataset.uploadKey;
          const file = e.target.files[0];
          if (!file) return;
          await dbPut(key, file, file.name);
          delete _cache[key]; // clear cached URL
          openSettingsModal(); // refresh
        });
      });

      // Preview handlers
      document.querySelectorAll('.snd-preview').forEach(btn => {
        btn.addEventListener('click', () => play(btn.dataset.previewKey));
      });

      // Delete handlers
      document.querySelectorAll('.snd-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          await dbDelete(btn.dataset.deleteKey);
          delete _cache[btn.dataset.deleteKey];
          openSettingsModal();
        });
      });

      // Download pack
      const dlBtn = document.getElementById('sndDownloadPack');
      if (dlBtn) dlBtn.addEventListener('click', downloadPack);

      // Clear all
      const clearBtn = document.getElementById('sndClearAll');
      if (clearBtn) clearBtn.addEventListener('click', async () => {
        if (!confirm('Remove all uploaded sounds from the browser?')) return;
        const all = await dbGetAll();
        for (const r of all) { await dbDelete(r.key); delete _cache[r.key]; }
        openSettingsModal();
      });
    }, 50);
  }

  // =========================================================================
  // Download pack (JSON bundle with base64-encoded audio + config)
  // =========================================================================

  async function downloadPack() {
    const records  = await dbGetAll();
    const manifest = { _instructions: [], sounds: {} };

    manifest._instructions = [
      'This JSON bundle was exported from the OnlineProjectPlanner sound settings.',
      'To deploy server-side: decode each base64 audio entry and save the file to public/sounds/ using the filename shown.',
      'IMPORTANT: Validate that filenames do not contain path separators (/, \\, ..) before writing files.',
      'Safe extraction example (Node.js): node -e "const d=require(\'./sounds-pack.json\');const fs=require(\'fs\'),path=require(\'path\');Object.values(d.sounds).forEach(s=>{if(!s.data||s.file.includes(\'..\'))return;fs.writeFileSync(path.join(\'public/sounds\',path.basename(s.file)),Buffer.from(s.data,\'base64\'))})"',
      'See public/sounds/sounds-config.json for event-to-filename mapping.'
    ];

    // Build config structure matching sounds-config.json
    const fileMap = {
      stretch:        'stretch.mp3',
      compress:       'compress.mp3',
      anchor_click:   'anchor_click.mp3',
      anchor_connect: 'anchor_connect.mp3',
      task_done:      'task_done.mp3',
      task_placed:    'task_placed.mp3',
      snap_line:      'snap_line.mp3',
    };
    const labelMap = {};
    SOUND_EVENTS.forEach(ev => { labelMap[ev.key] = ev.label; });

    for (const ev of SOUND_EVENTS) {
      const r = records.find(x => x.key === ev.key);
      const entry = {
        file:  r ? r.name : fileMap[ev.key],
        label: labelMap[ev.key],
      };
      if (r && r.blob) {
        entry.data = await blobToBase64(r.blob);
        entry.type = r.blob.type || 'audio/mpeg';
      }
      manifest.sounds[ev.key] = entry;
    }

    const json = JSON.stringify(manifest, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'sounds-pack.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // =========================================================================
  // Public API
  // =========================================================================

  window.soundsModule = { play, openSettingsModal };

})();
