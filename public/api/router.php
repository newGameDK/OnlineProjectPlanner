<?php
// =========================================================================
// OnlineProjectPlanner – PHP API Router
// =========================================================================
// This file handles all /api/* requests when hosted on PHP shared hosting.
// It is a direct port of the Node.js server.js endpoints.
// =========================================================================

// Always send JSON content-type first so error responses are parseable.
header('Content-Type: application/json; charset=utf-8');

// -------------------------------------------------------------------------
// Request parsing (done early so health/diag can run before DB init)
// -------------------------------------------------------------------------

$route  = isset($_GET['_route']) ? trim($_GET['_route'], '/') : '';
$method = $_SERVER['REQUEST_METHOD'];

// Handle OPTIONS preflight for CORS
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// =========================================================================
// HEALTH CHECK  (runs before DB init – always available)
// =========================================================================
if ($route === 'health' && $method === 'GET') {
    echo json_encode(['ok' => true]);
    exit;
}

// =========================================================================
// DIAGNOSTICS  (runs before DB init – helps debug hosting issues)
// =========================================================================
if ($route === 'diag' && $method === 'GET') {
    $dataDir  = __DIR__ . '/data';
    $dbFile   = $dataDir . '/planner.db';
    echo json_encode([
        'php_version'       => PHP_VERSION,
        'pdo_available'     => extension_loaded('pdo'),
        'pdo_sqlite'        => extension_loaded('pdo_sqlite'),
        'data_dir_exists'   => is_dir($dataDir),
        'data_dir_writable' => is_writable($dataDir),
        'db_file_exists'    => file_exists($dbFile),
        'db_file_writable'  => file_exists($dbFile) && is_writable($dbFile),
    ]);
    exit;
}

// =========================================================================
// DATABASE INIT  (required for all other routes)
// =========================================================================

require_once __DIR__ . '/db.php';

// -------------------------------------------------------------------------
// Session configuration
// -------------------------------------------------------------------------

