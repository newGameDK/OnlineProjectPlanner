# OnlineProjectPlanner – Complete Documentation

## Overview

OnlineProjectPlanner is a collaborative, browser-based project planning tool. It lets teams manage projects through an interactive Gantt chart and a Kanban-style Todo board. All data is stored server-side so every team member always sees the same state.

The application works on any PHP-enabled shared web hosting (such as simply.com) without requiring Node.js. Upload the contents of the `public/` folder to your `public_html` directory and the app is ready to use.

---

## File Structure

```
OnlineProjectPlanner/
├── public/                        ← Upload this folder's contents to public_html
│   ├── .htaccess                  ← Cache control headers (prevents stale JS/CSS)
│   ├── index.html                 ← Login / Register page
│   ├── app.html                   ← Main application page (Gantt + Todo)
│   ├── share.html                 ← Public read-only share view
│   ├── version.json               ← Version number (single source of truth)
│   │
│   ├── css/
│   │   └── style.css              ← All application styles (single file)
│   │
│   ├── js/
│   │   ├── config.js              ← Frontend configuration (API_BASE, PHP_ROUTER)
│   │   ├── auth.js                ← Login / register / join-team logic
│   │   ├── app.js                 ← Main app state, team/project management, sync
│   │   ├── gantt.js               ← Interactive Gantt chart module
│   │   ├── todo.js                ← Kanban Todo board module
│   │   └── share.js               ← Read-only share page logic
│   │
│   └── api/
│       ├── router.php             ← PHP API entry point – handles all /api/* routes
│       ├── db.php                 ← SQLite database initialisation and schema
│       ├── .htaccess              ← (Optional) mod_rewrite for clean URLs – rules disabled by default
│       └── data/
│           ├── .htaccess          ← Blocks direct HTTP access to the data folder
│           └── planner.db         ← SQLite database (auto-created on first request)
│
├── server.js                      ← Node.js backend (for local/VPS development only)
├── package.json                   ← Node.js dependencies
├── README.md                      ← Quick-start guide
└── DOCUMENTATION.md               ← This file
```

---

## Detailed File Descriptions

### `public/index.html`
The entry point of the application. Contains:
- A **Login** form (username + password)
- A **Register** form (username + email + password)
- A **Join Team** field for pasting an invitation token received from a team owner

On load, `auth.js` probes the `/api/health` endpoint. If the API is unreachable, an error banner is shown with a link to the `/api/diag` endpoint for debugging.

---

### `public/app.html`
The main application shell loaded after a successful login. Contains:
- **Top navigation bar** – project breadcrumb, sync status indicator, user avatar/settings
- **Collapsible sidebar** – list of teams, projects, and team members
- **Gantt chart panel** – the primary planning view
- **Todo board panel** – a Kanban board linked to Gantt tasks
- **Modal overlay** – reusable modal dialog used for creating/editing items
- **Context menu** – right-click menu for Gantt entry operations

---

### `public/share.html`
A read-only, publicly accessible view of a project Gantt chart. Accessed via a share token in the URL (`share.html?token=<token>`). No login is required. Supports the same zoom/date range controls as the main app but does not allow any edits.

---

### `public/css/style.css`
Single CSS file for the entire application. Covers:
- CSS custom properties (colour tokens, spacing, row height)
- Auth page layout and form styles
- Top bar, sidebar, and main content layout
- Gantt chart and timeline styles (rulers, bars, drag handles, dependency arrows)
- Todo board columns and cards
- Modal dialog, context menu, sync indicator

---

### `public/js/config.js`
Frontend configuration file. Edit this file to change where the frontend sends API requests.

| Constant | Default | Purpose |
|---|---|---|
| `API_BASE` | `'.'` | Base URL for API calls. `'.'` = relative (same server). Set to a full URL for split deployments. |
| `PHP_ROUTER` | `true` | When `true`, API calls go directly to `api/router.php?_route=<path>`, bypassing `.htaccess` URL rewriting. Recommended for shared hosting. |

The helper function `apiUrl(path)` builds the correct request URL from these settings and is used throughout all other JS files.

---

### `public/js/auth.js`
Handles all authentication-related interactions on `index.html`:

- **API health probe** – on page load, calls `/api/health`. If it fails, shows an error banner with a link to `/api/diag` to help diagnose the hosting setup.
- **Login** – `POST /api/auth/login` with `{ username, password }`. On success, redirects to `app.html`.
- **Register** – `POST /api/auth/register` with `{ username, email, password }`. On success, redirects to `app.html`.
- **Join Team** – `POST /api/teams/join/<token>`. Adds the current user to a team using an invitation token.
- **Auto-redirect** – if a session is already active (`GET /api/auth/me` succeeds), redirects to `app.html` immediately.

