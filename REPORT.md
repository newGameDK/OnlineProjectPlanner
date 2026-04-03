# OnlineProjectPlanner – Full Functionality Report

## Overview

OnlineProjectPlanner is a collaborative, browser-based project planning tool. It lets teams manage projects through an interactive Gantt chart and a Kanban-style Todo board. All data is stored server-side (SQLite) so every team member always sees the same state.

The application supports two deployment modes:
- **PHP shared hosting** – Upload the `public/` folder to `public_html`; no Node.js required.
- **Node.js server** – Run `node server.js` for WebSocket-based real-time collaboration.

---

## 1. Authentication & User Management

| Feature | Description |
|---------|-------------|
| **User Registration** | Create an account with username, email, and password (minimum 6 characters). |
| **User Login** | Username/password authentication with server-side sessions (7-day expiry). |
| **User Logout** | Destroy session and redirect to the login page. |
| **Profile Color Picker** | Choose from 10 base colors for personal identification across Gantt bars. |
| **Color Variation System** | Each base color generates 10 HSL-based variations for task phase differentiation. |
| **Backend Health Detection** | Login page auto-probes API endpoints with fallback routing for PHP/Node.js hosting. |
| **File Protocol Warning** | Warns users if the app is opened via `file://` instead of a web server. |

---

## 2. Team Management

| Feature | Description |
|---------|-------------|
| **Create Team** | Create a team with a name and capacity (hours/month). The creator becomes the owner. |
| **List & Select Teams** | Sidebar displays all teams the user belongs to; clicking selects a team. |
| **Update Team Capacity** | Modify the team's monthly capacity (hours/month) used for intensity bar calculations. |
| **View Members** | Display all team members with their roles and color indicators. |
| **Invite Members** | Generate invitation tokens (valid 7 days); recipients join via a link or paste-in token. |
| **Join Team via Token** | Redeem an invitation token from the login page or app page. |
| **Remove Members** | Team owners can remove members from the team. |
| **Member Roles** | Members have roles (owner / member) stored in the `team_members` table. |

---

## 3. Project Management

| Feature | Description |
|---------|-------------|
| **Create Project** | Create a project with a name and optional description under a team. |
| **List Projects** | Sidebar shows projects for the selected team. |
| **Update Project** | Edit project name and description. |
| **Delete Project** | Delete project and cascade-delete all Gantt entries, todos, and dependencies. |
| **Project Selection** | Switch between projects; loads all associated Gantt entries, todos, and dependencies. |

### Project Sharing

| Feature | Description |
|---------|-------------|
| **Generate Share Link** | Create a public read-only share URL with a unique token. |
| **Revoke Share Link** | Remove public access and invalidate the token. |
| **Public Share View** | Read-only Gantt chart accessible without login (`share.html`). |

---

## 4. Gantt Chart

### Core Interactions

| Feature | Description |
|---------|-------------|
| **Time-Scaled Ruler** | Calendar header with Day / Week / Month zoom levels. |
| **Drag to Move** | Drag a bar's body to shift the entire entry (start + end dates move together). |
| **Drag Left Handle** | Resize an entry by changing only the start date. |
| **Drag Right Handle** | Resize an entry by changing only the end date. |
| **Zoom In / Out Buttons** | Toolbar buttons adjust pixels-per-day (range: 4 – 200 px). |
| **Scroll Wheel Zoom** | Mouse wheel over the timeline, ruler, or intensity bar zooms in/out. |
| **Custom Date Range** | Set manual chart start/end dates via date inputs. |
| **Auto Chart Range** | Automatically adjusts view range to fit all entry dates. |

### Entry Management

| Feature | Description |
|---------|-------------|
| **Create Entry** | Add a task with title, dates, hours estimate, color variation, notes, and folder URL. |
| **Edit Entry** | Modify any entry field via a modal dialog. |
| **Delete Entry** | Delete an entry (cascades to dependencies). |
| **Add Sub-task** | Create child entries under a parent task. |
| **Subtask Hours Prompt** | When creating a subtask, prompts to enable "subtract hours from parent" if the parent has hours and the flag isn't set. |

### Hierarchy & Navigation

| Feature | Description |
|---------|-------------|
| **Parent–Child Structure** | Entries support infinite nesting via `parent_id`. |
| **Inline Expand / Collapse** | Click the arrow indicator to show/hide children inline with depth indentation. |
| **Drill-Down Navigation** | Double-click a parent to enter a sub-chart view showing only its children. |
| **Breadcrumb Navigation** | Visual trail for navigating back up the hierarchy. |
| **Subtract Hours Checkbox** | In breadcrumb: toggle whether child hours are subtracted from or added to the parent estimate. |

