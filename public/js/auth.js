'use strict';

// --------------------------------------------------------------------------
// Auth page logic
// --------------------------------------------------------------------------

// Detect file:// protocol – the app must be served by a web server
if (location.protocol === 'file:') {
  document.querySelector('.auth-container').insertAdjacentHTML('afterbegin',
    '<div class="file-protocol-warning">' +
    '<strong>⚠ Cannot connect to server</strong><br>' +
    'You opened this file directly. Upload the folder to a web server ' +
    '(or run <code>npm start</code> / <code>php -S localhost:8000</code> locally) ' +
    'and open it from there.' +
    '</div>'
  );
}

// Probe the API to detect hosting without a working backend.
if (location.protocol !== 'file:') {
  (async () => {
    /** Try fetching a URL and return the response, or null on failure. */
    async function probe(url) {
      try {
        const r = await fetch(url, { credentials: 'include' });
        return r;
      } catch { return null; }
    }

    // Primary probe: the normal apiUrl route
    let res = await probe(apiUrl('/api/health'));

    // Fallback: try hitting router.php directly (bypasses any .htaccess issues
    // that apiUrl might inherit when PHP_ROUTER is false or API_BASE is custom).
    if (!res || !res.ok) {
      res = await probe((API_BASE === '.' ? '.' : API_BASE) + '/api/router.php?_route=health');
    }

    let data = null;
    let detail = '';
    if (res) {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try { data = await res.json(); } catch { /* unparseable */ }
      }
      if (!res.ok || !data || !data.ok) {
        // Server responded but not with a healthy JSON – extract detail
        if (data && data.error)  detail = data.error;
        else if (data && data.detail) detail = data.detail;
        else if (!ct.includes('application/json'))
          detail = 'The server returned HTML instead of JSON (HTTP ' + res.status + '). ' +
                   'This usually means PHP is not executing. Check that PHP is enabled and the ' +
                   '<code>api/</code> folder was uploaded correctly.';
        else
          detail = 'HTTP ' + res.status;
      }
    }

    if (!data || !data.ok) {
      const safeBase = API_BASE.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      const diagUrl  = apiUrl('/api/diag').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      let hint;
      if (API_BASE && API_BASE !== '.') {
        hint = 'Check that the backend server at <code>' + safeBase + '</code> is running.';
      } else {
        hint = 'The page loaded, but the PHP API is not responding. ' +
               'Make sure the <code>api/</code> folder was uploaded and PHP is enabled.';
        if (detail) hint += '<br><small>Detail: ' + detail + '</small>';
        hint += '<br>For diagnostics open <a href="' + diagUrl + '" target="_blank">api/diag</a> in your browser.';
        hint += '<br><small>If diag also fails, try opening <code>' +
                (API_BASE === '.' ? '.' : API_BASE) +
                '/api/router.php?_route=health</code> directly. ' +
                'A blank page or 500 error means the <code>api/.htaccess</code> file may be ' +
                'causing problems — delete it and retry.</small>';
      }
      document.querySelector('.auth-container').insertAdjacentHTML('afterbegin',
        '<div class="file-protocol-warning">' +
        '<strong>⚠ Cannot reach the backend API</strong><br>' +
        hint +
        '</div>'
      );
    }
  })();
}

const tabs = document.querySelectorAll('.auth-tab');
const forms = document.querySelectorAll('.auth-form');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    forms.forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab + 'Form').classList.add('active');
  });
});

// Login
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';

  try {
    const res = await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password })
    });
    if (!res.headers.get('content-type')?.includes('application/json')) {
      errEl.textContent = 'The server did not return a valid response. Check that the api/ folder is uploaded and PHP is enabled.';
      return;
    }
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Login failed'; return; }
    window.location.href = 'app.html';
  } catch {
    errEl.textContent = location.protocol === 'file:'
      ? 'Cannot reach server – upload the folder to a web server or run it locally.'
      : 'Cannot reach the backend API. Check that the api/ folder is uploaded and PHP is enabled.';
  }
});

// Register
document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const errEl = document.getElementById('registerError');
  errEl.textContent = '';

  try {
    const res = await fetch(apiUrl('/api/auth/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, email, password })
    });
    if (!res.headers.get('content-type')?.includes('application/json')) {
      errEl.textContent = 'The server did not return a valid response. Check that the api/ folder is uploaded and PHP is enabled.';
      return;
    }
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Registration failed'; return; }
    window.location.href = 'app.html';
  } catch {
    errEl.textContent = location.protocol === 'file:'
      ? 'Cannot reach server – upload the folder to a web server or run it locally.'
      : 'Cannot reach the backend API. Check that the api/ folder is uploaded and PHP is enabled.';
  }
});

// Join team via token (available from login page even before logging in, but user needs session)
document.getElementById('joinBtn').addEventListener('click', async () => {
  const token = document.getElementById('inviteToken').value.trim();
  const msgEl = document.getElementById('joinMsg');
  msgEl.textContent = '';
  if (!token) { msgEl.textContent = 'Please enter a token'; return; }

  try {
    const res = await fetch(apiUrl('/api/teams/join/' + encodeURIComponent(token)), { method: 'POST', credentials: 'include' });
    if (!res.headers.get('content-type')?.includes('application/json')) {
      msgEl.textContent = 'The server did not return a valid response. Check that the api/ folder is uploaded and PHP is enabled.';
      return;
    }
    const data = await res.json();
    if (!res.ok) { msgEl.textContent = data.error || 'Failed'; return; }
    msgEl.textContent = 'Joined team: ' + (data.team ? data.team.name : '');
    setTimeout(() => { window.location.href = 'app.html'; }, 1000);
  } catch {
    msgEl.textContent = location.protocol === 'file:'
      ? 'Cannot reach server – upload the folder to a web server or run it locally.'
      : 'Cannot reach the backend API. Check that the api/ folder is uploaded and PHP is enabled.';
  }
});

// Check if already logged in
(async () => {
  try {
    const res = await fetch(apiUrl('/api/auth/me'), { credentials: 'include' });
    if (res.ok) window.location.href = 'app.html';
  } catch {}
})();

// Show version on login screen
(async () => {
  const el = document.getElementById('authVersion');
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