---

### `public/js/app.js`
Main application module. Manages application state and orchestrates all other modules.

**State object (`state`):**
- `user` – the currently logged-in user
- `teams` – list of teams the user belongs to
- `members` – members per team (keyed by team ID)
- `projects` – projects per team (keyed by team ID)
- `currentTeam` / `currentProject` – active selections
- `ganttEntries` / `todos` / `dependencies` – data for the active project
- `lastSync` – timestamp of the last successful sync poll

**Key functionality:**
- **`api(method, url, body)`** – generic fetch wrapper. Automatically uses `apiUrl()` from config.js, sends/receives JSON, throws on non-JSON responses or HTTP errors.
- **WebSocket (optional)** – attempts to connect to a WebSocket server at `/ws`. On PHP hosting this will fail after 3 retries; polling takes over automatically.
- **Polling sync** – `startSync()` polls `/api/sync/<projectId>?since=<timestamp>` every 2 seconds when WebSocket is unavailable, merging any new Gantt entries, todos, and dependencies into state.
- **Team management** – create team, view members, invite by email (direct add if email is registered, invitation token otherwise), remove members, set capacity (hours/month).
- **Project management** – create, rename, and delete projects.
- **User settings** – change base colour from 10 preset options.
- **Undo** – `POST /api/undo/<projectId>` reverts the last Gantt entry create/update/delete action.
- **Export CSV** – downloads all Gantt entries as a CSV file compatible with Excel.
- **Export PDF** – opens the browser print dialog, styled for A4 landscape.
- **Share link** – generates or revokes a public share token for the current project.

**Colour system:**
Each user has a base colour. `generateColorVariations()` derives 10 lightness variants used to colour-code Gantt phases (tasks belonging to the same user get progressively different shades).

---

### `public/js/gantt.js`
Self-contained Gantt chart module. Exposed as `window.ganttModule`.

**Features:**
- **Time-scaled ruler** – three zoom levels: *day* (1 px/day), *week* (~4 px/day), *month* (~28 px/day). Zoom in/out buttons and a manual date-range picker adjust the visible window.
- **Drag-to-move** – click and drag the body of a bar to move it in time (start and end shift together). Snaps to whole days.
- **Drag-to-resize** – drag the left edge to change `start_date`; drag the right edge to change `end_date`.
- **Sub-charts (hierarchy)** – double-click any entry to drill into it; all its children are shown as the new top level. A breadcrumb trail tracks the navigation path. Entries can be infinitely nested.
- **Dependency arrows** – each bar has an output node (right edge) and an input node (left edge), shown as small circles in a darker shade of the task colour. Click the output node to enter *connecting mode*, then click an input node on another entry to draw a dependency arrow (SVG Bézier curve). Click an arrow to delete the dependency.
- **Intensity bar** – a canvas-drawn chart above the timeline showing scheduled hours per day vs. team capacity. Green = under capacity, red = over capacity.
- **Hours panel** – a right-side column showing total estimated hours per task, with recursive sums for parent tasks.
- **Selection** – click to select a single entry, Shift+click to multi-select. The **Delete Selected** button or the Delete key removes all selected entries.
- **Context menu** – right-click a Gantt entry to access *Edit*, *Add child task*, *Drill into*, and *Delete*.
- **Add entry modal** – collects title, start date, end date, hours estimate, color variation, linked folder URL, and notes.

---

### `public/js/todo.js`
Kanban Todo board module. Exposed as `window.todoModule`.

**Features:**
- **Three columns** – *To Do*, *In Progress*, *Done*
- **Filter bar** – quick-filter buttons to show all items or items in a specific status
- **Drag-and-drop** – drag cards between columns to change their status
- **Card details** – each card shows title, optional due date, and assigned member avatar
- **Add / Edit modal** – set title, description, status, assignee (from current team), due date, and optionally link to a Gantt entry
- **Link to Gantt** – a todo item can reference a `gantt_entry_id`; the entry's title is shown on the card
- **Delete** – context menu or edit modal

---

### `public/js/share.js`
Handles `share.html`. Reads a `?token=<token>` query parameter, calls `GET /api/share/<token>`, and renders the full project Gantt chart in read-only mode (no drag, no edits, no context menu). Uses the same `ganttModule` rendering logic. Shows an error state for invalid or revoked tokens.

