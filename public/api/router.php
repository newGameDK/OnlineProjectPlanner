<?php
// =========================================================================
// OnlineProjectPlanner – PHP API Router
// =========================================================================
// This file handles all /api/* requests when hosted on PHP shared hosting.
// It is a direct port of the Node.js server.js endpoints.
// =========================================================================

// ---- PHP version gate ---------------------------------------------------
// The null-coalescing operator (??) and other features used below require
// PHP 7.0+.  session_set_cookie_params() with an array requires PHP 7.3+.
// Bail out early with a clear JSON error if the version is too old so the
// frontend can display a meaningful message instead of a blank 500.
if (version_compare(PHP_VERSION, '7.3.0', '<')) {
    header('Content-Type: application/json; charset=utf-8');
    http_response_code(503);
    echo json_encode([
        'error' => 'PHP 7.3 or newer is required. Current version: ' . PHP_VERSION,
        'php_version' => PHP_VERSION
    ]);
    exit;
}

// ---- Global error / exception handler -----------------------------------
// Convert PHP errors and uncaught exceptions into JSON responses so the
// frontend always receives parseable output instead of HTML error pages.
set_error_handler(function ($severity, $message, $file, $line) {
    // Let PHP handle error-suppressed expressions (@operator)
    if (!(error_reporting() & $severity)) return false;
    throw new ErrorException($message, 0, $severity, $file, $line);
});
set_exception_handler(function ($e) {
    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
        http_response_code(500);
    }
    echo json_encode([
        'error' => 'Internal server error',
        'detail' => $e->getMessage(),
    ]);
    exit;
});

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

/**
 * Restore gantt entries, todos, and dependencies for a project snapshot.
 * @param PDO   $db   Database connection
 * @param array $data Array with 'entries', 'todos', 'dependencies' keys
 */
function restore_project_contents($db, $data) {
    foreach (($data['entries'] ?? []) as $e) {
        try {
            $s = $db->prepare('INSERT INTO gantt_entries (id,project_id,parent_id,title,row_label,row_height,row_only,start_date,end_date,hours_estimate,color_variation,user_id,position,notes,folder_url,subtract_hours,same_row) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
            $s->execute([$e['id'], $e['project_id'], $e['parent_id'], $e['title'], $e['row_label'] ?? $e['title'], $e['row_height'] ?? 40, $e['row_only'] ?? 0, $e['start_date'], $e['end_date'], $e['hours_estimate'], $e['color_variation'], $e['user_id'], $e['position'], $e['notes'], $e['folder_url'] ?? '', $e['subtract_hours'] ?? 0, $e['same_row'] ?? null]);
        } catch (Exception $ex) {}
    }
    foreach (($data['todos'] ?? []) as $t) {
        try {
            $s = $db->prepare('INSERT INTO todo_items (id,project_id,gantt_entry_id,title,description,status,assignee_id,due_date,position) VALUES (?,?,?,?,?,?,?,?,?)');
            $s->execute([$t['id'], $t['project_id'], $t['gantt_entry_id'] ?? null, $t['title'], $t['description'] ?? '', $t['status'] ?? 'todo', $t['assignee_id'] ?? null, $t['due_date'] ?? null, $t['position'] ?? 0]);
        } catch (Exception $ex) {}
    }
    foreach (($data['dependencies'] ?? []) as $d) {
        try {
            $s = $db->prepare('INSERT OR IGNORE INTO gantt_dependencies (id,project_id,source_id,target_id) VALUES (?,?,?,?)');
            $s->execute([$d['id'], $d['project_id'], $d['source_id'], $d['target_id']]);
        } catch (Exception $ex) {}
    }
}

function get_admin_ids() {
    global $db;
    $s = $db->prepare('SELECT value FROM app_settings WHERE key=?');
    $s->execute(['admin_ids']);
    $row = $s->fetch();
    if (!$row) return [];
    $ids = json_decode($row['value'], true);
    return is_array($ids) ? $ids : [];
}

function is_admin($userId) {
    return in_array($userId, get_admin_ids(), true);
}

function require_admin() {
    $userId = require_auth();
    if (!is_admin($userId)) {
        json_out(['error' => 'Admin access required'], 403);
    }
    return $userId;
}

/**
 * Apply a ZIP update from a file on disk.
 * Extracts the public-folder contents, protects api/data/, and cache-busts HTML.
 * @param string $zipFilePath  Absolute path to the ZIP file
 * @return array  Result with ok, version, extracted, skipped, message
 */
function apply_zip_update($zipFilePath) {
    $publicDir = dirname(__DIR__);

    $zip = new ZipArchive();
    $openResult = $zip->open($zipFilePath);
    if ($openResult !== true) {
        return ['error' => 'Failed to open ZIP file (code: ' . $openResult . ')'];
    }

    // Find the root of the application inside the ZIP
    $zipBase = '';
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = $zip->getNameIndex($i);
        if (preg_match('#^((?:[^/]+/)*)version\.json$#', $name, $m)) {
            $zipBase = $m[1];
            break;
        }
    }
    if ($zipBase === '') {
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            if (preg_match('#^((?:[^/]+/)*)index\.html$#', $name, $m)) {
                $zipBase = $m[1];
                break;
            }
        }
    }

    // Read new version from the ZIP
    $newVersion = 'unknown';
    $versionContent = $zip->getFromName($zipBase . 'version.json');
    if ($versionContent !== false) {
        $vData = json_decode($versionContent, true);
        if (isset($vData['version'])) $newVersion = $vData['version'];
    }

    $protectedPaths = ['api/data/'];
    $extracted = 0;
    $skipped   = 0;

    for ($i = 0; $i < $zip->numFiles; $i++) {
        $entryName = $zip->getNameIndex($i);
        if ($zipBase !== '' && strpos($entryName, $zipBase) !== 0) continue;
        $relativePath = substr($entryName, strlen($zipBase));
        if ($relativePath === '' || $relativePath === false) continue;
        if (strpos($relativePath, '..') !== false) { $skipped++; continue; }

        $isProtected = false;
        foreach ($protectedPaths as $pp) {
            if (strpos($relativePath, $pp) === 0) { $isProtected = true; break; }
        }
        if ($isProtected) { $skipped++; continue; }

        $targetPath = $publicDir . '/' . $relativePath;
        $parentDir = dirname($targetPath);
        if (!is_dir($parentDir)) mkdir($parentDir, 0755, true);

        $resolvedTarget = realpath($parentDir);
        $resolvedPublic = realpath($publicDir);
        if ($resolvedTarget === false || $resolvedPublic === false ||
            (strpos($resolvedTarget, $resolvedPublic . DIRECTORY_SEPARATOR) !== 0 && $resolvedTarget !== $resolvedPublic)) {
            $skipped++;
            continue;
        }

        if (substr($entryName, -1) === '/') continue;

        $content = $zip->getFromIndex($i);
        if ($content !== false) {
            file_put_contents($targetPath, $content);
            $extracted++;
        }
    }

    $zip->close();

    // Cache-bust HTML files
    $htmlFiles = glob($publicDir . '/*.html');
    if (is_array($htmlFiles)) {
        foreach ($htmlFiles as $htmlFile) {
            $html = file_get_contents($htmlFile);
            if ($html === false) continue;
            $updated = preg_replace_callback(
                '/((?:href|src)\s*=\s*["\'])([^"\']+\.(css|js))(\?v=[^"\']*)?(["\'])/i',
                function ($m) use ($newVersion) {
                    if (strpos($m[2], '://') !== false) return $m[0];
                    return $m[1] . $m[2] . '?v=' . $newVersion . $m[5];
                },
                $html
            );
            if ($updated !== null && $updated !== $html) {
                file_put_contents($htmlFile, $updated);
            }
        }
    }

    return [
        'ok'        => true,
        'version'   => $newVersion,
        'extracted' => $extracted,
        'skipped'   => $skipped,
        'message'   => 'Update applied successfully. ' . $extracted . ' files updated, ' . $skipped . ' protected files skipped.'
    ];
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
// ADMIN ROUTES
// =========================================================================

