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
    try {
      const res = await fetch(apiUrl('/api/health'), { credentials: 'include' });
      const data = res.ok ? await res.json() : null;
      if (!data || !data.ok) throw new Error();
    } catch {
      const safeBase = API_BASE.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      const diagUrl = apiUrl('/api/diag').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const hint = API_BASE && API_BASE !== '.'
        ? 'Check that the backend server at <code>' + safeBase + '</code> is running.'
        : 'The page loaded, but the PHP API is not responding. ' +
          'Make sure the <code>api/</code> folder was uploaded and PHP is enabled. ' +
          'For details open <a href="' + diagUrl + '" target="_blank">api/diag</a> in your browser.';
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
  try {
    const res = await fetch('version.json', { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      const el = document.getElementById('authVersion');
      if (el) el.textContent = 'v' + data.version;
    }
  } catch {}
})();