session_set_cookie_params([
    'lifetime' => 0,
    'path'     => '/',
    'secure'   => (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();

// Parse JSON body
$body = [];
if ($method === 'POST' || $method === 'PUT' || $method === 'PATCH') {
    $raw = file_get_contents('php://input');
    if ($raw) {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) $body = $decoded;
    }
}

// -------------------------------------------------------------------------
// Response helpers
// -------------------------------------------------------------------------

function json_out($data, $status = 200) {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function require_auth() {
    if (empty($_SESSION['userId'])) {
        json_out(['error' => 'Not authenticated'], 401);
    }
    return $_SESSION['userId'];
}

// -------------------------------------------------------------------------
// Route matching
// -------------------------------------------------------------------------

$parts = explode('/', $route);
$seg1 = $parts[0] ?? '';
$seg2 = $parts[1] ?? '';
$seg3 = $parts[2] ?? '';
$seg4 = $parts[3] ?? '';

$BASE_COLORS = [
    '#2196F3','#4CAF50','#FF9800','#9C27B0','#F44336',
    '#009688','#E91E63','#3F51B5','#795548','#00BCD4'
];

// =========================================================================
// AUTH ROUTES
// =========================================================================

if ($seg1 === 'auth') {

    // POST auth/register
    if ($seg2 === 'register' && $method === 'POST') {
        $username = trim($body['username'] ?? '');
        $email    = trim($body['email'] ?? '');
        $password = $body['password'] ?? '';

        if (!$username || !$email || !$password) json_out(['error' => 'Missing fields'], 400);
        if (strlen($password) < 6) json_out(['error' => 'Password must be at least 6 characters'], 400);

        $s = $db->prepare('SELECT id FROM users WHERE username=?');
        $s->execute([$username]);
        if ($s->fetch()) json_out(['error' => 'Username already taken'], 409);

        $s = $db->prepare('SELECT id FROM users WHERE email=?');
        $s->execute([$email]);
        if ($s->fetch()) json_out(['error' => 'Email already registered'], 409);

        $count = $db->query('SELECT COUNT(*) as c FROM users')->fetch()['c'];
        $baseColor = $BASE_COLORS[$count % count($BASE_COLORS)];

        $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);
        $id = uuid_v4();
        $s = $db->prepare('INSERT INTO users (id,username,email,password_hash,base_color) VALUES (?,?,?,?,?)');
        $s->execute([$id, $username, $email, $hash, $baseColor]);

        $_SESSION['userId'] = $id;
        $s = $db->prepare('SELECT * FROM users WHERE id=?');
        $s->execute([$id]);
        json_out(['user' => sanitize_user($s->fetch())]);
    }

    // POST auth/login
    if ($seg2 === 'login' && $method === 'POST') {
        $username = trim($body['username'] ?? '');
        $password = $body['password'] ?? '';
        if (!$username || !$password) json_out(['error' => 'Missing fields'], 400);

        $s = $db->prepare('SELECT * FROM users WHERE username=?');
        $s->execute([$username]);
        $user = $s->fetch();
        if (!$user) json_out(['error' => 'Invalid credentials'], 401);

        if (!password_verify($password, $user['password_hash'])) {
            json_out(['error' => 'Invalid credentials'], 401);
        }

        $_SESSION['userId'] = $user['id'];
        json_out(['user' => sanitize_user($user)]);
    }

    // POST auth/logout
    if ($seg2 === 'logout' && $method === 'POST') {
        session_destroy();
        json_out(['ok' => true]);
    }

    // GET auth/me
    if ($seg2 === 'me' && $method === 'GET') {
        $userId = require_auth();
        $s = $db->prepare('SELECT * FROM users WHERE id=?');
        $s->execute([$userId]);
        $user = $s->fetch();
        if (!$user) json_out(['error' => 'User not found'], 404);
        json_out(['user' => sanitize_user($user)]);
    }

    // PUT auth/me
    if ($seg2 === 'me' && $method === 'PUT') {
        $userId = require_auth();
        if (!empty($body['base_color'])) {
            $s = $db->prepare('UPDATE users SET base_color=? WHERE id=?');
            $s->execute([$body['base_color'], $userId]);
        }
        $s = $db->prepare('SELECT * FROM users WHERE id=?');
        $s->execute([$userId]);
        json_out(['user' => sanitize_user($s->fetch())]);
    }
}

// =========================================================================
// TEAM ROUTES
// =========================================================================

if ($seg1 === 'teams') {

    // POST teams/join/:token
    if ($seg2 === 'join' && $seg3 && $method === 'POST') {
        $userId = require_auth();
        $token = $seg3;
        $s = $db->prepare('SELECT * FROM invitations WHERE token=?');
        $s->execute([$token]);
        $inv = $s->fetch();
        if (!$inv) json_out(['error' => 'Invalid token'], 404);
        if ($inv['expires_at'] < now_ms()) json_out(['error' => 'Token expired'], 410);

        $s = $db->prepare('INSERT OR IGNORE INTO team_members (team_id,user_id,role) VALUES (?,?,?)');
        $s->execute([$inv['team_id'], $userId, 'member']);

        $s = $db->prepare('DELETE FROM invitations WHERE id=?');
        $s->execute([$inv['id']]);

        $s = $db->prepare('SELECT * FROM teams WHERE id=?');
        $s->execute([$inv['team_id']]);
        json_out(['team' => $s->fetch()]);
    }

    // GET teams (list)
    if ($seg2 === '' && $method === 'GET') {
        $userId = require_auth();
        $s = $db->prepare('
            SELECT t.*, tm.role FROM teams t
            JOIN team_members tm ON t.id=tm.team_id
            WHERE tm.user_id=?
            ORDER BY t.created_at ASC
        ');
        $s->execute([$userId]);
        json_out(['teams' => $s->fetchAll()]);
    }

    // POST teams (create)
    if ($seg2 === '' && $method === 'POST') {
        $userId = require_auth();
        $name = trim($body['name'] ?? '');
        if (!$name) json_out(['error' => 'Name required'], 400);
        $cap = (int)($body['capacity_hours_month'] ?? 160) ?: 160;

        $id = uuid_v4();
        $s = $db->prepare('INSERT INTO teams (id,name,owner_id,capacity_hours_month) VALUES (?,?,?,?)');
        $s->execute([$id, $name, $userId, $cap]);

        $s = $db->prepare('INSERT OR IGNORE INTO team_members (team_id,user_id,role) VALUES (?,?,?)');
        $s->execute([$id, $userId, 'owner']);

        $s = $db->prepare('SELECT * FROM teams WHERE id=?');
        $s->execute([$id]);
        json_out(['team' => $s->fetch()]);
    }

    // Routes with team ID: teams/:id, teams/:id/invite, teams/:id/members/:userId
    if ($seg2 && $seg2 !== 'join') {
        $teamId = $seg2;

        // POST teams/:id/invite
        if ($seg3 === 'invite' && $method === 'POST') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM teams WHERE id=?');
            $s->execute([$teamId]);
            $team = $s->fetch();
            if (!$team) json_out(['error' => 'Team not found'], 404);
            if (!is_member($db, $teamId, $userId)) json_out(['error' => 'Forbidden'], 403);

            $email = trim($body['email'] ?? '');
            if (!$email) json_out(['error' => 'Email required'], 400);

            // Check if user with that email exists; if so, add directly
            $s = $db->prepare('SELECT * FROM users WHERE email=?');
            $s->execute([$email]);
            $targetUser = $s->fetch();
            if ($targetUser) {
                $s = $db->prepare('INSERT OR IGNORE INTO team_members (team_id,user_id,role) VALUES (?,?,?)');
                $s->execute([$teamId, $targetUser['id'], 'member']);
                json_out(['added' => true, 'message' => $targetUser['username'] . ' added to team']);
            }

            $token = uuid_v4();
            $expires = now_ms() + 7 * 24 * 60 * 60 * 1000;
            $s = $db->prepare('INSERT INTO invitations (id,team_id,email,token,expires_at) VALUES (?,?,?,?,?)');
            $s->execute([uuid_v4(), $teamId, $email, $token, $expires]);
            json_out(['added' => false, 'token' => $token, 'message' => 'Invitation created. Share the token with the user.']);
        }

        // DELETE teams/:id/members/:userId
        if ($seg3 === 'members' && $seg4 && $method === 'DELETE') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM teams WHERE id=?');
            $s->execute([$teamId]);
            $team = $s->fetch();
            if (!$team) json_out(['error' => 'Team not found'], 404);
            if ($team['owner_id'] !== $userId && $seg4 !== $userId) {
                json_out(['error' => 'Forbidden'], 403);
            }
            $s = $db->prepare('DELETE FROM team_members WHERE team_id=? AND user_id=?');
            $s->execute([$teamId, $seg4]);
            json_out(['ok' => true]);
        }

        // GET teams/:id
        if ($seg3 === '' && $method === 'GET') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM teams WHERE id=?');
            $s->execute([$teamId]);
            $team = $s->fetch();
            if (!$team) json_out(['error' => 'Team not found'], 404);
            if (!is_member($db, $teamId, $userId)) json_out(['error' => 'Forbidden'], 403);

            $s = $db->prepare('
                SELECT u.id, u.username, u.email, u.base_color, tm.role, tm.joined_at
                FROM team_members tm JOIN users u ON tm.user_id=u.id
                WHERE tm.team_id=?
            ');
            $s->execute([$teamId]);
            json_out(['team' => $team, 'members' => $s->fetchAll()]);
        }

        // PUT teams/:id
        if ($seg3 === '' && $method === 'PUT') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM teams WHERE id=?');
            $s->execute([$teamId]);
            $team = $s->fetch();
            if (!$team) json_out(['error' => 'Team not found'], 404);
            if ($team['owner_id'] !== $userId) json_out(['error' => 'Only owner can update team'], 403);

            if (!empty($body['capacity_hours_month'])) {
                $s = $db->prepare('UPDATE teams SET capacity_hours_month=? WHERE id=?');
                $s->execute([(int)$body['capacity_hours_month'], $teamId]);
            }
            $s = $db->prepare('SELECT * FROM teams WHERE id=?');
            $s->execute([$teamId]);
            json_out(['team' => $s->fetch()]);
        }
    }
}

