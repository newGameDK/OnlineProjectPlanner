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