if ($seg1 === 'admin') {

    // GET admin/status
    if ($seg2 === 'status' && $method === 'GET') {
        $userId = require_auth();
        $ids = get_admin_ids();
        json_out(['hasAdmin' => count($ids) > 0, 'isAdmin' => in_array($userId, $ids, true)]);
    }

    // POST admin/set
    if ($seg2 === 'set' && $method === 'POST') {
        $userId = require_auth();
        $targetId = $body['userId'] ?? null;
        $action   = $body['action'] ?? null;
        $ids = get_admin_ids();

        // No admin yet → current user claims admin
        if (count($ids) === 0) {
            $s = $db->prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
            $s->execute(['admin_ids', json_encode([$userId])]);
            json_out(['ok' => true, 'isAdmin' => true]);
        }

        // Only admins can modify admin list
        if (!in_array($userId, $ids, true)) {
            json_out(['error' => 'Only an admin can manage admins'], 403);
        }

        if ($action === 'add' && $targetId) {
            if (!in_array($targetId, $ids, true)) $ids[] = $targetId;
            $s = $db->prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
            $s->execute(['admin_ids', json_encode(array_values($ids))]);
            json_out(['ok' => true]);
        }

        if ($action === 'remove' && $targetId) {
            $ids = array_values(array_filter($ids, function($id) use ($targetId) { return $id !== $targetId; }));
            if (count($ids) === 0) json_out(['error' => 'Cannot remove the last admin'], 400);
            $s = $db->prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
            $s->execute(['admin_ids', json_encode($ids)]);
            json_out(['ok' => true]);
        }

        json_out(['error' => 'Invalid action'], 400);
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

        // DELETE teams/:id
        // Cascades to team_members, invitations, projects, gantt_entries, etc. via ON DELETE CASCADE.
        if ($seg3 === '' && $method === 'DELETE') {
            $userId = require_auth();
            $s = $db->prepare('SELECT * FROM teams WHERE id=?');
            $s->execute([$teamId]);
            $team = $s->fetch();
            if (!$team) json_out(['error' => 'Team not found'], 404);
            if ($team['owner_id'] !== $userId) json_out(['error' => 'Only owner can delete team'], 403);

            // Snapshot the full team for undo before cascade deletion removes everything
            $s = $db->prepare('SELECT u.id, u.username, u.email, u.base_color, tm.role, tm.joined_at FROM team_members tm JOIN users u ON tm.user_id=u.id WHERE tm.team_id=?');
            $s->execute([$teamId]);
            $members = $s->fetchAll();

            $s = $db->prepare('SELECT * FROM projects WHERE team_id=? ORDER BY created_at ASC');
            $s->execute([$teamId]);
            $projects = $s->fetchAll();

            $projectSnapshots = [];
            foreach ($projects as $proj) {
                $s = $db->prepare('SELECT * FROM gantt_entries WHERE project_id=? ORDER BY position ASC, created_at ASC');
                $s->execute([$proj['id']]);
                $entries = $s->fetchAll();

                $s = $db->prepare('SELECT * FROM todo_items WHERE project_id=? ORDER BY position ASC, created_at ASC');
                $s->execute([$proj['id']]);
                $todos = $s->fetchAll();

                $s = $db->prepare('SELECT * FROM gantt_dependencies WHERE project_id=?');
                $s->execute([$proj['id']]);
                $deps = $s->fetchAll();

                $projectSnapshots[] = ['project' => $proj, 'entries' => $entries, 'todos' => $todos, 'dependencies' => $deps];
            }

            $teamSnapshot = ['team' => $team, 'members' => $members, 'projects' => $projectSnapshots];
            $s = $db->prepare('INSERT INTO global_undo_history (id,user_id,action_type,action_data) VALUES (?,?,?,?)');
            $s->execute([uuid_v4(), $userId, 'delete_team', json_encode($teamSnapshot)]);

            $s = $db->prepare('DELETE FROM teams WHERE id=?');
            $s->execute([$teamId]);
            json_out(['ok' => true]);
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

            // Snapshot the full project for undo before cascade deletion removes everything
            $s = $db->prepare('SELECT * FROM gantt_entries WHERE project_id=? ORDER BY position ASC, created_at ASC');
            $s->execute([$projectId]);
            $entries = $s->fetchAll();

            $s = $db->prepare('SELECT * FROM todo_items WHERE project_id=? ORDER BY position ASC, created_at ASC');
            $s->execute([$projectId]);
            $todos = $s->fetchAll();

            $s = $db->prepare('SELECT * FROM gantt_dependencies WHERE project_id=?');
            $s->execute([$projectId]);
            $deps = $s->fetchAll();

            $projectSnapshot = ['project' => $project, 'entries' => $entries, 'todos' => $todos, 'dependencies' => $deps];
            $s = $db->prepare('INSERT INTO global_undo_history (id,user_id,action_type,action_data) VALUES (?,?,?,?)');
            $s->execute([uuid_v4(), $userId, 'delete_project', json_encode($projectSnapshot)]);

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
        $s = $db->prepare('INSERT INTO gantt_entries (id,project_id,parent_id,title,row_label,row_height,row_only,start_date,end_date,hours_estimate,color_variation,user_id,position,notes,folder_url,same_row) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        $s->execute([
            $id, $project_id, $body['parent_id'] ?? null, $title, ($body['row_label'] ?? $title), ($body['row_height'] ?? 40), (($body['row_only'] ?? 0) ? 1 : 0), $start_date, $end_date,
            $body['hours_estimate'] ?? 0, $body['color_variation'] ?? 0, $userId,
            $body['position'] ?? 0, $body['notes'] ?? '', $body['folder_url'] ?? '', ($body['same_row'] ?? null)
        ]);

        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$id]);
        $entry = $s->fetch();

        // Save undo; clear stale redo history
        $s = $db->prepare('DELETE FROM redo_history WHERE project_id=? AND user_id=?');
        $s->execute([$project_id, $userId]);
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

            // Resolve new parent_id
            $newParentId = array_key_exists('parent_id', $body) ? ($body['parent_id'] ?: null) : $existing['parent_id'];
            if ($newParentId !== $existing['parent_id'] && $newParentId !== null) {
                if ($newParentId === $ganttId) json_out(['error' => 'Cannot set parent to self'], 400);
                // Circular check: walk up ancestry
                $cursor = $newParentId;
                while ($cursor) {
                    $s2 = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
                    $s2->execute([$cursor]);
                    $anc = $s2->fetch();
                    if (!$anc) break;
                    if ($anc['parent_id'] === $ganttId) json_out(['error' => 'Circular parent reference'], 400);
                    $cursor = $anc['parent_id'];
                }
            }

            // Save undo; clear stale redo history
            $s = $db->prepare('DELETE FROM redo_history WHERE project_id=? AND user_id=?');
            $s->execute([$existing['project_id'], $userId]);
            $s = $db->prepare('INSERT INTO undo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
            $s->execute([uuid_v4(), $existing['project_id'], $userId, 'update_gantt', json_encode(['entry' => $existing])]);

            $s = $db->prepare('UPDATE gantt_entries SET parent_id=?,title=?,row_label=?,row_height=?,row_only=?,start_date=?,end_date=?,hours_estimate=?,color_variation=?,position=?,notes=?,folder_url=?,subtract_hours=?,same_row=?,updated_at=? WHERE id=?');
            $s->execute([
                $newParentId,
                $body['title'] ?? $existing['title'],
                array_key_exists('row_label', $body) ? $body['row_label'] : ($existing['row_label'] ?: $existing['title']),
                array_key_exists('row_height', $body) ? max(28, min(240, (int)$body['row_height'])) : ((int)($existing['row_height'] ?? 40)),
                array_key_exists('row_only', $body) ? (($body['row_only'] ?? 0) ? 1 : 0) : ((int)($existing['row_only'] ?? 0)),
                $body['start_date'] ?? $existing['start_date'],
                $body['end_date'] ?? $existing['end_date'],
                $body['hours_estimate'] ?? $existing['hours_estimate'],
                $body['color_variation'] ?? $existing['color_variation'],
                $body['position'] ?? $existing['position'],
                $body['notes'] ?? $existing['notes'],
                array_key_exists('folder_url', $body) ? $body['folder_url'] : $existing['folder_url'],
                array_key_exists('subtract_hours', $body) ? ($body['subtract_hours'] ? 1 : 0) : ($existing['subtract_hours'] ?? 0),
                array_key_exists('same_row', $body) ? ($body['same_row'] ?: null) : $existing['same_row'],
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

            // Save undo; clear stale redo history
            $s = $db->prepare('DELETE FROM redo_history WHERE project_id=? AND user_id=?');
            $s->execute([$existing['project_id'], $userId]);
            $s = $db->prepare('INSERT INTO undo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
            $s->execute([uuid_v4(), $existing['project_id'], $userId, 'delete_gantt', json_encode(['entry' => $existing])]);

            $s = $db->prepare('DELETE FROM gantt_entries WHERE id=?');
            $s->execute([$ganttId]);
            json_out(['ok' => true]);
        }
    }
}

// =========================================================================
// GANTT REORDER ROUTE
// =========================================================================

if ($seg1 === 'gantt' && $seg2 && $seg3 === 'reorder' && $method === 'POST') {
    $userId = require_auth();
    $projectId = $seg2;
    if (!can_access_project($db, $projectId, $userId)) json_out(['error' => 'Forbidden'], 403);

    $positions = $body['positions'] ?? null; // [{id, position}]
    if (!is_array($positions) || empty($positions)) json_out(['error' => 'Missing positions'], 400);

    // Collect old positions for undo
    $oldPositions = [];
    foreach ($positions as $p) {
        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$p['id']]);
        $e = $s->fetch();
        if ($e) $oldPositions[] = ['id' => $e['id'], 'position' => $e['position']];
    }

    // Save ONE undo record; clear stale redo history
    $s = $db->prepare('DELETE FROM redo_history WHERE project_id=? AND user_id=?');
    $s->execute([$projectId, $userId]);
    $s = $db->prepare('INSERT INTO undo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
    $s->execute([uuid_v4(), $projectId, $userId, 'reorder_gantt', json_encode(['positions' => $oldPositions])]);

    // Apply new positions
    $ts = now_ms();
    foreach ($positions as $p) {
        $s = $db->prepare('UPDATE gantt_entries SET position=?, updated_at=? WHERE id=? AND project_id=?');
        $s->execute([$p['position'], $ts, $p['id'], $projectId]);
    }

    $entries = [];
    foreach ($positions as $p) {
        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$p['id']]);
        $e = $s->fetch();
        if ($e) $entries[] = $e;
    }
    json_out(['entries' => $entries]);
}