// =========================================================================
// PROJECT ROUTES
// =========================================================================

if ($seg1 === 'projects') {

    // GET projects?team_id=
    if ($seg2 === '' && $method === 'GET') {
        $userId = require_auth();
        $team_id = $_GET['team_id'] ?? '';
        if (!$team_id) json_out(['error' => 'team_id required'], 400);
        if (!is_member($db, $team_id, $userId)) json_out(['error' => 'Forbidden'], 403);

        $s = $db->prepare('SELECT * FROM projects WHERE team_id=? ORDER BY created_at ASC');
        $s->execute([$team_id]);
        json_out(['projects' => $s->fetchAll()]);
    }

    // POST projects
    if ($seg2 === '' && $method === 'POST') {
        $userId = require_auth();
        $team_id = $body['team_id'] ?? '';
        $name    = trim($body['name'] ?? '');
        $desc    = $body['description'] ?? '';
        if (!$team_id || !$name) json_out(['error' => 'team_id and name required'], 400);
        if (!is_member($db, $team_id, $userId)) json_out(['error' => 'Forbidden'], 403);

        $id = uuid_v4();
        $s = $db->prepare('INSERT INTO projects (id,team_id,name,description,created_by) VALUES (?,?,?,?,?)');
        $s->execute([$id, $team_id, $name, $desc, $userId]);

        $s = $db->prepare('SELECT * FROM projects WHERE id=?');
        $s->execute([$id]);
        json_out(['project' => $s->fetch()]);
    }

    // Routes with project ID
    if ($seg2 && $seg2 !== '') {
        $projectId = $seg2;

        // POST projects/:id/share
        if ($seg3 === 'share' && $method === 'POST') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM projects WHERE id=?');
            $s->execute([$projectId]);
            $project = $s->fetch();
            if (!$project) json_out(['error' => 'Not found'], 404);
            if (!is_member($db, $project['team_id'], $userId)) json_out(['error' => 'Forbidden'], 403);

            $token = uuid_v4();
            $s = $db->prepare('UPDATE projects SET share_token=? WHERE id=?');
            $s->execute([$token, $projectId]);
            json_out(['token' => $token]);
        }

        // DELETE projects/:id/share
        if ($seg3 === 'share' && $method === 'DELETE') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM projects WHERE id=?');
            $s->execute([$projectId]);
            $project = $s->fetch();
            if (!$project) json_out(['error' => 'Not found'], 404);
            if (!is_member($db, $project['team_id'], $userId)) json_out(['error' => 'Forbidden'], 403);

            $s = $db->prepare('UPDATE projects SET share_token=NULL WHERE id=?');
            $s->execute([$projectId]);
            json_out(['ok' => true]);
        }

        // PUT projects/:id
        if ($seg3 === '' && $method === 'PUT') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM projects WHERE id=?');
            $s->execute([$projectId]);
            $project = $s->fetch();
            if (!$project) json_out(['error' => 'Not found'], 404);
            if (!is_member($db, $project['team_id'], $userId)) json_out(['error' => 'Forbidden'], 403);

            $name = $body['name'] ?? $project['name'];
            $desc = $body['description'] ?? $project['description'];
            $s = $db->prepare('UPDATE projects SET name=?,description=?,updated_at=? WHERE id=?');
            $s->execute([$name, $desc, now_ms(), $projectId]);

            $s = $db->prepare('SELECT * FROM projects WHERE id=?');
            $s->execute([$projectId]);
            json_out(['project' => $s->fetch()]);
        }

        // DELETE projects/:id
        if ($seg3 === '' && $method === 'DELETE') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM projects WHERE id=?');
            $s->execute([$projectId]);
            $project = $s->fetch();
            if (!$project) json_out(['error' => 'Not found'], 404);
            if (!is_member($db, $project['team_id'], $userId)) json_out(['error' => 'Forbidden'], 403);

            $s = $db->prepare('DELETE FROM projects WHERE id=?');
            $s->execute([$projectId]);
            json_out(['ok' => true]);
        }
    }
}