### Dependencies

| Feature | Description |
|---------|-------------|
| **Create Dependency** | Click an output node (right-edge green ▶), then an input node (left-edge blue ◀) to connect tasks. |
| **Rubber-Band Line** | SVG line follows the mouse during connection mode. |
| **Bezier Arrow Rendering** | Smooth SVG bezier curves between connected tasks. |
| **Delete Dependency** | Click on an arrow (14 px invisible hit area) with confirmation prompt. |
| **Cancel Connecting** | Press Escape or click the Cancel button to abort. |

### Selection & Batch Operations

| Feature | Description |
|---------|-------------|
| **Single Select** | Click an entry to select it. |
| **Multi-Select** | Shift-click to add/remove entries from the selection. |
| **Delete Selected** | Toolbar button or Delete/Backspace key to batch-delete selected entries. |

### Reparent Drag-and-Drop

| Feature | Description |
|---------|-------------|
| **Drag Grip (≡)** | Grab the grip handle in the task list to start reparenting. |
| **Ghost Element** | Floating clone shows during drag operation. |
| **Drop Target Highlighting** | Valid drop targets are visually highlighted. |
| **Circular Parent Prevention** | Server and client both reject reparenting that would create cycles. |

### Advanced Features

| Feature | Description |
|---------|-------------|
| **Folder Link** | Store and open SharePoint / OneDrive / network folder URLs. |
| **Entry Notes** | Free-text notes (shown in tooltips and Excel exports). |
| **Hours Estimate** | Track estimated effort per entry. |
| **Color Variation** | Select from 10 phase/colour variations per entry. |

### Task List Panel

| Feature | Description |
|---------|-------------|
| **Task Names** | Displays entry titles with tooltips for notes. |
| **Expand Indicator** | Clickable arrow to expand/collapse children. |
| **Colour Dot** | User colour indicator next to each entry. |
| **Action Buttons** | Edit, Add to Todo, Add sub-task, Delete (appear on hover). |
| **Context Menu** | Right-click menu with all operations. |

### Hours Panel

| Feature | Description |
|---------|-------------|
| **Total Hours Column** | Right panel showing recursive total hours per entry. |
| **Recursive Calculation** | `calcTotalHours()` sums all descendant hours. When `subtract_hours` is enabled, child hours are subtracted from the parent instead. |
| **Sync Scroll** | Vertical scroll is synchronized between task list, timeline, and hours panel. |

### Intensity Bar

| Feature | Description |
|---------|-------------|
| **Capacity Visualization** | Canvas-based bar chart showing daily scheduled hours vs team capacity. |
| **Colour Gradient** | Green (under capacity) → yellow → red (over capacity). |
| **Daily Totals** | Sums all user hours for each day across all visible entries. |
| **Horizontal Scroll Sync** | Intensity bar scrolls with the timeline. |

### Help Mode

| Feature | Description |
|---------|-------------|
| **Help Toggle** | Toolbar button activates help mode. |
| **Contextual Tooltips** | Hover over labelled elements to see explanatory text via `data-help` attributes. |

---

## 5. Todo / Kanban Board

### Board Structure

| Feature | Description |
|---------|-------------|
| **Three Columns** | Todo, In Progress, Done status columns. |
| **Kanban Cards** | Cards display title, description, status, due date, assignee, and linked Gantt entry. |

### Todo Features

| Feature | Description |
|---------|-------------|
| **Create Todo** | Create a task with title, description, status, assignee, due date, and Gantt link. |
| **Edit Todo** | Modify all todo properties via a modal dialog. |
| **Delete Todo** | Remove with confirmation prompt. |
| **Assignee** | Assign a todo to a team member; avatar displayed on the card. |
| **Due Date** | Set and track due dates; overdue items show a ⚠ warning. |
| **Link to Gantt** | Optional link to a Gantt entry; clicking opens the linked entry. |
| **Link from Gantt** | "Add to Todo" button on Gantt entries creates a linked todo. |

### Filtering

| Feature | Description |
|---------|-------------|
| **Status Filters** | Buttons to show All / To Do / In Progress / Done. |
| **Context Menu** | Right-click to quickly change status, edit, or delete. |

---

## 6. Synchronization & Real-Time Updates