// =========================================================================
// UNDO STATUS ROUTE
// =========================================================================

if ($seg1 === 'undo-status' && $seg2 && $method === 'GET') {
    $userId = require_auth();
    $projectId = $seg2;
    if (!can_access_project($db, $projectId, $userId)) json_out(['error' => 'Forbidden'], 403);

    $s = $db->prepare('SELECT * FROM undo_history WHERE project_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1');
    $s->execute([$projectId, $userId]);
    $canUndo = (bool)$s->fetch();

    $s = $db->prepare('SELECT * FROM redo_history WHERE project_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1');
    $s->execute([$projectId, $userId]);
    $canRedo = (bool)$s->fetch();

    json_out(['canUndo' => $canUndo, 'canRedo' => $canRedo]);
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

    $s = $db->prepare('SELECT * FROM undo_history WHERE project_id=? AND user_id=? ORDER BY created_at DESC LIMIT 200');
    $s->execute([$projectId, $userId]);
    $history = $s->fetchAll();
    if (empty($history)) json_out(['error' => 'Nothing to undo'], 400);

    $action = $history[0];
    $data = json_decode($action['action_data'], true);

    $s = $db->prepare('DELETE FROM undo_history WHERE id=?');
    $s->execute([$action['id']]);

    $result = [];
    if ($action['action_type'] === 'create_gantt') {
        // Undo creation = delete; save entry to redo so it can be recreated
        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$data['entry']['id']]);
        $entryBeforeDelete = $s->fetch();
        if ($entryBeforeDelete) {
            $s = $db->prepare('INSERT INTO redo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
            $s->execute([uuid_v4(), $projectId, $userId, 'create_gantt', json_encode(['entry' => $entryBeforeDelete])]);
        }
        $s = $db->prepare('DELETE FROM gantt_entries WHERE id=?');
        $s->execute([$data['entry']['id']]);
        $result = ['undone' => 'create_gantt', 'entry_id' => $data['entry']['id']];
    } elseif ($action['action_type'] === 'update_gantt') {
        // Undo update = restore previous state; save current state to redo
        $e = $data['entry'];
        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$e['id']]);
        $currentEntry = $s->fetch();
        if ($currentEntry) {
            $s = $db->prepare('INSERT INTO redo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
            $s->execute([uuid_v4(), $projectId, $userId, 'update_gantt', json_encode(['entry' => $currentEntry])]);
        }
        $s = $db->prepare('UPDATE gantt_entries SET title=?,row_label=?,row_height=?,row_only=?,start_date=?,end_date=?,hours_estimate=?,color_variation=?,position=?,notes=?,folder_url=?,subtract_hours=?,same_row=?,updated_at=? WHERE id=?');
        $s->execute([$e['title'], $e['row_label'] ?? $e['title'], $e['row_height'] ?? 40, $e['row_only'] ?? 0, $e['start_date'], $e['end_date'], $e['hours_estimate'], $e['color_variation'], $e['position'], $e['notes'], $e['folder_url'] ?? '', $e['subtract_hours'] ?? 0, $e['same_row'] ?? null, now_ms(), $e['id']]);

        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$e['id']]);
        $result = ['undone' => 'update_gantt', 'entry' => $s->fetch()];
    } elseif ($action['action_type'] === 'delete_gantt') {
        // Undo deletion = recreate; save to redo so it can be deleted again
        $e = $data['entry'];
        $s = $db->prepare('INSERT INTO redo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
        $s->execute([uuid_v4(), $projectId, $userId, 'delete_gantt', json_encode(['entry' => $e])]);
        try {
            $s = $db->prepare('INSERT INTO gantt_entries (id,project_id,parent_id,title,row_label,row_height,row_only,start_date,end_date,hours_estimate,color_variation,user_id,position,notes,folder_url,subtract_hours,same_row) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
            $s->execute([$e['id'], $e['project_id'], $e['parent_id'], $e['title'], $e['row_label'] ?? $e['title'], $e['row_height'] ?? 40, $e['row_only'] ?? 0, $e['start_date'], $e['end_date'], $e['hours_estimate'], $e['color_variation'], $e['user_id'], $e['position'], $e['notes'], $e['folder_url'] ?? '', $e['subtract_hours'] ?? 0, $e['same_row'] ?? null]);
        } catch (Exception $ex) { /* entry already exists – ignore duplicate */ }

        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$e['id']]);
        $result = ['undone' => 'delete_gantt', 'entry' => $s->fetch()];
    } elseif ($action['action_type'] === 'reorder_gantt') {
        // Undo reorder = restore old positions; save current positions to redo
        $oldPositions = $data['positions'];
        $currentPositions = [];
        foreach ($oldPositions as $p) {
            $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
            $s->execute([$p['id']]);
            $e = $s->fetch();
            if ($e) $currentPositions[] = ['id' => $e['id'], 'position' => $e['position']];
        }
        $s = $db->prepare('INSERT INTO redo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
        $s->execute([uuid_v4(), $projectId, $userId, 'reorder_gantt', json_encode(['positions' => $currentPositions])]);
        $ts = now_ms();
        foreach ($oldPositions as $p) {
            $s = $db->prepare('UPDATE gantt_entries SET position=?, updated_at=? WHERE id=?');
            $s->execute([$p['position'], $ts, $p['id']]);
        }
        $entries = [];
        foreach ($oldPositions as $p) {
            $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
            $s->execute([$p['id']]);
            $e = $s->fetch();
            if ($e) $entries[] = $e;
        }
        $result = ['undone' => 'reorder_gantt', 'entries' => $entries];
    }

    json_out($result);
}