// =========================================================================
// SHARE ROUTE (public, no auth)
// =========================================================================

if ($seg1 === 'share' && $seg2 && $method === 'GET') {
    $token = $seg2;
    $s = $db->prepare('SELECT * FROM projects WHERE share_token=?');
    $s->execute([$token]);
    $project = $s->fetch();
    if (!$project) json_out(['error' => 'Invalid or expired share link'], 404);

    $s = $db->prepare('SELECT * FROM gantt_entries WHERE project_id=? ORDER BY position ASC, created_at ASC');
    $s->execute([$project['id']]);
    $entries = $s->fetchAll();

    $s = $db->prepare('SELECT * FROM todo_items WHERE project_id=? ORDER BY position ASC, created_at ASC');
    $s->execute([$project['id']]);
    $todos = $s->fetchAll();

    $s = $db->prepare('SELECT * FROM gantt_dependencies WHERE project_id=?');
    $s->execute([$project['id']]);
    $deps = $s->fetchAll();

    $s = $db->prepare('
        SELECT u.id, u.username, u.base_color
        FROM team_members tm JOIN users u ON tm.user_id=u.id
        WHERE tm.team_id=?
    ');
    $s->execute([$project['team_id']]);
    $members = $s->fetchAll();

    json_out([
        'project'      => ['id' => $project['id'], 'name' => $project['name'], 'description' => $project['description']],
        'entries'       => $entries,
        'todos'         => $todos,
        'dependencies'  => $deps,
        'members'       => $members,
    ]);
}

// =========================================================================
// GANTT ROUTES
// =========================================================================

if ($seg1 === 'gantt') {

    // POST gantt (create)
    if ($seg2 === '' && $method === 'POST') {
        $userId = require_auth();
        $project_id = $body['project_id'] ?? '';
        $title      = $body['title'] ?? '';
        $start_date = $body['start_date'] ?? '';
        $end_date   = $body['end_date'] ?? '';
        if (!$project_id || !$title || !$start_date || !$end_date) json_out(['error' => 'Missing required fields'], 400);
        if (!can_access_project($db, $project_id, $userId)) json_out(['error' => 'Forbidden'], 403);

        $id = uuid_v4();
        $s = $db->prepare('INSERT INTO gantt_entries (id,project_id,parent_id,title,start_date,end_date,hours_estimate,color_variation,user_id,position,notes,folder_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
        $s->execute([
            $id, $project_id, $body['parent_id'] ?? null, $title, $start_date, $end_date,
            $body['hours_estimate'] ?? 0, $body['color_variation'] ?? 0, $userId,
            $body['position'] ?? 0, $body['notes'] ?? '', $body['folder_url'] ?? ''
        ]);

        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$id]);
        $entry = $s->fetch();

        // Save undo
        $s = $db->prepare('INSERT INTO undo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
        $s->execute([uuid_v4(), $project_id, $userId, 'create_gantt', json_encode(['entry' => $entry])]);

        json_out(['entry' => $entry]);
    }

    // Routes with gantt ID or project ID
    if ($seg2) {
        $ganttId = $seg2;

        // GET gantt/:projectId (get all entries for project)
        if ($method === 'GET') {
            $userId = require_auth();
            $projectId = $ganttId;
            if (!can_access_project($db, $projectId, $userId)) json_out(['error' => 'Forbidden'], 403);

            $s = $db->prepare('SELECT * FROM gantt_entries WHERE project_id=? ORDER BY position ASC, created_at ASC');
            $s->execute([$projectId]);
            json_out(['entries' => $s->fetchAll()]);
        }

        // PUT gantt/:id
        if ($method === 'PUT') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
            $s->execute([$ganttId]);
            $existing = $s->fetch();
            if (!$existing) json_out(['error' => 'Not found'], 404);
            if (!can_access_project($db, $existing['project_id'], $userId)) json_out(['error' => 'Forbidden'], 403);

            // Save undo
            $s = $db->prepare('INSERT INTO undo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
            $s->execute([uuid_v4(), $existing['project_id'], $userId, 'update_gantt', json_encode(['entry' => $existing])]);

            $s = $db->prepare('UPDATE gantt_entries SET title=?,start_date=?,end_date=?,hours_estimate=?,color_variation=?,position=?,notes=?,folder_url=?,updated_at=? WHERE id=?');
            $s->execute([
                $body['title'] ?? $existing['title'],
                $body['start_date'] ?? $existing['start_date'],
                $body['end_date'] ?? $existing['end_date'],
                $body['hours_estimate'] ?? $existing['hours_estimate'],
                $body['color_variation'] ?? $existing['color_variation'],
                $body['position'] ?? $existing['position'],
                $body['notes'] ?? $existing['notes'],
                array_key_exists('folder_url', $body) ? $body['folder_url'] : $existing['folder_url'],
                now_ms(),
                $ganttId
            ]);

            $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
            $s->execute([$ganttId]);
            json_out(['entry' => $s->fetch()]);
        }

        // DELETE gantt/:id
        if ($method === 'DELETE') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
            $s->execute([$ganttId]);
            $existing = $s->fetch();
            if (!$existing) json_out(['error' => 'Not found'], 404);
            if (!can_access_project($db, $existing['project_id'], $userId)) json_out(['error' => 'Forbidden'], 403);

            // Save undo
            $s = $db->prepare('INSERT INTO undo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
            $s->execute([uuid_v4(), $existing['project_id'], $userId, 'delete_gantt', json_encode(['entry' => $existing])]);

            $s = $db->prepare('DELETE FROM gantt_entries WHERE id=?');
            $s->execute([$ganttId]);
            json_out(['ok' => true]);
        }
    }
}

// =========================================================================
// SYNC ROUTE
// =========================================================================

if ($seg1 === 'sync' && $seg2 && $method === 'GET') {
    $userId = require_auth();
    $projectId = $seg2;
    if (!can_access_project($db, $projectId, $userId)) json_out(['error' => 'Forbidden'], 403);

    $since = (int)($_GET['since'] ?? 0);

    $s = $db->prepare('SELECT * FROM gantt_entries WHERE project_id=? AND updated_at>? ORDER BY updated_at ASC');
    $s->execute([$projectId, $since]);
    $gantt = $s->fetchAll();

    $s = $db->prepare('SELECT * FROM todo_items WHERE project_id=? AND updated_at>? ORDER BY updated_at ASC');
    $s->execute([$projectId, $since]);
    $todos = $s->fetchAll();

    $s = $db->prepare('SELECT * FROM gantt_dependencies WHERE project_id=? AND created_at>?');
    $s->execute([$projectId, $since]);
    $deps = $s->fetchAll();

    json_out(['gantt' => $gantt, 'todos' => $todos, 'dependencies' => $deps, 'server_time' => now_ms()]);
}

// =========================================================================
// DEPENDENCY ROUTES
// =========================================================================

if ($seg1 === 'dependencies') {

    // POST dependencies (create)
    if ($seg2 === '' && $method === 'POST') {
        $userId = require_auth();
        $project_id = $body['project_id'] ?? '';
        $source_id  = $body['source_id'] ?? '';
        $target_id  = $body['target_id'] ?? '';
        if (!$project_id || !$source_id || !$target_id) json_out(['error' => 'Missing fields'], 400);
        if (!can_access_project($db, $project_id, $userId)) json_out(['error' => 'Forbidden'], 403);
        if ($source_id === $target_id) json_out(['error' => 'Cannot depend on itself'], 400);

        $id = uuid_v4();
        $s = $db->prepare('INSERT OR IGNORE INTO gantt_dependencies (id,project_id,source_id,target_id) VALUES (?,?,?,?)');
        $s->execute([$id, $project_id, $source_id, $target_id]);

        $s = $db->prepare('SELECT * FROM gantt_dependencies WHERE id=?');
        $s->execute([$id]);
        json_out(['dep' => $s->fetch()]);
    }

    if ($seg2) {
        $depId = $seg2;

        // GET dependencies/:projectId
        if ($method === 'GET') {
            $userId = require_auth();
            $projectId = $depId;
            if (!can_access_project($db, $projectId, $userId)) json_out(['error' => 'Forbidden'], 403);

            $s = $db->prepare('SELECT * FROM gantt_dependencies WHERE project_id=?');
            $s->execute([$projectId]);
            json_out(['dependencies' => $s->fetchAll()]);
        }

        // DELETE dependencies/:id
        if ($method === 'DELETE') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM gantt_dependencies WHERE id=?');
            $s->execute([$depId]);
            $dep = $s->fetch();
            if (!$dep) json_out(['error' => 'Not found'], 404);
            if (!can_access_project($db, $dep['project_id'], $userId)) json_out(['error' => 'Forbidden'], 403);

            $s = $db->prepare('DELETE FROM gantt_dependencies WHERE id=?');
            $s->execute([$depId]);
            json_out(['ok' => true]);
        }
    }
}