| Feature | Description |
|---------|-------------|
| **WebSocket Sync** | Automatic connection to `/ws` with SSL/TLS support (Node.js only). |
| **Auto-Reconnect** | Retries up to 3 times, then falls back to polling. |
| **Message Types** | 14+ message types: gantt created/updated/deleted, todo, dependency, project, member, team updates. |
| **Project Scope** | WebSocket messages scoped to the current project. |
| **Polling Fallback** | 2-second polling interval when WebSocket is unavailable (e.g. PHP hosting). |
| **Sync Status Indicator** | Visual dot in the top bar: green (synced), pulsing (syncing), red (offline). |

---

## 7. Undo Functionality

| Feature | Description |
|---------|-------------|
| **Undo Stack** | Per-project undo history with user context. |
| **Undo Button / Ctrl+Z** | Toolbar button or keyboard shortcut to undo the last action. |
| **Undo Endpoint** | Server restores the previous state of the entry from stored action data. |

---

## 8. Backup & Restore

| Feature | Description |
|---------|-------------|
| **Export Backup** | Download a JSON file containing all user data (teams, projects, entries, todos, dependencies). |
| **Filename Format** | `planner_backup_YYYY-MM-DD.json`. |
| **Import Backup** | Upload a previously exported JSON file to restore data. |
| **Merge Strategy** | Only missing items are added; existing data is never overwritten. |
| **Import Summary** | After import, an alert shows counts of imported teams, projects, entries, todos, and dependencies. |

---

## 9. Export Features

### Export to Excel (XLSX)

| Feature | Description |
|---------|-------------|
| **Excel Export** | Exports the Gantt chart to an `.xlsx` workbook using ExcelJS. |
| **Visual Gantt Bars** | Coloured cells represent task duration in date columns. |
| **Columns** | Title, Parent, Start Date, End Date, Hours, Assignee, then date columns. |
| **Hierarchy Display** | Entries sorted by parent with visual indentation. |
| **Styling** | Header row, borders, alternating row colours. |
| **Frozen Panes** | Freeze header row and data columns for scrolling. |

### Export to PDF / Print

| Feature | Description |
|---------|-------------|
| **Print Dialog** | Triggers the browser's print dialog optimised for PDF output. |
| **A4 Landscape** | Page size set to A4 landscape with 8 mm margins. |
| **Single-Page Mode** | When the chart fits on one page, prints directly. |
| **Multi-Page Layout** | Automatic horizontal tiling with 1 cm overlap between pages. |
| **Page Labels** | "Page X / Y" labels on each print page. |
| **Overlap Marks** | Dashed lines with scissors (✂) symbols show where pages overlap for manual alignment. |
| **Colour Preservation** | `print-color-adjust: exact` ensures bar colours remain visible. |
| **UI Hiding** | Topbar, sidebar, toolbar, tabs, todo panel, and action buttons are hidden during print. |

---

## 10. Admin Management & Application Updates

### Admin System

| Feature | Description |
|---------|-------------|
| **Admin Status Check** | Any user can check if an admin has been set (`GET /api/admin/status`). |
| **Claim Admin** | When no admin exists, the first user to click "Update App" can set themselves as admin. |
| **Admin-Only Updates** | Only admins can access the Update App functionality. |
| **Manage Admins** | Admins can add or remove other admins. The last admin cannot be removed. |

### GitHub Release Integration

| Feature | Description |
|---------|-------------|
| **List Releases** | Fetches available releases from the GitHub repository configured in `version.json`. |
| **Version Selection** | Dropdown to select a release version with file size display. |
| **Install from GitHub** | Downloads and applies the selected release ZIP file. |

### Manual Update

| Feature | Description |
|---------|-------------|
| **ZIP Upload** | Upload a ZIP file manually to update the application. |
| **Progress Tracking** | Visual progress bar with status messages during update. |
| **Protected Paths** | The `api/data/` directory (database) and `sounds/` directory (custom sound files) are never overwritten during updates. |
| **Path Traversal Protection** | Rejects ZIP entries with `..` in paths. |
| **Cache Busting** | HTML files are updated with new `?v=` query strings after update. |
| **Auto-Reload** | Page reloads automatically after successful update. |

---

## 11. API Endpoints

### Authentication & Users

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create a new user account |
| POST | `/api/auth/login` | Log in with username and password |
| POST | `/api/auth/logout` | Destroy the session |
| GET | `/api/auth/me` | Get the current user's profile |
| PUT | `/api/auth/me` | Update user profile (base colour) |

