'use strict';

// ==========================================================================
// UI Utilities – lightweight helpers with no state dependencies
// ==========================================================================

/**
 * Escape a string for safe insertion into HTML.
 */
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * Format an ISO date string as a short locale date (e.g. "Mar 22").
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Open the shared modal dialog.
 * @param {string}   title    - Modal heading text
 * @param {string}   bodyHtml - Trusted inner HTML for the modal body (callers are responsible for escaping user data with escHtml)
 * @param {Function} onOk     - Callback fired when the OK/Save button is clicked
 * @param {string}   [okLabel='Save'] - Label for the OK button
 */
function openModal(title, bodyHtml, onOk, okLabel = 'Save') {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalOk').textContent = okLabel;
  document.getElementById('modalOk').style.display = '';
  document.getElementById('modalOverlay').classList.remove('hidden');
  document.getElementById('modalOk').onclick = onOk;
  // Focus first input
  setTimeout(() => { document.querySelector('#modalBody input')?.focus(); }, 50);
}

/**
 * Close the shared modal dialog.
 */
function closeModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
}

/**
 * Show a context menu at the given viewport coordinates.
 * @param {number} x     - Left position (clientX / pageX)
 * @param {number} y     - Top position  (clientY / pageY)
 * @param {Array}  items - Menu item descriptors:
 *   { label, icon?, action, danger? } | { separator: true } | { label, icon?, children: [...] }
 *   Items with a `children` array render as a submenu that opens on hover.
 */
function showContextMenu(x, y, items) {
  const menu = document.getElementById('contextMenu');
  const list = document.getElementById('contextMenuList');
  list.innerHTML = '';

  function buildList(parentUl, itemList) {
    itemList.forEach(item => {
      if (!item) return;
      if (item.separator) {
        const li = document.createElement('li');
        li.className = 'separator';
        parentUl.appendChild(li);
        return;
      }
      const li = document.createElement('li');
      if (item.danger) li.classList.add('danger');

      if (item.children && item.children.length) {
        li.classList.add('has-submenu');
        const span = document.createElement('span');
        span.innerHTML = (item.icon ? item.icon + ' ' : '') + escHtml(item.label);
        li.appendChild(span);
        const arrow = document.createElement('span');
        arrow.className = 'submenu-arrow';
        arrow.textContent = '▶';
        li.appendChild(arrow);

        const sub = document.createElement('ul');
        sub.className = 'context-submenu';
        buildList(sub, item.children);
        li.appendChild(sub);

        let hideTimer;
        li.addEventListener('mouseenter', () => {
          clearTimeout(hideTimer);
          const liRect = li.getBoundingClientRect();
          sub.classList.toggle('submenu-left', liRect.right + 170 > window.innerWidth);
          sub.classList.add('open');
        });
        li.addEventListener('mouseleave', () => {
          hideTimer = setTimeout(() => sub.classList.remove('open'), 120);
        });
        sub.addEventListener('mouseenter', () => clearTimeout(hideTimer));
        sub.addEventListener('mouseleave', () => {
          hideTimer = setTimeout(() => sub.classList.remove('open'), 120);
        });
      } else {
        li.innerHTML = (item.icon ? item.icon + ' ' : '') + escHtml(item.label);
        li.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.classList.add('hidden');
          item.action();
        });
      }
      parentUl.appendChild(li);
    });
  }

  buildList(list, items);
  // Position off-screen first so the browser can compute dimensions
  menu.style.left = '-9999px';
  menu.style.top  = '-9999px';
  menu.classList.remove('hidden');
  const menuW = menu.offsetWidth  || 180;
  const menuH = menu.offsetHeight || 10;
  menu.style.left = Math.min(x, window.innerWidth  - menuW - 10) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - menuH - 10) + 'px';
}
