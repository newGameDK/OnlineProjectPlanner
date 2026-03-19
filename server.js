'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'planner.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  base_color TEXT NOT NULL DEFAULT '#2196F3',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  capacity_hours_month INTEGER NOT NULL DEFAULT 160,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS gantt_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  hours_estimate REAL NOT NULL DEFAULT 0,
  color_variation INTEGER NOT NULL DEFAULT 0,
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  folder_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS todo_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  gantt_entry_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  assignee_id TEXT,
  due_date TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (gantt_entry_id) REFERENCES gantt_entries(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS undo_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gantt_dependencies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  UNIQUE(source_id, target_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES gantt_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES gantt_entries(id) ON DELETE CASCADE
);
`);

// Migration: add folder_url to existing databases that pre-date this column
try {
  db.exec(`ALTER TABLE gantt_entries ADD COLUMN folder_url TEXT NOT NULL DEFAULT ''`);
} catch (_) { /* column already exists – ignore */ }

// Migration: add share_token to projects
try {
  db.exec(`ALTER TABLE projects ADD COLUMN share_token TEXT`);
} catch (_) { /* column already exists – ignore */ }

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const stmts = {
  // Users
  createUser: db.prepare(`INSERT INTO users (id,username,email,password_hash,base_color) VALUES (?,?,?,?,?)`),
  getUserById: db.prepare(`SELECT * FROM users WHERE id=?`),
  getUserByUsername: db.prepare(`SELECT * FROM users WHERE username=?`),
  getUserByEmail: db.prepare(`SELECT * FROM users WHERE email=?`),
  updateUserColor: db.prepare(`UPDATE users SET base_color=? WHERE id=?`),

  // Teams
  createTeam: db.prepare(`INSERT INTO teams (id,name,owner_id,capacity_hours_month) VALUES (?,?,?,?)`),
  getTeam: db.prepare(`SELECT * FROM teams WHERE id=?`),
  updateTeamCapacity: db.prepare(`UPDATE teams SET capacity_hours_month=? WHERE id=?`),
  getUserTeams: db.prepare(`
    SELECT t.*, tm.role FROM teams t
    JOIN team_members tm ON t.id=tm.team_id
    WHERE tm.user_id=?
    ORDER BY t.created_at ASC
  `),
  getTeamMembers: db.prepare(`
    SELECT u.id, u.username, u.email, u.base_color, tm.role, tm.joined_at
    FROM team_members tm JOIN users u ON tm.user_id=u.id
    WHERE tm.team_id=?
  `),
  addTeamMember: db.prepare(`INSERT OR IGNORE INTO team_members (team_id,user_id,role) VALUES (?,?,?)`),
  removeTeamMember: db.prepare(`DELETE FROM team_members WHERE team_id=? AND user_id=?`),
  isMember: db.prepare(`SELECT 1 FROM team_members WHERE team_id=? AND user_id=?`),

  // Invitations
  createInvite: db.prepare(`INSERT INTO invitations (id,team_id,email,token,expires_at) VALUES (?,?,?,?,?)`),
  getInviteByToken: db.prepare(`SELECT * FROM invitations WHERE token=?`),
  deleteInvite: db.prepare(`DELETE FROM invitations WHERE id=?`),

  // Projects
  createProject: db.prepare(`INSERT INTO projects (id,team_id,name,description,created_by) VALUES (?,?,?,?,?)`),
  getProject: db.prepare(`SELECT * FROM projects WHERE id=?`),
  getTeamProjects: db.prepare(`SELECT * FROM projects WHERE team_id=? ORDER BY created_at ASC`),
  updateProject: db.prepare(`UPDATE projects SET name=?,description=?,updated_at=? WHERE id=?`),
  deleteProject: db.prepare(`DELETE FROM projects WHERE id=?`),
  setShareToken: db.prepare(`UPDATE projects SET share_token=? WHERE id=?`),
  getProjectByShareToken: db.prepare(`SELECT * FROM projects WHERE share_token=?`),

  // Gantt
  createGantt: db.prepare(`INSERT INTO gantt_entries (id,project_id,parent_id,title,start_date,end_date,hours_estimate,color_variation,user_id,position,notes,folder_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  getGantt: db.prepare(`SELECT * FROM gantt_entries WHERE id=?`),
  getProjectGantt: db.prepare(`SELECT * FROM gantt_entries WHERE project_id=? ORDER BY position ASC, created_at ASC`),
  getChildGantt: db.prepare(`SELECT * FROM gantt_entries WHERE parent_id=? ORDER BY position ASC, created_at ASC`),
  updateGantt: db.prepare(`UPDATE gantt_entries SET title=?,start_date=?,end_date=?,hours_estimate=?,color_variation=?,position=?,notes=?,folder_url=?,updated_at=? WHERE id=?`),
  deleteGantt: db.prepare(`DELETE FROM gantt_entries WHERE id=?`),
  getGanttUpdatedAfter: db.prepare(`SELECT * FROM gantt_entries WHERE project_id=? AND updated_at>? ORDER BY updated_at ASC`),

  // Todo
  createTodo: db.prepare(`INSERT INTO todo_items (id,project_id,gantt_entry_id,title,description,status,assignee_id,due_date,position) VALUES (?,?,?,?,?,?,?,?,?)`),
  getTodo: db.prepare(`SELECT * FROM todo_items WHERE id=?`),
  getProjectTodos: db.prepare(`SELECT * FROM todo_items WHERE project_id=? ORDER BY position ASC, created_at ASC`),
  updateTodo: db.prepare(`UPDATE todo_items SET title=?,description=?,status=?,assignee_id=?,due_date=?,position=?,updated_at=? WHERE id=?`),
  deleteTodo: db.prepare(`DELETE FROM todo_items WHERE id=?`),
  getTodoUpdatedAfter: db.prepare(`SELECT * FROM todo_items WHERE project_id=? AND updated_at>? ORDER BY updated_at ASC`),

  // Undo
  addUndo: db.prepare(`INSERT INTO undo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)`),
  getUndoForUser: db.prepare(`SELECT * FROM undo_history WHERE project_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50`),
  deleteUndo: db.prepare(`DELETE FROM undo_history WHERE id=?`),

  // Dependencies
  createDep: db.prepare(`INSERT OR IGNORE INTO gantt_dependencies (id,project_id,source_id,target_id) VALUES (?,?,?,?)`),
  getDep: db.prepare(`SELECT * FROM gantt_dependencies WHERE id=?`),
  getProjectDeps: db.prepare(`SELECT * FROM gantt_dependencies WHERE project_id=?`),
  deleteDep: db.prepare(`DELETE FROM gantt_dependencies WHERE id=?`),
  getDepsAfter: db.prepare(`SELECT * FROM gantt_dependencies WHERE project_id=? AND created_at>?`),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() { return Date.now(); }

function assertMember(teamId, userId) {
  if (!stmts.isMember.get(teamId, userId)) return false;
  return true;
}

function projectTeamId(projectId) {
  const p = stmts.getProject.get(projectId);
  return p ? p.team_id : null;
}

function canAccessProject(projectId, userId) {
  const teamId = projectTeamId(projectId);
  if (!teamId) return false;
  return assertMember(teamId, userId);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// CORS – allow the frontend to be hosted on a different origin.
// Set CORS_ORIGIN to the URL of the static frontend, e.g.
//   CORS_ORIGIN=https://undervisningsfysik.dk
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
if (CORS_ORIGIN) {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const sessionOpts = {
  secret: process.env.SESSION_SECRET || 'planner-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
};
// When the frontend is on a different origin the session cookie must be
// sent cross-site, which requires SameSite=None and Secure (HTTPS).
if (CORS_ORIGIN) {
  sessionOpts.cookie.sameSite = 'none';
  sessionOpts.cookie.secure   = true;
}
app.use(session(sessionOpts));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// Health check – used by the client to verify the API is reachable
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  if (stmts.getUserByUsername.get(username)) return res.status(409).json({ error: 'Username already taken' });
  if (stmts.getUserByEmail.get(email)) return res.status(409).json({ error: 'Email already registered' });

  const BASE_COLORS = [
    '#2196F3','#4CAF50','#FF9800','#9C27B0','#F44336',
    '#009688','#E91E63','#3F51B5','#795548','#00BCD4'
  ];
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const baseColor = BASE_COLORS[userCount % BASE_COLORS.length];

  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  try {
    stmts.createUser.run(id, username, email, hash, baseColor);
    req.session.userId = id;
    const user = stmts.getUserById.get(id);
    res.json({ user: sanitizeUser(user) });
  } catch (e) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = stmts.getUserByUsername.get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.userId = user.id;
  res.json({ user: sanitizeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = stmts.getUserById.get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: sanitizeUser(user) });
});

app.put('/api/auth/me', requireAuth, (req, res) => {
  const { base_color } = req.body;
  if (base_color) stmts.updateUserColor.run(base_color, req.session.userId);
  const user = stmts.getUserById.get(req.session.userId);
  res.json({ user: sanitizeUser(user) });
});

function sanitizeUser(u) {
  return { id: u.id, username: u.username, email: u.email, base_color: u.base_color, created_at: u.created_at };
}

// ---------------------------------------------------------------------------
// Team routes
// ---------------------------------------------------------------------------

app.get('/api/teams', requireAuth, (req, res) => {
  const teams = stmts.getUserTeams.all(req.session.userId);
  res.json({ teams });
});

app.post('/api/teams', requireAuth, (req, res) => {
  const { name, capacity_hours_month } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  stmts.createTeam.run(id, name, req.session.userId, capacity_hours_month || 160);
  stmts.addTeamMember.run(id, req.session.userId, 'owner');
  const team = stmts.getTeam.get(id);
  broadcast({ type: 'team_created', team }, null, req.session.userId);
  res.json({ team });
});

app.get('/api/teams/:id', requireAuth, (req, res) => {
  const team = stmts.getTeam.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (!assertMember(team.id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });
  const members = stmts.getTeamMembers.all(team.id);
  res.json({ team, members });
});

app.put('/api/teams/:id', requireAuth, (req, res) => {
  const team = stmts.getTeam.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only owner can update team' });
  const { capacity_hours_month } = req.body;
  if (capacity_hours_month) stmts.updateTeamCapacity.run(capacity_hours_month, team.id);
  const updated = stmts.getTeam.get(team.id);
  broadcastToTeam(team.id, { type: 'team_updated', team: updated });
  res.json({ team: updated });
});

app.post('/api/teams/:id/invite', requireAuth, (req, res) => {
  const team = stmts.getTeam.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (!assertMember(team.id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  // Check if user with that email exists; if so, add directly
  const targetUser = stmts.getUserByEmail.get(email);
  if (targetUser) {
    stmts.addTeamMember.run(team.id, targetUser.id, 'member');
    broadcastToTeam(team.id, { type: 'member_added', team_id: team.id, user: sanitizeUser(targetUser) });
    return res.json({ added: true, message: `${targetUser.username} added to team` });
  }

  // Create invitation token
  const token = uuidv4();
  const expires = now() + 7 * 24 * 60 * 60 * 1000;
  stmts.createInvite.run(uuidv4(), team.id, email, token, expires);
  res.json({ added: false, token, message: 'Invitation created. Share the token with the user.' });
});

app.post('/api/teams/join/:token', requireAuth, (req, res) => {
  const inv = stmts.getInviteByToken.get(req.params.token);
  if (!inv) return res.status(404).json({ error: 'Invalid token' });
  if (inv.expires_at < now()) return res.status(410).json({ error: 'Token expired' });

  stmts.addTeamMember.run(inv.team_id, req.session.userId, 'member');
  stmts.deleteInvite.run(inv.id);
  const team = stmts.getTeam.get(inv.team_id);
  const user = stmts.getUserById.get(req.session.userId);
  broadcastToTeam(inv.team_id, { type: 'member_added', team_id: inv.team_id, user: sanitizeUser(user) });
  res.json({ team });
});

app.delete('/api/teams/:id/members/:userId', requireAuth, (req, res) => {
  const team = stmts.getTeam.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.owner_id !== req.session.userId && req.params.userId !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  stmts.removeTeamMember.run(team.id, req.params.userId);
  broadcastToTeam(team.id, { type: 'member_removed', team_id: team.id, user_id: req.params.userId });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Project routes
// ---------------------------------------------------------------------------

app.get('/api/projects', requireAuth, (req, res) => {
  const { team_id } = req.query;
  if (!team_id) return res.status(400).json({ error: 'team_id required' });
  if (!assertMember(team_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });
  const projects = stmts.getTeamProjects.all(team_id);
  res.json({ projects });
});

app.post('/api/projects', requireAuth, (req, res) => {
  const { team_id, name, description } = req.body;
  if (!team_id || !name) return res.status(400).json({ error: 'team_id and name required' });
  if (!assertMember(team_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  const id = uuidv4();
  stmts.createProject.run(id, team_id, name, description || '', req.session.userId);
  const project = stmts.getProject.get(id);
  broadcastToTeam(team_id, { type: 'project_created', project });
  res.json({ project });
});

app.put('/api/projects/:id', requireAuth, (req, res) => {
  const project = stmts.getProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (!assertMember(project.team_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  const { name, description } = req.body;
  stmts.updateProject.run(name || project.name, description ?? project.description, now(), project.id);
  const updated = stmts.getProject.get(project.id);
  broadcastToTeam(project.team_id, { type: 'project_updated', project: updated });
  res.json({ project: updated });
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const project = stmts.getProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (!assertMember(project.team_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  stmts.deleteProject.run(project.id);
  broadcastToTeam(project.team_id, { type: 'project_deleted', project_id: project.id });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Share routes (read-only public access)
// ---------------------------------------------------------------------------

app.post('/api/projects/:id/share', requireAuth, (req, res) => {
  const project = stmts.getProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (!assertMember(project.team_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  const token = uuidv4();
  stmts.setShareToken.run(token, project.id);
  // Return token to caller so the UI can build the link
  res.json({ token });
});

app.delete('/api/projects/:id/share', requireAuth, (req, res) => {
  const project = stmts.getProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (!assertMember(project.team_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  stmts.setShareToken.run(null, project.id);
  res.json({ ok: true });
});

// Public endpoint – no authentication required
app.get('/api/share/:token', (req, res) => {
  const project = stmts.getProjectByShareToken.get(req.params.token);
  if (!project) return res.status(404).json({ error: 'Invalid or expired share link' });

  const entries      = stmts.getProjectGantt.all(project.id);
  const todos        = stmts.getProjectTodos.all(project.id);
  const dependencies = stmts.getProjectDeps.all(project.id);
  const members      = stmts.getTeamMembers.all(project.team_id)
    .map(m => ({ id: m.id, username: m.username, base_color: m.base_color }));

  res.json({
    project: { id: project.id, name: project.name, description: project.description },
    entries,
    todos,
    dependencies,
    members,
  });
});

// ---------------------------------------------------------------------------
// Gantt routes
// ---------------------------------------------------------------------------

app.get('/api/gantt/:projectId', requireAuth, (req, res) => {
  if (!canAccessProject(req.params.projectId, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });
  const entries = stmts.getProjectGantt.all(req.params.projectId);
  res.json({ entries });
});

app.post('/api/gantt', requireAuth, (req, res) => {
  const { project_id, parent_id, title, start_date, end_date, hours_estimate, color_variation, position, notes, folder_url } = req.body;
  if (!project_id || !title || !start_date || !end_date) return res.status(400).json({ error: 'Missing required fields' });
  if (!canAccessProject(project_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  const id = uuidv4();
  stmts.createGantt.run(id, project_id, parent_id || null, title, start_date, end_date,
    hours_estimate || 0, color_variation || 0, req.session.userId, position || 0, notes || '', folder_url || '');

  const entry = stmts.getGantt.get(id);
  const teamId = projectTeamId(project_id);

  // Save undo action
  stmts.addUndo.run(uuidv4(), project_id, req.session.userId, 'create_gantt', JSON.stringify({ entry }));

  broadcastToTeam(teamId, { type: 'gantt_created', entry });
  res.json({ entry });
});

app.put('/api/gantt/:id', requireAuth, (req, res) => {
  const existing = stmts.getGantt.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canAccessProject(existing.project_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  // Save undo action before update
  stmts.addUndo.run(uuidv4(), existing.project_id, req.session.userId, 'update_gantt', JSON.stringify({ entry: existing }));

  const { title, start_date, end_date, hours_estimate, color_variation, position, notes, folder_url } = req.body;
  stmts.updateGantt.run(
    title ?? existing.title,
    start_date ?? existing.start_date,
    end_date ?? existing.end_date,
    hours_estimate ?? existing.hours_estimate,
    color_variation ?? existing.color_variation,
    position ?? existing.position,
    notes ?? existing.notes,
    folder_url !== undefined ? folder_url : existing.folder_url,
    now(),
    existing.id
  );
  const entry = stmts.getGantt.get(existing.id);
  const teamId = projectTeamId(existing.project_id);
  broadcastToTeam(teamId, { type: 'gantt_updated', entry });
  res.json({ entry });
});

app.delete('/api/gantt/:id', requireAuth, (req, res) => {
  const existing = stmts.getGantt.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canAccessProject(existing.project_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  // Save undo action
  stmts.addUndo.run(uuidv4(), existing.project_id, req.session.userId, 'delete_gantt', JSON.stringify({ entry: existing }));

  stmts.deleteGantt.run(existing.id);
  const teamId = projectTeamId(existing.project_id);
  broadcastToTeam(teamId, { type: 'gantt_deleted', entry_id: existing.id, project_id: existing.project_id });
  res.json({ ok: true });
});

// Sync endpoint: returns all changes after a given timestamp
app.get('/api/sync/:projectId', requireAuth, (req, res) => {
  if (!canAccessProject(req.params.projectId, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });
  const since = parseInt(req.query.since) || 0;
  const ganttUpdates = stmts.getGanttUpdatedAfter.all(req.params.projectId, since);
  const todoUpdates  = stmts.getTodoUpdatedAfter.all(req.params.projectId, since);
  const depUpdates   = stmts.getDepsAfter.all(req.params.projectId, since);
  res.json({ gantt: ganttUpdates, todos: todoUpdates, dependencies: depUpdates, server_time: now() });
});

// ---------------------------------------------------------------------------
// Dependency routes
// ---------------------------------------------------------------------------

app.get('/api/dependencies/:projectId', requireAuth, (req, res) => {
  if (!canAccessProject(req.params.projectId, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });
  const dependencies = stmts.getProjectDeps.all(req.params.projectId);
  res.json({ dependencies });
});

app.post('/api/dependencies', requireAuth, (req, res) => {
  const { project_id, source_id, target_id } = req.body;
  if (!project_id || !source_id || !target_id) return res.status(400).json({ error: 'Missing fields' });
  if (!canAccessProject(project_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });
  if (source_id === target_id) return res.status(400).json({ error: 'Cannot depend on itself' });

  const id = uuidv4();
  stmts.createDep.run(id, project_id, source_id, target_id);
  const dep = stmts.getDep.get(id);
  const teamId = projectTeamId(project_id);
  broadcastToTeam(teamId, { type: 'dep_created', dep });
  res.json({ dep });
});

app.delete('/api/dependencies/:id', requireAuth, (req, res) => {
  const dep = stmts.getDep.get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'Not found' });
  if (!canAccessProject(dep.project_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });
  stmts.deleteDep.run(dep.id);
  const teamId = projectTeamId(dep.project_id);
  broadcastToTeam(teamId, { type: 'dep_deleted', dep_id: dep.id, project_id: dep.project_id });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Todo routes
// ---------------------------------------------------------------------------

app.get('/api/todos/:projectId', requireAuth, (req, res) => {
  if (!canAccessProject(req.params.projectId, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });
  const todos = stmts.getProjectTodos.all(req.params.projectId);
  res.json({ todos });
});

app.post('/api/todos', requireAuth, (req, res) => {
  const { project_id, gantt_entry_id, title, description, status, assignee_id, due_date, position } = req.body;
  if (!project_id || !title) return res.status(400).json({ error: 'Missing required fields' });
  if (!canAccessProject(project_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  const id = uuidv4();
  stmts.createTodo.run(id, project_id, gantt_entry_id || null, title, description || '',
    status || 'todo', assignee_id || null, due_date || null, position || 0);
  const todo = stmts.getTodo.get(id);
  const teamId = projectTeamId(project_id);
  broadcastToTeam(teamId, { type: 'todo_created', todo });
  res.json({ todo });
});

app.put('/api/todos/:id', requireAuth, (req, res) => {
  const existing = stmts.getTodo.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canAccessProject(existing.project_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  const { title, description, status, assignee_id, due_date, position } = req.body;
  stmts.updateTodo.run(
    title ?? existing.title,
    description ?? existing.description,
    status ?? existing.status,
    assignee_id ?? existing.assignee_id,
    due_date ?? existing.due_date,
    position ?? existing.position,
    now(),
    existing.id
  );
  const todo = stmts.getTodo.get(existing.id);
  const teamId = projectTeamId(existing.project_id);
  broadcastToTeam(teamId, { type: 'todo_updated', todo });
  res.json({ todo });
});

app.delete('/api/todos/:id', requireAuth, (req, res) => {
  const existing = stmts.getTodo.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canAccessProject(existing.project_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  stmts.deleteTodo.run(existing.id);
  const teamId = projectTeamId(existing.project_id);
  broadcastToTeam(teamId, { type: 'todo_deleted', todo_id: existing.id, project_id: existing.project_id });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Undo route
// ---------------------------------------------------------------------------

app.post('/api/undo/:projectId', requireAuth, (req, res) => {
  if (!canAccessProject(req.params.projectId, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  const history = stmts.getUndoForUser.all(req.params.projectId, req.session.userId);
  if (!history.length) return res.status(400).json({ error: 'Nothing to undo' });

  const action = history[0];
  const data = JSON.parse(action.action_data);
  stmts.deleteUndo.run(action.id);

  let result = {};
  if (action.action_type === 'create_gantt') {
    // Undo creation = delete
    stmts.deleteGantt.run(data.entry.id);
    const teamId = projectTeamId(req.params.projectId);
    broadcastToTeam(teamId, { type: 'gantt_deleted', entry_id: data.entry.id, project_id: req.params.projectId });
    result = { undone: 'create_gantt', entry_id: data.entry.id };
  } else if (action.action_type === 'update_gantt') {
    // Undo update = restore previous state
    const e = data.entry;
    db.prepare(`UPDATE gantt_entries SET title=?,start_date=?,end_date=?,hours_estimate=?,color_variation=?,position=?,notes=?,folder_url=?,updated_at=? WHERE id=?`)
      .run(e.title, e.start_date, e.end_date, e.hours_estimate, e.color_variation, e.position, e.notes, e.folder_url || '', now(), e.id);
    const entry = stmts.getGantt.get(e.id);
    const teamId = projectTeamId(req.params.projectId);
    if (entry) broadcastToTeam(teamId, { type: 'gantt_updated', entry });
    result = { undone: 'update_gantt', entry };
  } else if (action.action_type === 'delete_gantt') {
    // Undo deletion = recreate
    const e = data.entry;
    try {
      stmts.createGantt.run(e.id, e.project_id, e.parent_id, e.title, e.start_date, e.end_date,
        e.hours_estimate, e.color_variation, e.user_id, e.position, e.notes, e.folder_url || '');
    } catch (_) { /* already exists */ }
    const entry = stmts.getGantt.get(e.id);
    const teamId = projectTeamId(req.params.projectId);
    if (entry) broadcastToTeam(teamId, { type: 'gantt_created', entry });
    result = { undone: 'delete_gantt', entry };
  }

  res.json(result);
});

// ---------------------------------------------------------------------------
// Backup route – export all user data as JSON
// ---------------------------------------------------------------------------

app.get('/api/backup', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const user = stmts.getUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const teams = stmts.getUserTeams.all(userId);
  const backup = {
    version: 1,
    exported_at: new Date().toISOString(),
    user: sanitizeUser(user),
    teams: teams.map(team => {
      const members = stmts.getTeamMembers.all(team.id);
      const projects = stmts.getTeamProjects.all(team.id);

      return {
        ...team,
        members: members.map(m => ({ id: m.id, username: m.username, email: m.email, base_color: m.base_color, role: m.role })),
        projects: projects.map(proj => {
          const entries      = stmts.getProjectGantt.all(proj.id);
          const todos        = stmts.getProjectTodos.all(proj.id);
          const dependencies = stmts.getProjectDeps.all(proj.id);
          return { ...proj, entries, todos, dependencies };
        }),
      };
    }),
  };

  res.setHeader('Content-Disposition', 'attachment; filename="planner_backup_' + new Date().toISOString().slice(0,10) + '.json"');
  res.json(backup);
});

// ---------------------------------------------------------------------------
// Version route
// ---------------------------------------------------------------------------

app.get('/api/version', (_req, res) => {
  const versionFile = path.join(__dirname, 'public', 'version.json');
  if (fs.existsSync(versionFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      return res.json(data);
    } catch { /* fall through */ }
  }
  res.json({ version: 'unknown' });
});

// ---------------------------------------------------------------------------
// Update route – Upload a ZIP to update the application
// ---------------------------------------------------------------------------

const multerImported = (() => { try { return require('multer'); } catch { return null; } })();

app.post('/api/update', requireAuth, (req, res) => {
  // For Node.js deployment, we need multer for file uploads.
  // If multer is not installed, we return a helpful error.
  if (!multerImported) {
    return res.status(501).json({
      error: 'File upload is not supported on this Node.js deployment. ' +
             'Install multer (npm install multer) or use the PHP deployment for in-app updates.'
    });
  }

  const upload = multerImported({ dest: path.join(DATA_DIR, 'tmp_uploads') }).single('zipfile');
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let AdmZip;
    try { AdmZip = require('adm-zip'); } catch {
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(501).json({
        error: 'ZIP handling not available. Install adm-zip (npm install adm-zip) for Node.js updates.'
      });
    }

    try {
      const zip = new AdmZip(req.file.path);
      const entries = zip.getEntries();
      const publicDir = path.join(__dirname, 'public');

      // Find the root of the application inside the ZIP
      let zipBase = '';
      for (const entry of entries) {
        const name = entry.entryName;
        const match = name.match(/^((?:[^/]+\/)*)version\.json$/);
        if (match) { zipBase = match[1]; break; }
      }
      if (!zipBase) {
        for (const entry of entries) {
          const name = entry.entryName;
          const match = name.match(/^((?:[^/]+\/)*)index\.html$/);
          if (match) { zipBase = match[1]; break; }
        }
      }

      // Read new version
      let newVersion = 'unknown';
      const versionEntry = zip.getEntry(zipBase + 'version.json');
      if (versionEntry) {
        try {
          const vData = JSON.parse(versionEntry.getData().toString('utf8'));
          if (vData.version) newVersion = vData.version;
        } catch { /* ignore */ }
      }

      const protectedPaths = ['api/data/'];
      let extracted = 0;
      let skipped = 0;

      for (const entry of entries) {
        if (zipBase && !entry.entryName.startsWith(zipBase)) continue;
        const relativePath = entry.entryName.substring(zipBase.length);
        if (!relativePath) continue;

        // Path traversal protection: reject paths with ..
        if (relativePath.includes('..')) { skipped++; continue; }

        // Check protected paths
        let isProtected = false;
        for (const pp of protectedPaths) {
          if (relativePath.startsWith(pp)) { isProtected = true; break; }
        }
        if (isProtected) { skipped++; continue; }

        const targetPath = path.join(publicDir, relativePath);

        // Verify resolved path is within publicDir (defense in depth)
        const resolvedPublic = path.resolve(publicDir);
        const resolvedTarget = path.resolve(targetPath);
        if (!resolvedTarget.startsWith(resolvedPublic + path.sep) && resolvedTarget !== resolvedPublic) {
          skipped++;
          continue;
        }

        if (entry.isDirectory) {
          if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
          continue;
        }

        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });

        fs.writeFileSync(targetPath, entry.getData());
        extracted++;
      }

      // Clean up
      fs.unlinkSync(req.file.path);

      res.json({
        ok: true,
        version: newVersion,
        extracted,
        skipped,
        message: `Update applied successfully. ${extracted} files updated, ${skipped} protected files skipped.`
      });
    } catch (e) {
      // Clean up on error
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: 'Update failed: ' + e.message });
    }
  });
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Map: userId -> Set of ws connections
const userConnections = new Map();
// Map: ws -> { userId, teamIds, projectId }
const connMeta = new WeakMap();

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        // Client sends its userId after connection
        const { userId, projectId } = msg;
        if (!userId) return;
        connMeta.set(ws, { userId, projectId });
        if (!userConnections.has(userId)) userConnections.set(userId, new Set());
        userConnections.get(userId).add(ws);

        ws.send(JSON.stringify({ type: 'auth_ok' }));
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    const meta = connMeta.get(ws);
    if (meta && userConnections.has(meta.userId)) {
      userConnections.get(meta.userId).delete(ws);
    }
  });
});

function broadcastToTeam(teamId, message) {
  if (!teamId) return;
  const members = stmts.getTeamMembers.all(teamId);
  const payload = JSON.stringify(message);
  members.forEach(m => {
    const conns = userConnections.get(m.id);
    if (conns) {
      conns.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      });
    }
  });
}

function broadcast(message, teamId, excludeUserId) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      const meta = connMeta.get(ws);
      if (excludeUserId && meta && meta.userId === excludeUserId) return;
      ws.send(payload);
    }
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`OnlineProjectPlanner running on http://localhost:${PORT}`);
});