// =========================================================================
// TODO ROUTES
// =========================================================================

if ($seg1 === 'todos') {

    // POST todos (create)
    if ($seg2 === '' && $method === 'POST') {
        $userId = require_auth();
        $project_id = $body['project_id'] ?? '';
        $title      = $body['title'] ?? '';
        if (!$project_id || !$title) json_out(['error' => 'Missing required fields'], 400);
        if (!can_access_project($db, $project_id, $userId)) json_out(['error' => 'Forbidden'], 403);

        $id = uuid_v4();
        $s = $db->prepare('INSERT INTO todo_items (id,project_id,gantt_entry_id,title,description,status,assignee_id,due_date,position) VALUES (?,?,?,?,?,?,?,?,?)');
        $s->execute([
            $id, $project_id, $body['gantt_entry_id'] ?? null, $title,
            $body['description'] ?? '', $body['status'] ?? 'todo',
            $body['assignee_id'] ?? null, $body['due_date'] ?? null,
            $body['position'] ?? 0
        ]);

        $s = $db->prepare('SELECT * FROM todo_items WHERE id=?');
        $s->execute([$id]);
        json_out(['todo' => $s->fetch()]);
    }

    if ($seg2) {
        $todoId = $seg2;

        // GET todos/:projectId
        if ($method === 'GET') {
            $userId = require_auth();
            $projectId = $todoId;
            if (!can_access_project($db, $projectId, $userId)) json_out(['error' => 'Forbidden'], 403);

            $s = $db->prepare('SELECT * FROM todo_items WHERE project_id=? ORDER BY position ASC, created_at ASC');
            $s->execute([$projectId]);
            json_out(['todos' => $s->fetchAll()]);
        }

        // PUT todos/:id
        if ($method === 'PUT') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM todo_items WHERE id=?');
            $s->execute([$todoId]);
            $existing = $s->fetch();
            if (!$existing) json_out(['error' => 'Not found'], 404);
            if (!can_access_project($db, $existing['project_id'], $userId)) json_out(['error' => 'Forbidden'], 403);

            $s = $db->prepare('UPDATE todo_items SET title=?,description=?,status=?,assignee_id=?,due_date=?,position=?,updated_at=? WHERE id=?');
            $s->execute([
                $body['title'] ?? $existing['title'],
                $body['description'] ?? $existing['description'],
                $body['status'] ?? $existing['status'],
                $body['assignee_id'] ?? $existing['assignee_id'],
                $body['due_date'] ?? $existing['due_date'],
                $body['position'] ?? $existing['position'],
                now_ms(),
                $todoId
            ]);

            $s = $db->prepare('SELECT * FROM todo_items WHERE id=?');
            $s->execute([$todoId]);
            json_out(['todo' => $s->fetch()]);
        }

        // DELETE todos/:id
        if ($method === 'DELETE') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM todo_items WHERE id=?');
            $s->execute([$todoId]);
            $existing = $s->fetch();
            if (!$existing) json_out(['error' => 'Not found'], 404);
            if (!can_access_project($db, $existing['project_id'], $userId)) json_out(['error' => 'Forbidden'], 403);

            $s = $db->prepare('DELETE FROM todo_items WHERE id=?');
            $s->execute([$todoId]);
            json_out(['ok' => true]);
        }
    }
}

