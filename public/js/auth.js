'use strict';

// --------------------------------------------------------------------------
// Auth page logic
// --------------------------------------------------------------------------

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
    errEl.textContent = 'Network error';
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
    errEl.textContent = 'Network error';
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
    msgEl.textContent = 'Network error';
  }
});

// Check if already logged in
(async () => {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) window.location.href = '/app.html';
  } catch {}
})();