---

### `public/api/router.php`
The PHP API entry point. All API routes are handled here.

**Startup sequence (order matters):**
1. Set `Content-Type: application/json` header immediately.
2. Parse `$_GET['_route']` and `$_SERVER['REQUEST_METHOD']`.
3. Serve `health` and `diag` routes *before* DB init (so they work even if the DB is broken).
4. `require_once db.php` – initialise SQLite.
5. `session_start()` with secure cookie settings.
6. Route to the appropriate handler.

**Routes:**

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `health` | No | Returns `{"ok":true}`. Used by the frontend to check API availability. |
| GET | `diag` | No | Returns PHP version, PDO availability, and data directory status. For debugging only. |
| POST | `auth/register` | No | Register a new user. |
| POST | `auth/login` | No | Login. Sets a server-side session cookie. |
| POST | `auth/logout` | Yes | Destroy session. |
| GET | `auth/me` | Yes | Return the current user. |
| PUT | `auth/me` | Yes | Update user settings (base colour). |
| GET | `teams` | Yes | List teams for the current user. |
| POST | `teams` | Yes | Create a team. |
| GET | `teams/:id` | Yes | Get team details + member list. |
| PUT | `teams/:id` | Yes (owner) | Update team capacity. |
| POST | `teams/:id/invite` | Yes | Invite by email (direct add or token). |
| DELETE | `teams/:id/members/:userId` | Yes | Remove a member. |
| POST | `teams/join/:token` | Yes | Join a team via invitation token. |
| GET | `projects?team_id=` | Yes | List projects for a team. |
| POST | `projects` | Yes | Create a project. |
| PUT | `projects/:id` | Yes | Update project name/description. |
| DELETE | `projects/:id` | Yes | Delete a project (cascades to all its data). |
| POST | `projects/:id/share` | Yes | Generate a public share token. |
| DELETE | `projects/:id/share` | Yes | Revoke the share token. |
| GET | `share/:token` | No | Get public project data by share token. |
| GET | `gantt/:projectId` | Yes | Get all Gantt entries for a project. |
| POST | `gantt` | Yes | Create a Gantt entry (also saves undo snapshot). |
| PUT | `gantt/:id` | Yes | Update a Gantt entry (also saves undo snapshot). |
| DELETE | `gantt/:id` | Yes | Delete a Gantt entry (also saves undo snapshot). |
| GET | `todos/:projectId` | Yes | Get all todo items for a project. |
| POST | `todos` | Yes | Create a todo item. |
| PUT | `todos/:id` | Yes | Update a todo item. |
| DELETE | `todos/:id` | Yes | Delete a todo item. |
| GET | `sync/:projectId?since=` | Yes | Poll for changes since a given timestamp. |
| POST | `undo/:projectId` | Yes | Undo the last Gantt action for the current user. |
| GET | `dependencies/:projectId` | Yes | Get all dependencies for a project. |
| POST | `dependencies` | Yes | Create a dependency between two Gantt entries. |
| DELETE | `dependencies/:id` | Yes | Delete a dependency. |

---

### `public/api/db.php`
Initialises the SQLite database. Included by `router.php`.

**On every request:**
1. Checks that `pdo_sqlite` PHP extension is loaded; returns `503` JSON error if not.
2. Creates the `api/data/` directory if it does not exist (permissions `0755`).
3. Opens (or creates) `api/data/planner.db` via PDO. Returns `503` JSON error if the connection fails.
4. Enables WAL journal mode and foreign keys.
5. Runs `CREATE TABLE IF NOT EXISTS` for all tables (idempotent – safe to run on every request).

**Database schema:**

| Table | Purpose |
|---|---|
| `users` | Registered users (id, username, email, bcrypt password hash, base colour) |
| `teams` | Teams (id, name, owner, capacity in hours/month) |
| `team_members` | Many-to-many: which users belong to which team, with role (owner/member) |
| `invitations` | Pending email invitations with a one-time token and expiry |
| `projects` | Projects belonging to a team (id, name, description, optional share token) |
| `gantt_entries` | Gantt tasks (id, project, optional parent for hierarchy, dates, hours estimate, colour variation, user, position, notes, folder URL) |
| `todo_items` | Kanban items (id, project, optional linked gantt entry, title, description, status, assignee, due date, position) |
| `undo_history` | Last 50 Gantt actions per user per project (action type + full JSON snapshot) |
| `gantt_dependencies` | Directed edges between Gantt entries (source → target) |

