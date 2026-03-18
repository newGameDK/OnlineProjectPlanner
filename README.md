# OnlineProjectPlanner
This toolkit is a planning device, that me and my team can access through my webhotel, through different user accounts. We have full flexibility. 

## Deploying to a web hotel (shared hosting)

Upload the entire **`public/`** folder to your web host. The only requirement is
**PHP 7.4+** with the **PDO SQLite** extension (enabled by default on most hosts).

```
public/          ← upload this folder
├── index.html
├── app.html
├── share.html
├── css/
├── js/
└── api/         ← PHP backend (auto-creates the database on first use)
    ├── .htaccess
    ├── router.php
    └── db.php
```

The SQLite database is automatically created in `api/data/planner.db`. The
included `.htaccess` files handle URL routing (Apache) and protect the database
from direct download.

## Local development (Node.js)

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

### Local development (PHP)

If you don't have Node.js, you can use PHP's built-in server:

```bash
cd public
php -S localhost:8000
```

Then open **http://localhost:8000** in your browser.

> **Note:** Do not open `index.html` directly from the file system – the app
> needs a server (PHP or Node.js) to handle API requests.