// =========================================================================
// REDO ROUTE
// =========================================================================

if ($seg1 === 'redo' && $seg2 && $method === 'POST') {
    $userId = require_auth();
    $projectId = $seg2;
    if (!can_access_project($db, $projectId, $userId)) json_out(['error' => 'Forbidden'], 403);

    $s = $db->prepare('SELECT * FROM redo_history WHERE project_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1');
    $s->execute([$projectId, $userId]);
    $redoAction = $s->fetch();
    if (!$redoAction) json_out(['error' => 'Nothing to redo'], 400);

    $data = json_decode($redoAction['action_data'], true);
    $s = $db->prepare('DELETE FROM redo_history WHERE id=?');
    $s->execute([$redoAction['id']]);

    $result = [];
    if ($redoAction['action_type'] === 'create_gantt') {
        // Redo: recreate the entry that was originally created then undone
        $e = $data['entry'];
        try {
            $s = $db->prepare('INSERT INTO gantt_entries (id,project_id,parent_id,title,row_label,row_height,row_only,start_date,end_date,hours_estimate,color_variation,user_id,position,notes,folder_url,subtract_hours,same_row) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
            $s->execute([$e['id'], $e['project_id'], $e['parent_id'], $e['title'], $e['row_label'] ?? $e['title'], $e['row_height'] ?? 40, $e['row_only'] ?? 0, $e['start_date'], $e['end_date'], $e['hours_estimate'], $e['color_variation'], $e['user_id'], $e['position'], $e['notes'], $e['folder_url'] ?? '', $e['subtract_hours'] ?? 0, $e['same_row'] ?? null]);
        } catch (Exception $ex) { /* already exists */ }
        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$e['id']]);
        $entry = $s->fetch();
        // Save new undo action so user can undo this redo
        $s = $db->prepare('INSERT INTO undo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
        $s->execute([uuid_v4(), $projectId, $userId, 'create_gantt', json_encode(['entry' => $entry])]);
        $result = ['redone' => 'create_gantt', 'entry' => $entry];
    } elseif ($redoAction['action_type'] === 'update_gantt') {
        // Redo: re-apply the update (restore to the state stored in redo data)
        $e = $data['entry'];
        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$e['id']]);
        $currentEntry = $s->fetch();
        if ($currentEntry) {
            // Save current state as undo so user can undo this redo
            $s = $db->prepare('INSERT INTO undo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
            $s->execute([uuid_v4(), $projectId, $userId, 'update_gantt', json_encode(['entry' => $currentEntry])]);
            $s = $db->prepare('UPDATE gantt_entries SET title=?,row_label=?,row_height=?,row_only=?,start_date=?,end_date=?,hours_estimate=?,color_variation=?,position=?,notes=?,folder_url=?,subtract_hours=?,same_row=?,updated_at=? WHERE id=?');
            $s->execute([$e['title'], $e['row_label'] ?? $e['title'], $e['row_height'] ?? 40, $e['row_only'] ?? 0, $e['start_date'], $e['end_date'], $e['hours_estimate'], $e['color_variation'], $e['position'], $e['notes'], $e['folder_url'] ?? '', $e['subtract_hours'] ?? 0, $e['same_row'] ?? null, now_ms(), $e['id']]);
            $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
            $s->execute([$e['id']]);
            $result = ['redone' => 'update_gantt', 'entry' => $s->fetch()];
        } else {
            $result = ['redone' => 'update_gantt', 'entry' => null];
        }
    } elseif ($redoAction['action_type'] === 'delete_gantt') {
        // Redo: delete the entry again
        $e = $data['entry'];
        $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
        $s->execute([$e['id']]);
        $currentEntry = $s->fetch();
        if ($currentEntry) {
            // Save undo action so user can undo this redo
            $s = $db->prepare('INSERT INTO undo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
            $s->execute([uuid_v4(), $projectId, $userId, 'delete_gantt', json_encode(['entry' => $currentEntry])]);
            $s = $db->prepare('DELETE FROM gantt_entries WHERE id=?');
            $s->execute([$e['id']]);
        }
        $result = ['redone' => 'delete_gantt', 'entry_id' => $e['id']];
    } elseif ($redoAction['action_type'] === 'reorder_gantt') {
        // Redo reorder = re-apply the stored positions; save current positions to undo
        $redoPositions = $data['positions'];
        $currentPositions = [];
        foreach ($redoPositions as $p) {
            $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
            $s->execute([$p['id']]);
            $e = $s->fetch();
            if ($e) $currentPositions[] = ['id' => $e['id'], 'position' => $e['position']];
        }
        $s = $db->prepare('INSERT INTO undo_history (id,project_id,user_id,action_type,action_data) VALUES (?,?,?,?,?)');
        $s->execute([uuid_v4(), $projectId, $userId, 'reorder_gantt', json_encode(['positions' => $currentPositions])]);
        $ts = now_ms();
        foreach ($redoPositions as $p) {
            $s = $db->prepare('UPDATE gantt_entries SET position=?, updated_at=? WHERE id=?');
            $s->execute([$p['position'], $ts, $p['id']]);
        }
        $entries = [];
        foreach ($redoPositions as $p) {
            $s = $db->prepare('SELECT * FROM gantt_entries WHERE id=?');
            $s->execute([$p['id']]);
            $e = $s->fetch();
            if ($e) $entries[] = $e;
        }
        $result = ['redone' => 'reorder_gantt', 'entries' => $entries];
    }

    json_out($result);
}

