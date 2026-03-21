'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const https = require('https');
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
  subtract_hours INTEGER NOT NULL DEFAULT 0,
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

// Migration: add subtract_hours to gantt_entries
try {
  db.exec(`ALTER TABLE gantt_entries ADD COLUMN subtract_hours INTEGER NOT NULL DEFAULT 0`);
} catch (_) { /* column already exists – ignore */ }

// App settings table (key-value store for admin user IDs etc.)
db.exec(`
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Global undo history (not project-scoped; survives team/project deletion)
db.exec(`
CREATE TABLE IF NOT EXISTS global_undo_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

// Redo history (project-scoped; mirrors undo_history structure)
db.exec(`
CREATE TABLE IF NOT EXISTS redo_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
`);

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

  // App settings (admin management)
  getSetting: db.prepare(`SELECT value FROM app_settings WHERE key=?`),
  setSetting: db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`),

  // Teams
  createTeam: db.prepare(`INSERT INTO teams (id,name,owner_id,capacity_hours_month) VALUES (?,?,?,?)`),
  getTeam: db.prepare(`SELECT * FROM teams WHERE id=?`),
  updateTeamCapacity: db.prepare(`UPDATE teams SET capacity_hours_month=? WHERE id=?`),
  deleteTeam: db.prepare(`DELETE FROM teams WHERE id=?`),
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
  restoreProjectMeta: db.prepare(`UPDATE projects SET share_token=?,created_at=?,updated_at=? WHERE id=?`),
  getProjectByShareToken: db.prepare(`SELECT * FROM projects WHERE share_token=?`),

  // Gantt
  createGantt: db.prepare(`INSERT INTO gantt_entries (id,project_id,parent_id,title,start_date,end_date,hours_estimate,color_variation,user_id,position,notes,folder_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  getGantt: db.prepare(`SELECT * FROM gantt_entries WHERE id=?`),
  getProjectGantt: db.prepare(`SELECT * FROM gantt_entries WHERE project_id=? ORDER BY position ASC, created_at ASC`),
  getChildGantt: db.prepare(`SELECT * FROM gantt_entries WHERE parent_id=? ORDER BY position ASC, created_at ASC`),
  updateGantt: db.prepare(`UPDATE gantt_entries SET parent_id=?,title=?,start_date=?,end_date=?,hours_estimate=?,color_variation=?,position=?,notes=?,folder_url=?,subtract_hours=?,updated_at=? WHERE id=?`),
  updateGanttSubtractHours: db.prepare(`UPDATE gantt_entries SET subtract_hours=? WHERE id=?`),
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
  getUndoForUser: db.prepare(`SELECT * FROM undo_history WHERE project_id=? AND user_id=? ORDER BY created_at DESC LIMIT 200`),
  deleteUndo: db.prepare(`DELETE FROM undo_history WHERE id=?`),

  // Redo
  addRedo: db.prepare(`INSERT INTO redo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)`),
  getRedoForUser: db.prepare(`SELECT * FROM redo_history WHERE project_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1`),
  deleteRedo: db.prepare(`DELETE FROM redo_history WHERE id=?`),
  clearRedoForProject: db.prepare(`DELETE FROM redo_history WHERE project_id=? AND user_id=?`),

  // Global undo (team/project-level operations that survive deletion)
  addGlobalUndo: db.prepare(`INSERT INTO global_undo_history (id,user_id,action_type,action_data) VALUES (?,?,?,?)`),
  getLatestGlobalUndo: db.prepare(`SELECT * FROM global_undo_history WHERE user_id=? ORDER BY created_at DESC LIMIT 1`),
  deleteGlobalUndo: db.prepare(`DELETE FROM global_undo_history WHERE id=?`),

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

app.delete('/api/teams/:id', requireAuth, (req, res) => {
  const team = stmts.getTeam.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only owner can delete team' });
  const members = stmts.getTeamMembers.all(team.id);

  // Snapshot the full team for undo before cascade deletion removes everything
  const projects = stmts.getTeamProjects.all(team.id);
  const teamSnapshot = {
    team,
    members,
    projects: projects.map(p => ({
      project: p,
      entries: stmts.getProjectGantt.all(p.id),
      todos: stmts.getProjectTodos.all(p.id),
      dependencies: stmts.getProjectDeps.all(p.id),
    })),
  };
  stmts.addGlobalUndo.run(uuidv4(), req.session.userId, 'delete_team', JSON.stringify(teamSnapshot));

  // Notify members before deleting so the team_members cascade hasn't run yet
  members.forEach(m => {
    const conns = userConnections.get(m.id);
    if (conns) {
      conns.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'team_deleted', team_id: team.id }));
      });
    }
  });
  stmts.deleteTeam.run(team.id);
  res.json({ ok: true });
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

  // Snapshot the full project for undo before cascade deletion removes everything
  const projectSnapshot = {
    project,
    entries: stmts.getProjectGantt.all(project.id),
    todos: stmts.getProjectTodos.all(project.id),
    dependencies: stmts.getProjectDeps.all(project.id),
  };
  stmts.addGlobalUndo.run(uuidv4(), req.session.userId, 'delete_project', JSON.stringify(projectSnapshot));

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

  // Save undo action; clear any stale redo history for this project/user
  stmts.clearRedoForProject.run(project_id, req.session.userId);
  stmts.addUndo.run(uuidv4(), project_id, req.session.userId, 'create_gantt', JSON.stringify({ entry }));

  broadcastToTeam(teamId, { type: 'gantt_created', entry });
  res.json({ entry });
});

