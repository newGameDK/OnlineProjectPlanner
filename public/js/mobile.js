'use strict';

// ==========================================================================
// OnlineProjectPlanner – Mobile Detection & Overlay Sidebar
//
// Detects Android / iOS via User-Agent, adds CSS classes to <html>:
//   html.is-mobile   – any recognised mobile device
//   html.is-ios      – iPhone / iPad / iPod
//   html.is-android  – Android device
//
// On mobile the sidebar becomes a slide-in overlay rather than a persistent
// column.  A semi-transparent backdrop is inserted behind it; tapping the
// backdrop (or selecting a project) closes the sidebar automatically.
// ==========================================================================

(function () {

  // ── Device detection ─────────────────────────────────────────────────────
  var ua = navigator.userAgent || navigator.vendor || '';
  var isIOS     = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  var isAndroid = /android/i.test(ua);
  var isMobile  = isIOS || isAndroid;

  if (isMobile)  document.documentElement.classList.add('is-mobile');
  if (isIOS)     document.documentElement.classList.add('is-ios');
  if (isAndroid) document.documentElement.classList.add('is-android');

  // Nothing more needed when not on a recognised mobile device.
  if (!isMobile) return;

  // ── Sidebar overlay ───────────────────────────────────────────────────────
  function initSidebar() {
    var sidebar       = document.getElementById('sidebar');
    var sidebarToggle = document.getElementById('sidebarToggle');
    if (!sidebar || !sidebarToggle) return;

    // Insert backdrop element (hidden by default via CSS).
    var backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);

    // Open / close helpers.
    function openSidebar() {
      sidebar.classList.add('open');
      backdrop.classList.add('visible');
    }
    function closeSidebar() {
      sidebar.classList.remove('open');
      backdrop.classList.remove('visible');
    }

    // The desktop sidebar toggle in app.js skips its handler when is-mobile
    // is present, so we only need to add our open/close logic here.
    sidebarToggle.addEventListener('click', function () {
      sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    });

    // Tapping the backdrop closes the sidebar.
    backdrop.addEventListener('click', closeSidebar);

    // Auto-close after the user taps a team or project in the sidebar.
    sidebar.addEventListener('click', function (e) {
      var item = e.target.closest('.sidebar-item');
      if (item) {
        // Small delay so the selection highlight is visible before sliding away.
        setTimeout(closeSidebar, 180);
      }
    });
  }

  // Run after the DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSidebar);
  } else {
    initSidebar();
  }

})();
