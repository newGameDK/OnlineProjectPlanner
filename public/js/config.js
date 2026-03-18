'use strict';

// ==========================================================================
// OnlineProjectPlanner – Frontend Configuration
// ==========================================================================
//
// API_BASE controls where the frontend sends API requests.
//
// '.'  → (default) Relative to the current page – works on both PHP shared
//         hosting (web hotel) and local Node.js development.
//
// ''   → Absolute from domain root (/api/...) – only works when the app is
//         served from the domain root by Node.js.
//
// 'https://my-server.example.com'
//       → Full URL of a remote backend server (split deployment).
// ==========================================================================

const API_BASE = '.';

// ==========================================================================
// PHP_ROUTER – direct PHP router mode
// ==========================================================================
//
// When true, API calls are sent to  api/router.php?_route=<path>  instead
// of relying on .htaccess mod_rewrite rules to map  /api/<path>  →
// router.php.  This is recommended for PHP shared hosting (web hotels)
// where mod_rewrite may be unavailable or misconfigured.
//
// When false (or when API_BASE points to a remote server), the frontend
// uses clean  /api/<path>  URLs that require either Node.js or working
// .htaccess rewrite rules.
// ==========================================================================

const PHP_ROUTER = true;

/**
 * Build the URL for an API call.
 *
 * @param {string} path  API path, e.g. '/api/health' or '/api/projects?team_id=abc'
 * @returns {string}     Full URL ready for fetch()
 */
function apiUrl(path) {
  // Only rewrite when PHP_ROUTER is on and we are using a local/relative backend
  if (PHP_ROUTER && (!API_BASE || API_BASE === '.')) {
    const qIdx     = path.indexOf('?');
    const pathname = qIdx === -1 ? path : path.substring(0, qIdx);
    const query    = qIdx === -1 ? ''   : path.substring(qIdx + 1);
    const route    = pathname.replace(/^\/api\//, '');
    let url        = API_BASE + '/api/router.php?_route=' + route;
    if (query) url += '&' + query;
    return url;
  }
  return API_BASE + path;
}