// =========================================================================
// UNDO ROUTE
// =========================================================================

if ($seg1 === 'undo' && $seg2 && $method === 'POST') {
    $userId = require_auth();
    $projectId = $seg2;
    if (!can_access_project($db, $projectId, $userId)) json_out(['error' => 'Forbidden'], 403);

    $s = $db->prepare('SELECT * FROM undo_history WHERE project_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50');
    $s->execute([$projectId, $userId]);
    $history = $s->fetchAll();
    if (empty($history)) json_out(['error' => 'Nothing to undo'], 400);

    $action = $history[0];
    $data = json_decode($action['action_data'], true);

    $s = $db->prepare('DELETE FROM undo_history WHERE id=?');
    $s->execute([$action['id']]);

    $result = [];
    if ($action['action_type'] === 'create_gantt') {
        $s = $db->prepare('DELETE FROM gantt_entries WHERE id=?');
        $s->execute([$data['entry']['id']]);
        $result = ['undone' => 'create_gantt', 'entry_id' => $data['entry']['id']];
    } elseif ($action['action_type'] === 'update_gantt') {
        $e = $data['entry'];
        $s = $db->prepare('UPDATE gantt_entries SET title=?,start_date=?,end_date=?,hours_estimate=?,color_variation=?,position=?,notes=?,folder_url=?,updated_at=? WHERE id=?');
        $s->execute([$e['title'], $e['start_date'], $e['end_date'], $e['hours_estimate'], $e['color_variation'], $e['position'], $e['notes'], $e['folder_url'] ?? '', now_ms(), $e['id']]);

        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$e['id']]);
        $result = ['undone' => 'update_gantt', 'entry' => $s->fetch()];
    } elseif ($action['action_type'] === 'delete_gantt') {
        $e = $data['entry'];
        try {
            $s = $db->prepare('INSERT INTO gantt_entries (id,project_id,parent_id,title,start_date,end_date,hours_estimate,color_variation,user_id,position,notes,folder_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
            $s->execute([$e['id'], $e['project_id'], $e['parent_id'], $e['title'], $e['start_date'], $e['end_date'], $e['hours_estimate'], $e['color_variation'], $e['user_id'], $e['position'], $e['notes'], $e['folder_url'] ?? '']);
        } catch (Exception $ex) { /* entry already exists – ignore duplicate */ }

        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$e['id']]);
        $result = ['undone' => 'delete_gantt', 'entry' => $s->fetch()];
    }

    json_out($result);
}

// =========================================================================
// 404 – No route matched
// =========================================================================

json_out(['error' => 'Not found'], 404);