---

### `public/api/.htaccess`
Optional Apache rewrite rules. When uncommented, rewrites `api/<path>` to `api/router.php?_route=<path>` using mod_rewrite. **The rules are disabled (commented out) by default** because `PHP_ROUTER = true` in `config.js` makes the frontend call `router.php` directly. Active rewrite rules can cause 500 Internal Server errors on shared-hosting plans where `AllowOverride` does not include `FileInfo`. Uncomment only if you set `PHP_ROUTER = false` and your host supports mod_rewrite in `.htaccess` files.

---

### `public/api/data/.htaccess`
Denies all direct HTTP access to the `data/` directory, protecting the SQLite database file from being downloaded. Supports both Apache 2.4 (`mod_authz_core`) and older syntax.

---

### `server.js`
Node.js/Express backend for local development or VPS hosting. Provides the same REST API as `router.php` and additionally supports **WebSocket** (`/ws`) for real-time multi-user sync (no polling needed). The frontend automatically tries WebSocket and falls back to polling if it is unavailable.

Start with:
```bash
npm install
npm start          # runs on port 3000
PORT=8080 npm start  # custom port
```

---

## Deployment Guide – simply.com (PHP shared hosting)

### What you need
- A simply.com account with an active domain
- FTP/SFTP access to `public_html`
- PHP enabled (version 7.4 or newer)
- PDO SQLite extension (standard on most shared hosts)

### Step-by-step

1. **Download or clone the repository.**

2. **Upload the contents of the `public/` folder** to your `public_html` directory (or a subdirectory such as `public_html/planner/`).  
   The result should look like:
   ```
   public_html/
   ├── .htaccess              ← Cache control (hidden file – ensure your FTP client uploads it)
   ├── index.html
   ├── app.html
   ├── share.html
   ├── version.json
   ├── css/style.css
   ├── js/
   │   ├── config.js
   │   ├── auth.js
   │   ├── app.js
   │   ├── gantt.js
   │   ├── todo.js
   │   └── share.js
   └── api/
       ├── router.php
       ├── db.php
       ├── .htaccess            ← Optional; rewrite rules disabled by default
       └── data/
           └── .htaccess
   ```

3. **Verify the upload** by opening `https://yourdomain.com/api/router.php?_route=health` in your browser. You should see:
   ```json
   {"ok":true}
   ```
   If you see a blank page, a 500 error, or an HTML error page, the `api/.htaccess` file may be causing issues — delete it and try again.

4. **If the health check fails**, open `https://yourdomain.com/api/router.php?_route=diag` to see a diagnostics report:
   ```json
   {
     "php_version": "8.2.0",
     "pdo_available": true,
     "pdo_sqlite": true,
     "data_dir_exists": true,
     "data_dir_writable": true,
     "db_file_exists": false,
     "db_file_writable": false
   }
   ```
   - `pdo_sqlite: false` → contact your host to enable the `pdo_sqlite` PHP extension.
   - `data_dir_writable: false` → set the `api/data/` directory permissions to `755` via your FTP client.

5. **Open `https://yourdomain.com/index.html`** (or `https://yourdomain.com/` if you uploaded to the root) and register your first account.

6. The SQLite database `api/data/planner.db` is created automatically on the first API call.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Cannot reach the backend API" banner | `api/` folder not uploaded, PHP not enabled, or `api/.htaccess` causing 500 error | Re-upload `api/` folder; confirm PHP ≥ 7.3 is enabled; try opening `api/router.php?_route=health` directly in the browser. If you see a blank page or 500 error, delete `api/.htaccess` and try again. |
| Health check returns HTML, not JSON | PHP fatal error in db.php | Check `diag` endpoint; enable `pdo_sqlite`; fix `data/` permissions |
| Login works but session is lost on next request | Session cookie path conflict | Already fixed in the current code (cookie path set to `/`) |
| `diag` shows `data_dir_writable: false` | FTP permissions too restrictive | Right-click `api/data/` in your FTP client → change permissions to `755` |
| `.htaccess` causes 500 error | Server has `AllowOverride None` or restrictive override settings | The `api/.htaccess` rewrite rules are now disabled by default. If you still get 500 errors, delete both `.htaccess` files (`api/.htaccess` and the root `.htaccess`) — they are optional when `PHP_ROUTER = true`. |
| Version number not shown on login page | Browser serving cached old JS files | Hard refresh (`Ctrl+Shift+R`), or ensure the root `.htaccess` file was uploaded (some FTP clients hide dotfiles) |
| Uploaded new files but still see old version | Browser cache / missing `.htaccess` | Check that `version.json` shows the correct version in the browser, then do a hard refresh |
| Error banner shows "PHP 7.3 or newer is required" | Hosting is running an older PHP version | Update PHP to 7.3+ in your hosting control panel. Most shared hosts allow you to select the PHP version. |

