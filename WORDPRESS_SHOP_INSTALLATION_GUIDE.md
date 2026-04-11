# WordPress Shop Distribution Guide (No Plugin Required)

This file is for the project admin to package and sell/distribute **OnlineProjectPlanner** through a WordPress shop (for example WooCommerce) as a **downloadable installation**, not as a WordPress plugin.

## 1) What you are distributing

Distribute a ZIP that contains the **contents of `public/`** (or a folder containing those same files), including:

- `index.html`, `app.html`, `share.html`, `version.json`
- `css/`
- `js/`
- `api/router.php`, `api/db.php`, `api/data/.htaccess`
- `.htaccess` (cache rules)

Do **not** include the repository root files for customer install (`server.js`, `package.json`, etc.) unless you are also selling a developer package.

## 2) Server requirements for customers

Customer hosting must support:

- PHP (recommended 7.4+)
- PDO + SQLite (`pdo_sqlite`)
- Write access to `api/data/`

This app is standalone and does not need to be installed as a WordPress plugin.

## 3) Build the install ZIP

From the repository root:

```bash
cd public
zip -r ../onlineprojectplanner-install.zip .
```

This creates an install ZIP with the correct structure for shared hosting and in-app updates.

## 4) Add to WordPress shop (WooCommerce example)

1. In WordPress admin, create a new product.
2. Mark it as **Virtual** and **Downloadable**.
3. Upload `onlineprojectplanner-install.zip` as the downloadable file.
4. Add short install notes in product description:
   - “Create a folder like `public_html/planner/` (or use root), then upload extracted files there.”
   - “Requires PHP + PDO SQLite.”
   - “Not a WordPress plugin; runs as a standalone web app.”

## 5) Customer installation steps (what buyers should do)

1. Download ZIP from your WordPress shop account.
2. Extract ZIP locally.
3. In hosting (cPanel/FTP), create a target folder if needed, for example `public_html/planner/`.
4. Upload extracted files into that folder so `index.html` is directly inside `planner/` (not inside an extra nested folder).
5. Verify backend health:
   - `https://their-domain.com/planner/api/router.php?_route=health`
   - Should return: `{"ok":true}`
6. If needed, run diagnostics:
   - `https://their-domain.com/planner/api/router.php?_route=diag`
7. Open:
   - `https://their-domain.com/planner/index.html`
8. Register first user account. Database is auto-created at first API use (`api/data/planner.db`).

## 6) Optional WordPress integration (still non-plugin)

If the buyer wants access from WordPress UI, they can:

- Create a WordPress page like “Project Planner”
- Add a normal link/button to `/planner/index.html`
- Or embed in an iframe if their setup allows it

The application remains a separate web app installation, not a plugin.

## 7) Updates you publish

For each new release:

1. Build a new ZIP from updated `public/` contents.
2. Replace the downloadable file in the WordPress product.
3. Tell customers to make a backup copy of `api/data/planner.db` before updating.
4. Tell customers to overwrite existing app files but keep `api/data/` (contains their database).