app.put('/api/gantt/:id', requireAuth, (req, res) => {
  const existing = stmts.getGantt.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canAccessProject(existing.project_id, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  // If parent_id is being changed, prevent circular references
  const newParentId = req.body.parent_id !== undefined ? (req.body.parent_id || null) : existing.parent_id;
  if (newParentId !== existing.parent_id && newParentId !== null) {
    // Cannot set parent to self
    if (newParentId === existing.id) return res.status(400).json({ error: 'Cannot set parent to self' });
    // Walk up the ancestry of newParentId to ensure existing.id is not an ancestor
    let cursor = newParentId;
    while (cursor) {
      const ancestor = stmts.getGantt.get(cursor);
      if (!ancestor) break;
      if (ancestor.parent_id === existing.id) {
        return res.status(400).json({ error: 'Circular parent reference' });
      }
      cursor = ancestor.parent_id;
    }
  }

  // Save undo action before update; clear any stale redo history for this project/user
  stmts.clearRedoForProject.run(existing.project_id, req.session.userId);
  stmts.addUndo.run(uuidv4(), existing.project_id, req.session.userId, 'update_gantt', JSON.stringify({ entry: existing }));

  const { title, start_date, end_date, hours_estimate, color_variation, position, notes, folder_url, subtract_hours } = req.body;
  stmts.updateGantt.run(
    newParentId,
    title ?? existing.title,
    start_date ?? existing.start_date,
    end_date ?? existing.end_date,
    hours_estimate ?? existing.hours_estimate,
    color_variation ?? existing.color_variation,
    position ?? existing.position,
    notes ?? existing.notes,
    folder_url !== undefined ? folder_url : existing.folder_url,
    subtract_hours !== undefined ? (subtract_hours ? 1 : 0) : existing.subtract_hours,
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

  // Save undo action; clear any stale redo history for this project/user
  stmts.clearRedoForProject.run(existing.project_id, req.session.userId);
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
    // Undo creation = delete; save entry to redo so it can be recreated
    const entryBeforeDelete = stmts.getGantt.get(data.entry.id);
    if (entryBeforeDelete) {
      stmts.addRedo.run(uuidv4(), req.params.projectId, req.session.userId, 'create_gantt', JSON.stringify({ entry: entryBeforeDelete }));
    }
    stmts.deleteGantt.run(data.entry.id);
    const teamId = projectTeamId(req.params.projectId);
    broadcastToTeam(teamId, { type: 'gantt_deleted', entry_id: data.entry.id, project_id: req.params.projectId });
    result = { undone: 'create_gantt', entry_id: data.entry.id };
  } else if (action.action_type === 'update_gantt') {
    // Undo update = restore previous state; save current state to redo
    const e = data.entry;
    const currentEntry = stmts.getGantt.get(e.id);
    if (currentEntry) {
      stmts.addRedo.run(uuidv4(), req.params.projectId, req.session.userId, 'update_gantt', JSON.stringify({ entry: currentEntry }));
    }
    db.prepare(`UPDATE gantt_entries SET title=?,start_date=?,end_date=?,hours_estimate=?,color_variation=?,position=?,notes=?,folder_url=?,subtract_hours=?,updated_at=? WHERE id=?`)
      .run(e.title, e.start_date, e.end_date, e.hours_estimate, e.color_variation, e.position, e.notes, e.folder_url || '', e.subtract_hours || 0, now(), e.id);
    const entry = stmts.getGantt.get(e.id);
    const teamId = projectTeamId(req.params.projectId);
    if (entry) broadcastToTeam(teamId, { type: 'gantt_updated', entry });
    result = { undone: 'update_gantt', entry };
  } else if (action.action_type === 'delete_gantt') {
    // Undo deletion = recreate; save to redo so it can be deleted again
    const e = data.entry;
    stmts.addRedo.run(uuidv4(), req.params.projectId, req.session.userId, 'delete_gantt', JSON.stringify({ entry: e }));
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
// Redo route
// ---------------------------------------------------------------------------

app.post('/api/redo/:projectId', requireAuth, (req, res) => {
  if (!canAccessProject(req.params.projectId, req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

  const redoAction = stmts.getRedoForUser.get(req.params.projectId, req.session.userId);
  if (!redoAction) return res.status(400).json({ error: 'Nothing to redo' });

  const data = JSON.parse(redoAction.action_data);
  stmts.deleteRedo.run(redoAction.id);

  let result = {};
  if (redoAction.action_type === 'create_gantt') {
    // Redo: recreate the entry that was originally created then undone
    const e = data.entry;
    try {
      stmts.createGantt.run(e.id, e.project_id, e.parent_id, e.title, e.start_date, e.end_date,
        e.hours_estimate, e.color_variation, e.user_id, e.position, e.notes, e.folder_url || '');
    } catch (_) { /* already exists */ }
    const entry = stmts.getGantt.get(e.id);
    const teamId = projectTeamId(req.params.projectId);
    if (entry) broadcastToTeam(teamId, { type: 'gantt_created', entry });
    // Save new undo action so user can undo this redo
    stmts.addUndo.run(uuidv4(), req.params.projectId, req.session.userId, 'create_gantt', JSON.stringify({ entry }));
    result = { redone: 'create_gantt', entry };
  } else if (redoAction.action_type === 'update_gantt') {
    // Redo: re-apply the update (restore to the state stored in redo data)
    const e = data.entry;
    const currentEntry = stmts.getGantt.get(e.id);
    if (currentEntry) {
      // Save current state as undo so user can undo this redo
      stmts.addUndo.run(uuidv4(), req.params.projectId, req.session.userId, 'update_gantt', JSON.stringify({ entry: currentEntry }));
      db.prepare(`UPDATE gantt_entries SET title=?,start_date=?,end_date=?,hours_estimate=?,color_variation=?,position=?,notes=?,folder_url=?,subtract_hours=?,updated_at=? WHERE id=?`)
        .run(e.title, e.start_date, e.end_date, e.hours_estimate, e.color_variation, e.position, e.notes, e.folder_url || '', e.subtract_hours || 0, now(), e.id);
      const entry = stmts.getGantt.get(e.id);
      const teamId = projectTeamId(req.params.projectId);
      if (entry) broadcastToTeam(teamId, { type: 'gantt_updated', entry });
      result = { redone: 'update_gantt', entry };
    } else {
      result = { redone: 'update_gantt', entry: null };
    }
  } else if (redoAction.action_type === 'delete_gantt') {
    // Redo: delete the entry again
    const e = data.entry;
    const currentEntry = stmts.getGantt.get(e.id);
    if (currentEntry) {
      // Save undo action so user can undo this redo
      stmts.addUndo.run(uuidv4(), req.params.projectId, req.session.userId, 'delete_gantt', JSON.stringify({ entry: currentEntry }));
      stmts.deleteGantt.run(e.id);
      const teamId = projectTeamId(req.params.projectId);
      broadcastToTeam(teamId, { type: 'gantt_deleted', entry_id: e.id, project_id: req.params.projectId });
    }
    result = { redone: 'delete_gantt', entry_id: e.id };
  }

  res.json(result);
});

// ---------------------------------------------------------------------------
// Global undo route (team/project-level deletion)
// ---------------------------------------------------------------------------

app.post('/api/undo-global', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const action = stmts.getLatestGlobalUndo.get(userId);
  if (!action) return res.status(400).json({ error: 'Nothing to undo' });

  const data = JSON.parse(action.action_data);
  stmts.deleteGlobalUndo.run(action.id);

  let result = {};
  if (action.action_type === 'delete_project') {
    const p = data.project;
    // Restore project
    try {
      stmts.createProject.run(p.id, p.team_id, p.name, p.description || '', p.created_by);
      stmts.restoreProjectMeta.run(p.share_token || null, p.created_at, p.updated_at, p.id);
    } catch (_) { /* already exists */ }
    // Restore gantt entries
    for (const e of (data.entries || [])) {
      try {
        stmts.createGantt.run(e.id, e.project_id, e.parent_id, e.title, e.start_date, e.end_date,
          e.hours_estimate, e.color_variation, e.user_id, e.position, e.notes, e.folder_url || '');
      } catch (_) { /* already exists */ }
    }
    // Restore todos
    for (const t of (data.todos || [])) {
      try {
        stmts.createTodo.run(t.id, t.project_id, t.gantt_entry_id || null, t.title,
          t.description || '', t.status || 'todo', t.assignee_id || null, t.due_date || null, t.position || 0);
      } catch (_) { /* already exists */ }
    }
    // Restore dependencies
    for (const d of (data.dependencies || [])) {
      try { stmts.createDep.run(d.id, d.project_id, d.source_id, d.target_id); } catch (_) {}
    }
    const project = stmts.getProject.get(p.id);
    if (project) broadcastToTeam(project.team_id, { type: 'project_created', project });
    result = { undone: 'delete_project', project };
  } else if (action.action_type === 'delete_team') {
    const t = data.team;
    // Restore team
    try {
      stmts.createTeam.run(t.id, t.name, t.owner_id, t.capacity_hours_month || 160);
    } catch (_) { /* already exists */ }
    // Restore members
    for (const m of (data.members || [])) {
      try { stmts.addTeamMember.run(t.id, m.id, m.role || 'member'); } catch (_) {}
    }
    // Restore each project with its data
    for (const pd of (data.projects || [])) {
      const p = pd.project;
      try {
        stmts.createProject.run(p.id, p.team_id, p.name, p.description || '', p.created_by);
        stmts.restoreProjectMeta.run(p.share_token || null, p.created_at, p.updated_at, p.id);
      } catch (_) { /* already exists */ }
      for (const e of (pd.entries || [])) {
        try {
          stmts.createGantt.run(e.id, e.project_id, e.parent_id, e.title, e.start_date, e.end_date,
            e.hours_estimate, e.color_variation, e.user_id, e.position, e.notes, e.folder_url || '');
        } catch (_) {}
      }
      for (const td of (pd.todos || [])) {
        try {
          stmts.createTodo.run(td.id, td.project_id, td.gantt_entry_id || null, td.title,
            td.description || '', td.status || 'todo', td.assignee_id || null, td.due_date || null, td.position || 0);
        } catch (_) {}
      }
      for (const d of (pd.dependencies || [])) {
        try { stmts.createDep.run(d.id, d.project_id, d.source_id, d.target_id); } catch (_) {}
      }
    }
    const team = stmts.getTeam.get(t.id);
    result = { undone: 'delete_team', team };
  }

  res.json(result);
});

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
// Import backup – restore teams, projects, entries, todos, dependencies
// ---------------------------------------------------------------------------

app.post('/api/backup/import', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const backup = req.body;

  if (!backup || !Array.isArray(backup.teams)) {
    return res.status(400).json({ error: 'Invalid backup format' });
  }

  let teamsImported = 0, projectsImported = 0, entriesImported = 0, todosImported = 0, depsImported = 0;

  const importTx = db.transaction(() => {
    for (const team of backup.teams) {
      // Create or skip team
      const existing = stmts.getTeam.get(team.id);
      if (!existing) {
        try {
          stmts.createTeam.run(team.id, team.name, userId, team.capacity_hours_month || 160);
          stmts.addTeamMember.run(team.id, userId, 'owner');
          teamsImported++;
        } catch (_) { continue; }
      } else {
        // Ensure the current user is a member
        if (!stmts.isMember.get(team.id, userId)) {
          stmts.addTeamMember.run(team.id, userId, 'member');
        }
      }

      // Import projects
      for (const proj of (team.projects || [])) {
        const existingProj = stmts.getProject.get(proj.id);
        if (!existingProj) {
          try {
            stmts.createProject.run(proj.id, team.id, proj.name, proj.description || '', userId);
            projectsImported++;
          } catch (_) { continue; }
        }

        // Import gantt entries
        for (const e of (proj.entries || [])) {
          try {
            stmts.createGantt.run(
              e.id, proj.id, e.parent_id || null, e.title,
              e.start_date, e.end_date, e.hours_estimate || 0,
              e.color_variation || 0, userId, e.position || 0,
              e.notes || '', e.folder_url || ''
            );
            if (e.subtract_hours) {
              stmts.updateGanttSubtractHours.run(e.subtract_hours ? 1 : 0, e.id);
            }
            entriesImported++;
          } catch (_) { /* already exists */ }
        }

        // Import todos
        for (const t of (proj.todos || [])) {
          try {
            stmts.createTodo.run(
              t.id, proj.id, t.gantt_entry_id || null, t.title,
              t.description || '', t.status || 'todo',
              t.assignee_id || null, t.due_date || null, t.position || 0
            );
            todosImported++;
          } catch (_) { /* already exists */ }
        }

        // Import dependencies
        for (const d of (proj.dependencies || [])) {
          try {
            stmts.createDep.run(d.id, proj.id, d.source_id, d.target_id);
            depsImported++;
          } catch (_) { /* already exists */ }
        }
      }
    }
  });

  importTx();

  res.json({
    ok: true,
    imported: { teams: teamsImported, projects: projectsImported, entries: entriesImported, todos: todosImported, dependencies: depsImported }
  });
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
// Admin management
// ---------------------------------------------------------------------------

function isAdmin(userId) {
  const row = stmts.getSetting.get('admin_ids');
  if (!row) return false;
  try { return JSON.parse(row.value).includes(userId); } catch { return false; }
}

function getAdminIds() {
  const row = stmts.getSetting.get('admin_ids');
  if (!row) return [];
  try { return JSON.parse(row.value); } catch { return []; }
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!isAdmin(req.session.userId)) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// GET /api/admin/status – anyone can check if an admin exists and whether they are admin
app.get('/api/admin/status', requireAuth, (req, res) => {
  const ids = getAdminIds();
  res.json({ hasAdmin: ids.length > 0, isAdmin: ids.includes(req.session.userId) });
});

// POST /api/admin/set – become admin (only when no admin exists) or add/remove admins (admin only)
app.post('/api/admin/set', requireAuth, (req, res) => {
  const { userId: targetId, action } = req.body;  // action: 'add' | 'remove'
  const ids = getAdminIds();

  // If no admin exists yet, allow the current user to claim admin
  if (ids.length === 0) {
    stmts.setSetting.run('admin_ids', JSON.stringify([req.session.userId]));
    return res.json({ ok: true, isAdmin: true });
  }

  // Only existing admins can modify admin list
  if (!ids.includes(req.session.userId)) {
    return res.status(403).json({ error: 'Only an admin can manage admins' });
  }

  if (action === 'add' && targetId) {
    if (!ids.includes(targetId)) ids.push(targetId);
    stmts.setSetting.run('admin_ids', JSON.stringify(ids));
    return res.json({ ok: true });
  }

  if (action === 'remove' && targetId) {
    const updated = ids.filter(id => id !== targetId);
    if (updated.length === 0) return res.status(400).json({ error: 'Cannot remove the last admin' });
    stmts.setSetting.run('admin_ids', JSON.stringify(updated));
    return res.json({ ok: true });
  }

  res.status(400).json({ error: 'Invalid action' });
});

// ---------------------------------------------------------------------------
// Update helpers & routes
// ---------------------------------------------------------------------------

const multerImported = (() => { try { return require('multer'); } catch { return null; } })();

/**
 * Apply a ZIP update from a file on disk.
 * Extracts the public-folder contents, protects api/data/, and cache-busts HTML.
 * @param {string} zipPath  Absolute path to the ZIP file
 * @returns {{ ok:boolean, version:string, extracted:number, skipped:number, message:string }}
 */
function applyZipUpdate(zipPath) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
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
    if (!resolvedTarget.startsWith(resolvedPublic + path.sep)) {
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

  // ---- Cache-bust: update ?v= query strings in HTML files ----
  try {
    const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
    for (const htmlFile of htmlFiles) {
      const htmlPath = path.join(publicDir, htmlFile);
      let html = fs.readFileSync(htmlPath, 'utf8');
      const updated = html.replace(
        /((?:href|src)\s*=\s*["'])([^"']+\.(css|js))(\?v=[^"']*)?(['"])/gi,
        (match, prefix, url, _ext, _oldVer, suffix) => {
          if (url.includes('://')) return match;
          return prefix + url + '?v=' + newVersion + suffix;
        }
      );
      if (updated !== html) fs.writeFileSync(htmlPath, updated, 'utf8');
    }
  } catch (_) {
    // Cache-busting is non-critical; the update itself already succeeded
  }

  return {
    ok: true,
    version: newVersion,
    extracted,
    skipped,
    message: `Update applied successfully. ${extracted} files updated, ${skipped} protected files skipped.`
  };
}

// Upload a ZIP to update the application
app.post('/api/update', requireAdmin, (req, res) => {
  if (!multerImported) {
    return res.status(501).json({
      error: 'File upload is not supported on this Node.js deployment. ' +
             'Install multer (npm install multer) or use the PHP deployment for in-app updates.'
    });
  }

  const uploadDir = path.join(DATA_DIR, 'tmp_uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multerImported({ dest: uploadDir }).single('zipfile');
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try { require('adm-zip'); } catch {
      fs.unlinkSync(req.file.path);
      return res.status(501).json({
        error: 'ZIP handling not available. Install adm-zip (npm install adm-zip) for Node.js updates.'
      });
    }

    try {
      const result = applyZipUpdate(req.file.path);
      fs.unlinkSync(req.file.path);
      res.json(result);
    } catch (e) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: 'Update failed: ' + e.message });
    }
  });
});

// ---------------------------------------------------------------------------
// GitHub releases – list available versions & update from GitHub
// ---------------------------------------------------------------------------

app.get('/api/github-releases', (_req, res) => {
  const versionFile = path.join(__dirname, 'public', 'version.json');
  let repository = '';
  try {
    const vData = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    repository = vData.repository || '';
  } catch { /* ignore */ }

  if (!repository) {
    return res.status(400).json({ error: 'No repository configured in version.json' });
  }

  const apiUrl = `https://api.github.com/repos/${repository}/releases`;
  const options = {
    headers: { 'User-Agent': 'OnlineProjectPlanner', 'Accept': 'application/vnd.github+json' }
  };

  https.get(apiUrl, options, (ghRes) => {
    let body = '';
    ghRes.on('data', (chunk) => { body += chunk; });
    ghRes.on('end', () => {
      if (ghRes.statusCode !== 200) {
        return res.status(502).json({ error: 'GitHub API error: ' + ghRes.statusCode });
      }
      try {
        const releases = JSON.parse(body);
        const result = releases.map(r => ({
          tag: r.tag_name,
          name: r.name || r.tag_name,
          published: r.published_at,
          body: r.body || '',
          assets: (r.assets || []).map(a => ({
            name: a.name,
            size: a.size,
            download_url: a.browser_download_url
          }))
        }));
        res.json(result);
      } catch (e) {
        res.status(502).json({ error: 'Failed to parse GitHub response' });
      }
    });
  }).on('error', (e) => {
    res.status(502).json({ error: 'Failed to reach GitHub: ' + e.message });
  });
});

app.post('/api/update-from-github', requireAdmin, (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing download URL' });
  }

  // Validate URL is from GitHub releases
  if (!url.startsWith('https://github.com/')) {
    return res.status(400).json({ error: 'URL must be a GitHub release asset' });
  }

  try { require('adm-zip'); } catch {
    return res.status(501).json({
      error: 'ZIP handling not available. Install adm-zip (npm install adm-zip) for Node.js updates.'
    });
  }

  const uploadDir = path.join(DATA_DIR, 'tmp_uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const tmpFile = path.join(uploadDir, 'github_update_' + Date.now() + '.zip');

  // Download the ZIP from GitHub (follows redirects)
  const cleanup = () => { try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {} };
  const download = (downloadUrl, redirects) => {
    if (redirects > 5) {
      cleanup();
      return res.status(502).json({ error: 'Too many redirects' });
    }

    let parsedUrl;
    try { parsedUrl = new URL(downloadUrl); } catch {
      cleanup();
      return res.status(502).json({ error: 'Invalid redirect URL' });
    }
    const proto = parsedUrl.protocol === 'https:' ? https : http;
    proto.get(downloadUrl, { headers: { 'User-Agent': 'OnlineProjectPlanner' } }, (ghRes) => {
      // Follow redirects
      if (ghRes.statusCode >= 300 && ghRes.statusCode < 400 && ghRes.headers.location) {
        ghRes.resume();
        return download(ghRes.headers.location, redirects + 1);
      }

      if (ghRes.statusCode !== 200) {
        ghRes.resume();
        return res.status(502).json({ error: 'Download failed: HTTP ' + ghRes.statusCode });
      }

      const fileStream = fs.createWriteStream(tmpFile);
      ghRes.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        try {
          const result = applyZipUpdate(tmpFile);
          fs.unlinkSync(tmpFile);
          res.json(result);
        } catch (e) {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
          res.status(500).json({ error: 'Update failed: ' + e.message });
        }
      });
      fileStream.on('error', (e) => {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        res.status(500).json({ error: 'File write failed: ' + e.message });
      });
    }).on('error', (e) => {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      res.status(502).json({ error: 'Download failed: ' + e.message });
    });
  };

  download(url, 0);
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
