<?php
// =========================================================================
// OnlineProjectPlanner – PHP Database Setup
// =========================================================================

$DATA_DIR = __DIR__ . '/data';
if (!is_dir($DATA_DIR)) {
    mkdir($DATA_DIR, 0755, true);
}

if (!extension_loaded('pdo_sqlite')) {
    http_response_code(503);
    echo json_encode(['error' => 'SQLite PDO extension is not available on this server. Please enable pdo_sqlite in your PHP configuration.']);
    exit;
}

try {
    $db = new PDO('sqlite:' . $DATA_DIR . '/planner.db');
} catch (Exception $e) {
    http_response_code(503);
    echo json_encode(['error' => 'Cannot open database: ' . $e->getMessage()]);
    exit;
}

$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
$db->exec('PRAGMA journal_mode = WAL');
$db->exec('PRAGMA foreign_keys = ON');

// -------------------------------------------------------------------------
// Schema
// -------------------------------------------------------------------------

$db->exec("
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
  share_token TEXT,
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
  row_label TEXT NOT NULL DEFAULT '',
  row_height INTEGER NOT NULL DEFAULT 40,
  row_only INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  hours_estimate REAL NOT NULL DEFAULT 0,
  hours_set INTEGER NOT NULL DEFAULT 0,
  color_variation INTEGER NOT NULL DEFAULT 0,
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  folder_url TEXT NOT NULL DEFAULT '',
  subtract_hours INTEGER NOT NULL DEFAULT 0,
  same_row TEXT DEFAULT NULL,
  dates_locked INTEGER NOT NULL DEFAULT 0,
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
");

// Migration: add subtract_hours to existing databases
try {
    $db->exec("ALTER TABLE gantt_entries ADD COLUMN subtract_hours INTEGER NOT NULL DEFAULT 0");
} catch (Exception $e) { /* column already exists – ignore */ }

// Migration: add same_row to gantt_entries (allows multiple tasks on the same visual row)
try {
    $db->exec("ALTER TABLE gantt_entries ADD COLUMN same_row TEXT DEFAULT NULL");
} catch (Exception $e) { /* column already exists – ignore */ }

// Migration: add editable row label (separate from task title)
try {
    $db->exec("ALTER TABLE gantt_entries ADD COLUMN row_label TEXT NOT NULL DEFAULT ''");
} catch (Exception $e) { /* column already exists – ignore */ }

// Migration: add per-row height
try {
    $db->exec("ALTER TABLE gantt_entries ADD COLUMN row_height INTEGER NOT NULL DEFAULT 40");
} catch (Exception $e) { /* column already exists – ignore */ }

// Migration: add row-only flag (category rows without visible bars)
try {
    $db->exec("ALTER TABLE gantt_entries ADD COLUMN row_only INTEGER NOT NULL DEFAULT 0");
} catch (Exception $e) { /* column already exists – ignore */ }

// Migration: track whether hours_estimate was explicitly set (1) or left blank (0).
// Distinguishes an intentional 0-hour budget from "no budget entered".
try {
    $db->exec("ALTER TABLE gantt_entries ADD COLUMN hours_set INTEGER NOT NULL DEFAULT 0");
} catch (Exception $e) { /* column already exists – ignore */ }

// Migration: add parent_id to todo_items (sub-task nesting)
try {
    $db->exec("ALTER TABLE todo_items ADD COLUMN parent_id TEXT DEFAULT NULL");
} catch (Exception $e) { /* column already exists – ignore */ }

// Migration: add priority to todo_items (high / medium / low)
try {
    $db->exec("ALTER TABLE todo_items ADD COLUMN priority TEXT DEFAULT NULL");
} catch (Exception $e) { /* column already exists – ignore */ }

// Migration: add label to todo_items (free-text category)
try {
    $db->exec("ALTER TABLE todo_items ADD COLUMN label TEXT DEFAULT NULL");
} catch (Exception $e) { /* column already exists – ignore */ }

// App settings table (admin user IDs etc.)
$db->exec("
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
");

// Milestone / deadline table
$db->exec("
CREATE TABLE IF NOT EXISTS gantt_milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  date TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#e53935',
  scope_parent_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
");

// Migration: add scoped parent targets for milestones
try {
    $s = $db->query("PRAGMA table_info(gantt_milestones)");
    $cols = $s ? $s->fetchAll(PDO::FETCH_ASSOC) : [];
    $hasScopeParentIds = false;
    foreach ($cols as $col) {
        if (($col['name'] ?? '') === 'scope_parent_ids') {
            $hasScopeParentIds = true;
            break;
        }
    }
    if (!$hasScopeParentIds) {
        $db->exec("ALTER TABLE gantt_milestones ADD COLUMN scope_parent_ids TEXT NOT NULL DEFAULT '[]'");
    }
} catch (Exception $e) { /* ignore */ }

// Migration: add dates_locked to gantt_entries (prevents drag/resize when set)
try {
    $s = $db->query("PRAGMA table_info(gantt_entries)");
    $cols = $s ? $s->fetchAll(PDO::FETCH_ASSOC) : [];
    $hasDatesLocked = false;
    foreach ($cols as $col) {
        if (($col['name'] ?? '') === 'dates_locked') {
            $hasDatesLocked = true;
            break;
        }
    }
    if (!$hasDatesLocked) {
        $db->exec("ALTER TABLE gantt_entries ADD COLUMN dates_locked INTEGER NOT NULL DEFAULT 0");
    }
} catch (Exception $e) { /* ignore */ }

// Global undo history (not project-scoped; survives team/project deletion)
$db->exec("
CREATE TABLE IF NOT EXISTS global_undo_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
");

// Redo history (project-scoped; mirrors undo_history structure)
$db->exec("
CREATE TABLE IF NOT EXISTS redo_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
");

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function uuid_v4() {
    $data = random_bytes(16);
    $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
    $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

function now_ms() {
    return (int)(microtime(true) * 1000);
}

function sanitize_user($u) {
    return [
        'id'         => $u['id'],
        'username'   => $u['username'],
        'email'      => $u['email'],
        'base_color' => $u['base_color'],
        'created_at' => (int)$u['created_at'],
    ];
}

function is_member($db, $teamId, $userId) {
    $s = $db->prepare('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?');
    $s->execute([$teamId, $userId]);
    return (bool)$s->fetch();
}

function project_team_id($db, $projectId) {
    $s = $db->prepare('SELECT team_id FROM projects WHERE id=?');
    $s->execute([$projectId]);
    $row = $s->fetch();
    return $row ? $row['team_id'] : null;
}

function can_access_project($db, $projectId, $userId) {
    $teamId = project_team_id($db, $projectId);
    if (!$teamId) return false;
    return is_member($db, $teamId, $userId);
}