### Teams

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/teams` | List the user's teams |
| POST | `/api/teams` | Create a new team |
| GET | `/api/teams/:id` | Get team details and members |
| PUT | `/api/teams/:id` | Update team capacity |
| POST | `/api/teams/:id/invite` | Create a member invitation |
| POST | `/api/teams/join/:token` | Join a team via invitation token |
| DELETE | `/api/teams/:id/members/:userId` | Remove a member from a team |

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List projects for a team |
| POST | `/api/projects` | Create a new project |
| PUT | `/api/projects/:id` | Update project name/description |
| DELETE | `/api/projects/:id` | Delete a project and all its data |
| POST | `/api/projects/:id/share` | Generate a public share token |
| DELETE | `/api/projects/:id/share` | Revoke a public share token |
| GET | `/api/share/:token` | Fetch read-only project data via share token |

### Gantt Entries

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/gantt/:projectId` | List all Gantt entries for a project |
| POST | `/api/gantt` | Create a new Gantt entry |
| PUT | `/api/gantt/:id` | Update a Gantt entry (including reparenting) |
| DELETE | `/api/gantt/:id` | Delete a Gantt entry |

### Dependencies

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dependencies/:projectId` | List all dependencies for a project |
| POST | `/api/dependencies` | Create a dependency between two entries |
| DELETE | `/api/dependencies/:id` | Delete a dependency |

### Todo Items

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/todos/:projectId` | List all todos for a project |
| POST | `/api/todos` | Create a new todo |
| PUT | `/api/todos/:id` | Update a todo |
| DELETE | `/api/todos/:id` | Delete a todo |

### Sync, Undo, Backup

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sync/:projectId` | Poll for changes since a timestamp |
| POST | `/api/undo/:projectId` | Undo the last action |
| GET | `/api/backup` | Download a full backup as JSON |
| POST | `/api/backup/import` | Import a backup JSON file |

### Admin & System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check endpoint |
| GET | `/api/version` | Get current app version |
| GET | `/api/admin/status` | Check admin status (has admin, is admin) |
| POST | `/api/admin/set` | Claim admin (first user) or add/remove admins |
| POST | `/api/update` | Upload a ZIP to update the application (admin only) |
| GET | `/api/github-releases` | List available GitHub releases |
| POST | `/api/update-from-github` | Install a release from GitHub (admin only) |

---

## 12. Database Schema

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| **users** | id, username, email, password_hash, base_color | User accounts |
| **teams** | id, name, owner_id, capacity_hours_month | Teams with capacity planning |
| **team_members** | team_id, user_id, role | Team membership (owner / member) |
| **invitations** | id, team_id, email, token, expires_at | Pending member invitations |
| **projects** | id, team_id, name, description, share_token | Projects under teams |
| **gantt_entries** | id, project_id, parent_id, title, start_date, end_date, hours_estimate, color_variation, subtract_hours | Gantt chart entries with hierarchy |
| **todo_items** | id, project_id, gantt_entry_id, title, status, assignee_id, due_date | Todo/Kanban items |
| **gantt_dependencies** | id, project_id, source_id, target_id | Task dependency arrows |
| **undo_history** | id, project_id, user_id, action_type, action_data | Undo stack |
| **app_settings** | key, value | Application settings (admin user IDs) |

---

## 13. Deployment Options

### PHP Shared Hosting

1. Upload the contents of the `public/` folder to your `public_html` directory.
2. Ensure PHP 7.3+ with `pdo_sqlite` extension is enabled.
3. The app auto-creates the SQLite database in `api/data/planner.db`.
4. Set `PHP_ROUTER = true` in `js/config.js` (default).

### Node.js Server

1. Run `npm install` to install dependencies.
2. Run `PORT=3002 node server.js` to start the server.
3. Set `PHP_ROUTER = false` and `API_BASE = ''` in `js/config.js` for direct API access.
4. WebSocket real-time sync is only available in this mode.

---

## 14. Frontend Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `API_BASE` | `'.'` | Relative API URL base. Use `''` for Node.js or a full URL for remote backends. |
| `PHP_ROUTER` | `true` | Routes API calls through `router.php?_route=` instead of clean URLs. |

---

## 15. Security Features

| Feature | Description |
|---------|-------------|
| **Password Hashing** | Bcrypt with cost factor 10. |
| **Session Management** | HTTP-only, SameSite cookies with 7-day expiry. |
| **CORS Support** | Configurable `CORS_ORIGIN` for split deployments with `SameSite=None; Secure`. |
| **Path Traversal Protection** | Update ZIP extraction rejects `..` in paths and validates `realpath()`. |
| **Protected Database** | Update process never overwrites the `api/data/` directory or the `sounds/` directory. |
| **Admin-Only Updates** | Application updates are restricted to admin users. |
| **SQL Injection Prevention** | All queries use prepared statements with parameterized inputs. |
| **Input Validation** | All API endpoints validate required fields and types. |