// =========================================================================
// GLOBAL UNDO ROUTE (team/project-level deletion)
// =========================================================================

if ($seg1 === 'undo-global' && $seg2 === '' && $method === 'POST') {
    $userId = require_auth();

    $s = $db->prepare('SELECT * FROM global_undo_history WHERE user_id=? ORDER BY created_at DESC LIMIT 1');
    $s->execute([$userId]);
    $action = $s->fetch();
    if (!$action) json_out(['error' => 'Nothing to undo'], 400);

    $data = json_decode($action['action_data'], true);
    $s = $db->prepare('DELETE FROM global_undo_history WHERE id=?');
    $s->execute([$action['id']]);

    $result = [];
    if ($action['action_type'] === 'delete_project') {
        $p = $data['project'];
        // Restore project
        try {
            $s = $db->prepare('INSERT INTO projects (id,team_id,name,description,created_by) VALUES (?,?,?,?,?)');
            $s->execute([$p['id'], $p['team_id'], $p['name'], $p['description'] ?? '', $p['created_by']]);
            $s = $db->prepare('UPDATE projects SET share_token=?,created_at=?,updated_at=? WHERE id=?');
            $s->execute([$p['share_token'] ?? null, $p['created_at'], $p['updated_at'], $p['id']]);
        } catch (Exception $ex) { /* already exists */ }
        restore_project_contents($db, $data);
        $s = $db->prepare('SELECT * FROM projects WHERE id=?');
        $s->execute([$p['id']]);
        $result = ['undone' => 'delete_project', 'project' => $s->fetch()];
    } elseif ($action['action_type'] === 'delete_team') {
        $t = $data['team'];
        // Restore team
        try {
            $s = $db->prepare('INSERT INTO teams (id,name,owner_id,capacity_hours_month) VALUES (?,?,?,?)');
            $s->execute([$t['id'], $t['name'], $t['owner_id'], $t['capacity_hours_month'] ?? 160]);
        } catch (Exception $ex) { /* already exists */ }
        // Restore members
        foreach (($data['members'] ?? []) as $m) {
            try {
                $s = $db->prepare('INSERT OR IGNORE INTO team_members (team_id,user_id,role) VALUES (?,?,?)');
                $s->execute([$t['id'], $m['id'], $m['role'] ?? 'member']);
            } catch (Exception $ex) {}
        }
        // Restore each project with its data
        foreach (($data['projects'] ?? []) as $pd) {
            $p = $pd['project'];
            try {
                $s = $db->prepare('INSERT INTO projects (id,team_id,name,description,created_by) VALUES (?,?,?,?,?)');
                $s->execute([$p['id'], $p['team_id'], $p['name'], $p['description'] ?? '', $p['created_by']]);
                $s = $db->prepare('UPDATE projects SET share_token=?,created_at=?,updated_at=? WHERE id=?');
                $s->execute([$p['share_token'] ?? null, $p['created_at'], $p['updated_at'], $p['id']]);
            } catch (Exception $ex) {}
            restore_project_contents($db, $pd);
        }
        $s = $db->prepare('SELECT * FROM teams WHERE id=?');
        $s->execute([$t['id']]);
        $result = ['undone' => 'delete_team', 'team' => $s->fetch()];
    }

    json_out($result);
}

