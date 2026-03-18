'use strict';

// --------------------------------------------------------------------------
// Auth page logic
// --------------------------------------------------------------------------

// Detect file:// protocol – the app must be served by the Node server
if (location.protocol === 'file:') {
  document.querySelector('.auth-container').insertAdjacentHTML('afterbegin',
    '<div class="file-protocol-warning">' +
    '<strong>⚠ Cannot connect to server</strong><br>' +
    'You opened this file directly. Start the server first, then visit ' +
    '<code>http://localhost:3000</code>' +
    '<code>npm install &amp;&amp; npm start</code>' +
    '</div>'
  );
}

// Probe the Node.js API to detect static-only hosting (e.g. a web hotel
// that serves the HTML/CSS/JS files but does not run the Node backend).
if (location.protocol !== 'file:') {
  (async () => {
    try {
      const res = await fetch(API_BASE + '/api/health', { credentials: 'include' });
      const data = res.ok ? await res.json() : null;
      if (!data || !data.ok) throw new Error();
    } catch {
      const safeBase = API_BASE.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      const hint = API_BASE
        ? 'Check that the backend server at <code>' + safeBase + '</code> is running.'
        : 'This app needs a running Node.js server – it cannot work on ' +
          'static-only hosting (e.g.&nbsp;a&nbsp;web&nbsp;hotel).<br>' +
          'Either run <code>npm install &amp;&amp; npm start</code> or set ' +
          '<code>API_BASE</code> in <code>js/config.js</code> to the URL of your backend.';
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
    const res = await fetch(API_BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password })
    });
    if (!res.headers.get('content-type')?.includes('application/json')) {
      errEl.textContent = 'The server did not return a valid response. Make sure the Node.js backend is running.';
      return;
    }
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Login failed'; return; }
    window.location.href = 'app.html';
  } catch {
    errEl.textContent = location.protocol === 'file:'
      ? 'Cannot reach server – please run "npm start" and open http://localhost:3000'
      : 'Cannot reach the backend API – make sure the Node.js server is running (npm start).';
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
    const res = await fetch(API_BASE + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, email, password })
    });
    if (!res.headers.get('content-type')?.includes('application/json')) {
      errEl.textContent = 'The server did not return a valid response. Make sure the Node.js backend is running.';
      return;
    }
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Registration failed'; return; }
    window.location.href = 'app.html';
  } catch {
    errEl.textContent = location.protocol === 'file:'
      ? 'Cannot reach server – please run "npm start" and open http://localhost:3000'
      : 'Cannot reach the backend API – make sure the Node.js server is running (npm start).';
  }
});

// Join team via token (available from login page even before logging in, but user needs session)
document.getElementById('joinBtn').addEventListener('click', async () => {
  const token = document.getElementById('inviteToken').value.trim();
  const msgEl = document.getElementById('joinMsg');
  msgEl.textContent = '';
  if (!token) { msgEl.textContent = 'Please enter a token'; return; }

  try {
    const res = await fetch(API_BASE + '/api/teams/join/' + encodeURIComponent(token), { method: 'POST', credentials: 'include' });
    if (!res.headers.get('content-type')?.includes('application/json')) {
      msgEl.textContent = 'The server did not return a valid response. Make sure the Node.js backend is running.';
      return;
    }
    const data = await res.json();
    if (!res.ok) { msgEl.textContent = data.error || 'Failed'; return; }
    msgEl.textContent = 'Joined team: ' + (data.team ? data.team.name : '');
    setTimeout(() => { window.location.href = 'app.html'; }, 1000);
  } catch {
    msgEl.textContent = location.protocol === 'file:'
      ? 'Cannot reach server – please run "npm start" and open http://localhost:3000'
      : 'Cannot reach the backend API – make sure the Node.js server is running (npm start).';
  }
});

// Check if already logged in
(async () => {
  try {
    const res = await fetch(API_BASE + '/api/auth/me', { credentials: 'include' });
    if (res.ok) window.location.href = 'app.html';
  } catch {}
})();