### Subdirectory installation

If you install into a subdirectory (e.g. `public_html/planner/`), no extra configuration is needed. The `API_BASE = '.'` setting in `config.js` uses paths relative to the HTML page being viewed, so all API calls automatically resolve to the correct `api/router.php` path.

### Updating

There are **three ways** to update to a newer version:

#### Option A – In-app update (recommended)

1. Log in to the application.
2. Click your **user avatar** (top-right) → **🔄 Update App**.
3. Select the ZIP file containing the new `public/` folder.
4. The app uploads, extracts, and applies the update automatically.
5. Your database (`api/data/`) is **never overwritten**.
6. The page reloads with cache-busting parameters so you immediately see the new version.

#### Option B – Manual FTP upload (replace files)

1. Download the new release.
2. Upload the **contents of the `public/` folder** to your existing installation directory (the same `public_html/` or subdirectory you used originally), **overwriting** all existing files.
3. **Do not delete** the `api/data/` folder – it contains your SQLite database.
4. **Clear your browser cache** or do a hard refresh (`Ctrl+Shift+R` / `Cmd+Shift+R`) to ensure the new JavaScript and CSS files are loaded.
5. The schema migration is handled automatically by the `CREATE TABLE IF NOT EXISTS` statements in `db.php`.

#### Option C – Deploy to a new folder (fresh start)

If you want to keep the old installation intact:

1. Upload the new `public/` folder contents to a **new directory** (e.g. `public_html/planner_v2/`).
2. Open the new URL in your browser (e.g. `https://yourdomain.com/planner_v2/index.html`).
3. The new installation creates its own fresh database in `api/data/planner.db`.
4. If you want to keep existing data, **copy** the `api/data/planner.db` file from the old installation to the new one.

> **Important:** When deploying to a new folder, you start with a fresh database unless you manually copy `api/data/planner.db` from the old location. No hidden processes or external databases are involved – all data lives in that single file.

### Browser cache issues

If you upload new files but still see the old version:

1. The application includes a `.htaccess` file with cache control headers. Make sure the `.htaccess` file was uploaded (it is a hidden file and some FTP clients skip hidden files by default).
2. Do a hard refresh: **Ctrl+Shift+R** (Windows/Linux) or **Cmd+Shift+R** (Mac).
3. If the problem persists, clear your browser cache entirely, or try an incognito/private window.
4. Verify the upload by checking `https://yourdomain.com/version.json` – it should show the new version number.

### How cache busting works

The application prevents stale files from being served using three layers:

1. **`.htaccess` cache headers** – tells the browser to always revalidate HTML, JS, CSS, and JSON files with the server. This is the primary mechanism.
2. **`?v=VERSION` query strings** – all HTML files reference JS/CSS with a version parameter (e.g. `style.css?v=1.1.0`). When the version changes, the browser treats these as new URLs and fetches fresh copies.
3. **`<meta>` no-cache tags** – each HTML file includes meta tags as a fallback for environments where `.htaccess` is not supported.

---

## Local Development (Node.js)

For local development with hot-reload and WebSocket support, use the Node.js backend:

```bash
npm install
npm start
# Open http://localhost:3000
```

The Node.js server reads a `PORT` environment variable (default `3000`) and binds to all interfaces (`0.0.0.0`).

To test the PHP backend locally:

```bash
# From the project root
php -S localhost:8000 -t public
# Then open http://localhost:8000
```

> **Note:** PHP's built-in server handles requests differently from Apache/Nginx. If you need `.htaccess`-style routing, create a simple router script – but with `PHP_ROUTER = true`, direct access to `router.php` is all that is needed.

---

## Security Notes

- Passwords are stored as **bcrypt** hashes (`PASSWORD_BCRYPT`, cost 10).
- Session cookies are set with `httponly`, `samesite=Lax`, and `secure` (on HTTPS).
- The `api/data/` directory is protected from direct HTTP access by `.htaccess`.
- All API endpoints that access team/project data verify that the requesting user is a member of the relevant team.
- The `share` endpoint is intentionally public (read-only) and returns only non-sensitive project data (no emails, no password hashes).