if ($seg1 === 'backup' && $method === 'GET') {
    require_auth();
    $userId = $_SESSION['userId'];

    $s = $db->prepare('SELECT * FROM users WHERE id=?');
    $s->execute([$userId]);
    $user = $s->fetch();
    if (!$user) json_out(['error' => 'User not found'], 404);

    $s = $db->prepare('SELECT t.*, tm.role FROM teams t JOIN team_members tm ON t.id=tm.team_id WHERE tm.user_id=? ORDER BY t.created_at ASC');
    $s->execute([$userId]);
    $teams = $s->fetchAll();

    $result = [
        'version'     => 1,
        'exported_at' => gmdate('Y-m-d\TH:i:s\Z'),
        'user'        => sanitize_user($user),
        'teams'       => [],
    ];

    foreach ($teams as $team) {
        $s = $db->prepare('SELECT u.id, u.username, u.email, u.base_color, tm.role FROM team_members tm JOIN users u ON tm.user_id=u.id WHERE tm.team_id=?');
        $s->execute([$team['id']]);
        $members = $s->fetchAll();

        $s = $db->prepare('SELECT * FROM projects WHERE team_id=? ORDER BY created_at ASC');
        $s->execute([$team['id']]);
        $projects = $s->fetchAll();

        $projectsOut = [];
        foreach ($projects as $proj) {
            $s = $db->prepare('SELECT * FROM gantt_entries WHERE project_id=? ORDER BY position ASC, created_at ASC');
            $s->execute([$proj['id']]);
            $entries = $s->fetchAll();

            $s = $db->prepare('SELECT * FROM todo_items WHERE project_id=? ORDER BY position ASC, created_at ASC');
            $s->execute([$proj['id']]);
            $todos = $s->fetchAll();

            $s = $db->prepare('SELECT * FROM gantt_dependencies WHERE project_id=?');
            $s->execute([$proj['id']]);
            $deps = $s->fetchAll();

            $proj['entries']      = $entries;
            $proj['todos']        = $todos;
            $proj['dependencies'] = $deps;
            $projectsOut[]        = $proj;
        }

        $team['members']  = $members;
        $team['projects'] = $projectsOut;
        $result['teams'][] = $team;
    }

    header('Content-Disposition: attachment; filename="planner_backup_' . date('Y-m-d') . '.json"');
    json_out($result);
}

