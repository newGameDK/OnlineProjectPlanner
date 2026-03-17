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
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Login failed'; return; }
    window.location.href = '/app.html';
  } catch {
    errEl.textContent = location.protocol === 'file:'
      ? 'Cannot reach server – please run "npm start" and open http://localhost:3000'
      : 'Network error – is the server running?';
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
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Registration failed'; return; }
    window.location.href = '/app.html';
  } catch {
    errEl.textContent = location.protocol === 'file:'
      ? 'Cannot reach server – please run "npm start" and open http://localhost:3000'
      : 'Network error – is the server running?';
  }
});

// Join team via token (available from login page even before logging in, but user needs session)
document.getElementById('joinBtn').addEventListener('click', async () => {
  const token = document.getElementById('inviteToken').value.trim();
  const msgEl = document.getElementById('joinMsg');
  msgEl.textContent = '';
  if (!token) { msgEl.textContent = 'Please enter a token'; return; }

  try {
    const res = await fetch('/api/teams/join/' + encodeURIComponent(token), { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { msgEl.textContent = data.error || 'Failed'; return; }
    msgEl.textContent = 'Joined team: ' + (data.team ? data.team.name : '');
    setTimeout(() => { window.location.href = '/app.html'; }, 1000);
  } catch {
    msgEl.textContent = location.protocol === 'file:'
      ? 'Cannot reach server – please run "npm start" and open http://localhost:3000'
      : 'Network error – is the server running?';
  }
});

// Check if already logged in
(async () => {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) window.location.href = '/app.html';
  } catch {}
})();