// =========================================================================
// IMPORT BACKUP – restore teams, projects, entries, todos, dependencies
// =========================================================================

if ($seg1 === 'backup' && $seg2 === 'import' && $method === 'POST') {
    $userId = require_auth();
    $backup = $body;

    if (!is_array($backup) || !isset($backup['teams']) || !is_array($backup['teams'])) {
        json_out(['error' => 'Invalid backup format'], 400);
    }

    $teamsImported = 0; $projectsImported = 0; $entriesImported = 0;
    $todosImported = 0; $depsImported = 0;

    $db->beginTransaction();
    try {
        foreach ($backup['teams'] as $team) {
            $s = $db->prepare('SELECT id FROM teams WHERE id=?');
            $s->execute([$team['id']]);
            if (!$s->fetch()) {
                try {
                    $s = $db->prepare('INSERT INTO teams (id, name, owner_id, capacity_hours_month) VALUES (?,?,?,?)');
                    $s->execute([$team['id'], $team['name'], $userId, $team['capacity_hours_month'] ?? 160]);
                    $s = $db->prepare('INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES (?,?,?)');
                    $s->execute([$team['id'], $userId, 'owner']);
                    $teamsImported++;
                } catch (Exception $e) { continue; }
            } else {
                $s = $db->prepare('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?');
                $s->execute([$team['id'], $userId]);
                if (!$s->fetch()) {
                    $s = $db->prepare('INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES (?,?,?)');
                    $s->execute([$team['id'], $userId, 'member']);
                }
            }

            foreach (($team['projects'] ?? []) as $proj) {
                $s = $db->prepare('SELECT id FROM projects WHERE id=?');
                $s->execute([$proj['id']]);
                if (!$s->fetch()) {
                    try {
                        $s = $db->prepare('INSERT INTO projects (id, team_id, name, description, created_by) VALUES (?,?,?,?,?)');
                        $s->execute([$proj['id'], $team['id'], $proj['name'], $proj['description'] ?? '', $userId]);
                        $projectsImported++;
                    } catch (Exception $e) { continue; }
                }

                foreach (($proj['entries'] ?? []) as $e) {
                    try {
                        $s = $db->prepare('INSERT INTO gantt_entries (id, project_id, parent_id, title, row_label, row_height, row_only, start_date, end_date, hours_estimate, color_variation, user_id, position, notes, folder_url, subtract_hours, same_row) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
                        $s->execute([
                            $e['id'], $proj['id'], $e['parent_id'] ?? null, $e['title'], $e['row_label'] ?? ($e['title'] ?? ''),
                            $e['row_height'] ?? 40, $e['row_only'] ?? 0, $e['start_date'], $e['end_date'], $e['hours_estimate'] ?? 0,
                            $e['color_variation'] ?? 0, $userId, $e['position'] ?? 0,
                            $e['notes'] ?? '', $e['folder_url'] ?? '', $e['subtract_hours'] ?? 0, $e['same_row'] ?? null
                        ]);
                        $entriesImported++;
                    } catch (Exception $ex) { /* already exists */ }
                }

                foreach (($proj['todos'] ?? []) as $t) {
                    try {
                        $s = $db->prepare('INSERT INTO todo_items (id, project_id, gantt_entry_id, title, description, status, assignee_id, due_date, position) VALUES (?,?,?,?,?,?,?,?,?)');
                        $s->execute([
                            $t['id'], $proj['id'], $t['gantt_entry_id'] ?? null, $t['title'],
                            $t['description'] ?? '', $t['status'] ?? 'todo',
                            $t['assignee_id'] ?? null, $t['due_date'] ?? null, $t['position'] ?? 0
                        ]);
                        $todosImported++;
                    } catch (Exception $ex) { /* already exists */ }
                }

                foreach (($proj['dependencies'] ?? []) as $d) {
                    try {
                        $s = $db->prepare('INSERT OR IGNORE INTO gantt_dependencies (id, project_id, source_id, target_id) VALUES (?,?,?,?)');
                        $s->execute([$d['id'], $proj['id'], $d['source_id'], $d['target_id']]);
                        $depsImported++;
                    } catch (Exception $ex) { /* already exists */ }
                }
            }
        }
        $db->commit();
    } catch (Exception $e) {
        $db->rollBack();
        json_out(['error' => 'Import failed: ' . $e->getMessage()], 500);
    }

    json_out([
        'ok' => true,
        'imported' => [
            'teams' => $teamsImported, 'projects' => $projectsImported,
            'entries' => $entriesImported, 'todos' => $todosImported,
            'dependencies' => $depsImported
        ]
    ]);
}

// =========================================================================
// VERSION ROUTE
// =========================================================================

if ($seg1 === 'version' && $method === 'GET') {
    $versionFile = dirname(__DIR__) . '/version.json';
    if (file_exists($versionFile)) {
        $data = json_decode(file_get_contents($versionFile), true);
        json_out($data ?: ['version' => 'unknown']);
    }
    json_out(['version' => 'unknown']);
}

// =========================================================================
// UPDATE ROUTE – Upload a ZIP to update the application
// =========================================================================

if ($seg1 === 'update' && $method === 'POST') {
    require_admin();

    @set_time_limit(0);
    @ini_set('memory_limit', '256M');

    if (!class_exists('ZipArchive')) {
        json_out(['error' => 'PHP zip extension is not installed on this server'], 500);
    }

    if (empty($_FILES['zipfile']) || $_FILES['zipfile']['error'] !== UPLOAD_ERR_OK) {
        $code = isset($_FILES['zipfile']) ? $_FILES['zipfile']['error'] : -1;
        json_out(['error' => 'No file uploaded or upload error (code: ' . $code . ')'], 400);
    }

    $uploadedFile = $_FILES['zipfile']['tmp_name'];
    try {
        $result = apply_zip_update($uploadedFile);
    } catch (Exception $e) {
        json_out(['error' => 'Update failed: ' . $e->getMessage()], 500);
    }

    if (file_exists($uploadedFile)) unlink($uploadedFile);

    if (isset($result['error'])) {
        json_out($result, 400);
    }
    json_out($result);
}

// =========================================================================
// GITHUB RELEASES – list available versions & update from GitHub
// =========================================================================

if ($seg1 === 'github-releases' && $method === 'GET') {
    $versionFile = dirname(__DIR__) . '/version.json';
    $repository = '';
    if (file_exists($versionFile)) {
        $vData = json_decode(file_get_contents($versionFile), true);
        if (isset($vData['repository'])) $repository = $vData['repository'];
    }
    if (!$repository) {
        json_out(['error' => 'No repository configured in version.json'], 400);
    }

    $apiUrl = 'https://api.github.com/repos/' . $repository . '/releases';
    $ctx = stream_context_create([
        'http' => [
            'header' => "User-Agent: OnlineProjectPlanner\r\nAccept: application/vnd.github+json\r\n",
            'timeout' => 10,
        ]
    ]);
    $raw = @file_get_contents($apiUrl, false, $ctx);
    if ($raw === false) {
        json_out(['error' => 'Failed to reach GitHub API'], 502);
    }
    $releases = json_decode($raw, true);
    if (!is_array($releases)) {
        json_out(['error' => 'Failed to parse GitHub response'], 502);
    }
    $result = [];
    foreach ($releases as $r) {
        $assets = [];
        if (isset($r['assets']) && is_array($r['assets'])) {
            foreach ($r['assets'] as $a) {
                $assets[] = [
                    'name'         => $a['name'],
                    'size'         => $a['size'],
                    'download_url' => $a['browser_download_url'],
                ];
            }
        }
        $result[] = [
            'tag'       => $r['tag_name'],
            'name'      => $r['name'] ?: $r['tag_name'],
            'published' => $r['published_at'],
            'body'      => $r['body'] ?: '',
            'assets'    => $assets,
        ];
    }
    json_out($result);
}

if ($seg1 === 'update-from-github' && $method === 'POST') {
    require_admin();

    // Prevent PHP execution timeout from killing the download + extraction
    @set_time_limit(0);
    @ini_set('memory_limit', '256M');

    if (!class_exists('ZipArchive')) {
        json_out(['error' => 'PHP zip extension is not installed on this server'], 500);
    }

    $url = $body['url'] ?? '';
    if (!$url || !is_string($url)) {
        json_out(['error' => 'Missing download URL'], 400);
    }

    // Validate URL is from GitHub
    if (strpos($url, 'https://github.com/') !== 0) {
        json_out(['error' => 'URL must be a GitHub release asset'], 400);
    }

    $dataDir = __DIR__ . '/data';
    if (!is_dir($dataDir)) mkdir($dataDir, 0755, true);
    $tmpFile = $dataDir . '/github_update_' . time() . '.zip';

    // Try cURL first (better HTTPS/redirect support); fall back to file_get_contents
    $downloaded = false;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 5,
            CURLOPT_TIMEOUT        => 120,
            CURLOPT_USERAGENT      => 'OnlineProjectPlanner',
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        $fp = fopen($tmpFile, 'wb');
        curl_setopt($ch, CURLOPT_FILE, $fp);
        curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);
        fclose($fp);
        if ($curlError || $httpCode !== 200) {
            if (file_exists($tmpFile)) unlink($tmpFile);
            json_out(['error' => 'Failed to download file from GitHub' . ($curlError ? ': ' . $curlError : ' (HTTP ' . $httpCode . ')')], 502);
        }
        $downloaded = true;
    }

    if (!$downloaded) {
        $ctx = stream_context_create([
            'http' => [
                'header'          => "User-Agent: OnlineProjectPlanner\r\n",
                'timeout'         => 120,
                'follow_location' => 1,
                'max_redirects'   => 5,
            ]
        ]);
        $data = @file_get_contents($url, false, $ctx);
        if ($data === false) {
            json_out(['error' => 'Failed to download file from GitHub'], 502);
        }
        file_put_contents($tmpFile, $data);
        unset($data); // free memory
    }

    try {
        $result = apply_zip_update($tmpFile);
    } catch (Exception $e) {
        if (file_exists($tmpFile)) unlink($tmpFile);
        json_out(['error' => 'Update failed: ' . $e->getMessage()], 500);
    }
    if (file_exists($tmpFile)) unlink($tmpFile);

    if (isset($result['error'])) {
        json_out($result, 500);
    }
    json_out($result);
}

// =========================================================================
// 404 – No route matched
// =========================================================================

json_out(['error' => 'Not found'], 404);
