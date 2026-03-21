'use strict';

// ==========================================================================
// OnlineProjectPlanner – Gantt Chart Module
//
// Features:
//  • Time-scaled ruler (day / week / month zoom)
//  • Drag bar body        → move entry (changes start + end together)
//  • Drag LEFT handle     → resize: changes start_date only
//  • Drag RIGHT handle    → resize: changes end_date only
//  • Dependency nodes     → output node (right edge, green ▶) + input node (left edge, blue ◀)
//      Click output node  → enter connecting mode; rubber-band SVG line follows mouse
//      Click input node   → finish connection and save to server
//      Click arrow        → delete dependency (with confirm)
//      Escape / Cancel    → abort connecting
//  • SVG bezier arrows overlaid on timeline rows
//  • Total-hours panel (right column) with recursive sums per visible entry
//  • Intensity bar (scheduled hours vs team capacity)
//  • Sub-chart drill-down on double-click (infinite nesting)
//  • Breadcrumb navigation back up the hierarchy
//  • Colour-coded bars: user base colour + 10 phase variations
//  • Selection (click / shift-click) + Delete key
// ==========================================================================

(function () {

  // ─── constants ────────────────────────────────────────────────────────────
  const ROW_H    = 40;  // px – must match CSS --row-h
  const MIN_DAYS = 1;   // minimum bar width in days
  const MIN_BEZIER_CP = 20; // minimum bezier control-point distance (px) for dep arrows

  // ─── state refs (injected from app.js) ───────────────────────────────────
  const S   = () => window.appState;
  const API = (m, u, b) => window.appAPI(m, u, b);
  const U   = () => window.appUtils;

  // ─── module state ─────────────────────────────────────────────────────────
  let parentStack     = [];   // breadcrumb: [{entry, label}, …]
  let currentParentId = null;
  let expandedIds     = new Set(); // inline-expanded entries (show children)
  let depsVisible     = true;  // whether dependency arrows are shown
  let taskListCollapsed = false; // whether the left task-name column is collapsed

  let scale    = 'week';
  let pxPerDay = 28;
  let chartStart = null;
  let chartEnd   = null;

  // rowIndexMap: entryId -> rowIndex (rebuilt on each render)
  let rowIndexMap = {};

  // ── clipboard state ────────────────────────────────────────────────────────
  let clipboardData = null; // { entries: [...], rootId, cut: bool }

  // ── timeline selection drag state ─────────────────────────────────────────
  const timelineSel = {
    active: false,
    startDay: 0,
    endDay: 0,
    mouseStartX: 0,
    overlayEl: null,
    rowTop: 0,       // top px of the row where drag started (single-row selection)
    rowIndex: -1,    // index of the row where drag started
  };

  // ── drag state ────────────────────────────────────────────────────────────
  const drag = {
    active: false,
    type: null,         // 'move' | 'resize-left' | 'resize-right'
    entryId: null,
    startX: 0,
    origStart: null,
    origEnd: null,
    containerEl: null,
    ghostEl: null,
    snappedDays: 0,
    origLeftPx: 0,      // original CSS left (px) for pixel-precise drag
    origWidthPx: 0,     // original CSS width (px)
  };

  // ── connecting state ──────────────────────────────────────────────────────
  const conn = {
    active: false,
    sourceId: null,
    tempLine: null,     // SVG <path> for rubber-band
    sx: 0,              // source x (right edge of bar)
    sy: 0,              // source y (vertical centre of row)
  };

  // ── reparent drag state ────────────────────────────────────────────────────
  const reparentDrag = {
    active: false,
    entryId: null,
    startY: 0,
    dragEl: null,                 // floating ghost element
    dropMode: null,               // 'before' | 'after' | 'onto' | null
    dropTargetId: null,           // id of the row we'd insert relative to
    dropIndicatorEl: null,        // horizontal line shown in task list
    dropIndicatorTimelineEl: null, // matching horizontal line shown in timeline rows
  };

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  let ganttTaskList, ganttRows, ganttRuler, ganttBreadcrumb,
      ganttTimeline, intensityBarCanvas, intensityBarWrapper, ganttHoursPanel;


  /**
   * Get the display colour for an entry.  When inline-expanded (depth > 0)
   * the colour is derived from the root visible ancestor, lightened by depth.
   */
  function getEntryColor(entry) {
    const depth = entry._depth || 0;
    if (depth > 0 && entry.parent_id) {
      // Walk up to the visible root ancestor (depth 0) to get the base colour.
      let ancestor = entry;
      while (ancestor.parent_id && (ancestor._depth || 0) > 0) {
        const parent = S().ganttEntries.find(e => e.id === ancestor.parent_id);
        if (!parent) break;
        ancestor = parent;
      }
      const baseColor = U().getUserColor(ancestor.user_id, ancestor.color_variation);
      return U().lightenColor(baseColor, depth * 0.15);
    }
    return U().getUserColor(entry.user_id, entry.color_variation);
  }

  /**
   * Ensure a URL has a protocol scheme so it is not treated as a relative path.
   */
  function ensureAbsoluteUrl(url) {
    if (!url) return url;
    if (/^https?:\/\//i.test(url) || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
    return 'https://' + url;
  }

  function zoomIn()  { pxPerDay = Math.min(pxPerDay * 1.4, 200); autoScale(); render(); }
  function zoomOut() { pxPerDay = Math.max(pxPerDay / 1.4, minPxPerDayForFit()); autoScale(); render(); }

  function editSelected() {
    const id = S().selectedGanttIds.size > 0 ? [...S().selectedGanttIds][0] : null;
    if (!id) return;
    const entry = S().ganttEntries.find(e => e.id === id);
    if (entry) showEditEntryModal(entry);
  }

  // =========================================================================
  // Public API
  // =========================================================================
  window.ganttModule = { init, render, showAddEntryModal, copySelected, pasteAtDate, zoomIn, zoomOut, editSelected };

  // ── Help mode toggle (attached once, outside init) ────────────────────────
  (function attachHelpToggle() {
    const helpBtn = document.getElementById('helpModeBtn');
    if (helpBtn) {
      helpBtn.addEventListener('click', () => {
        document.body.classList.toggle('help-mode');
        helpBtn.classList.toggle('active');
      });
    }
  })();

  // =========================================================================
  // Init
  // =========================================================================
  function init() {
    ganttTaskList       = document.getElementById('ganttTaskList');
    ganttRows           = document.getElementById('ganttRows');
    ganttRuler          = document.getElementById('ganttRuler');
    ganttBreadcrumb     = document.getElementById('ganttBreadcrumb');
    ganttTimeline       = document.getElementById('ganttTimeline');
    intensityBarCanvas  = document.getElementById('intensityBarCanvas');
    intensityBarWrapper = document.getElementById('intensityBarWrapper');
    ganttHoursPanel     = document.getElementById('ganttHoursPanel');

    document.getElementById('zoomInBtn').addEventListener('click', () => {
      pxPerDay = Math.min(pxPerDay * 1.04, 200); autoScale(); render();
    });
    document.getElementById('zoomOutBtn').addEventListener('click', () => {
      pxPerDay = Math.max(pxPerDay / 1.04, minPxPerDayForFit()); autoScale(); render();
    });
    document.getElementById('chartStartDate').addEventListener('change', (e) => {
      if (e.target.value) chartStart = new Date(e.target.value + 'T00:00:00');
      render();
    });
    document.getElementById('chartEndDate').addEventListener('change', (e) => {
      if (e.target.value) chartEnd = new Date(e.target.value + 'T00:00:00');
      render();
    });

    // 3-way scroll sync: task list ↔ timeline rows ↔ hours panel.
    // A sync-lock prevents cascading scroll events when we set scrollTop
    // programmatically (setting scrollTop to its current value is a no-op).
    let _scrollSyncing = false;
    ganttTaskList.addEventListener('scroll', () => {
      if (_scrollSyncing) return;
      _scrollSyncing = true;
      ganttTimeline.scrollTop = ganttTaskList.scrollTop;
      ganttHoursPanel.scrollTop = ganttTaskList.scrollTop;
      _scrollSyncing = false;
    });
    ganttHoursPanel.addEventListener('scroll', () => {
      if (_scrollSyncing) return;
      _scrollSyncing = true;
      ganttTaskList.scrollTop = ganttHoursPanel.scrollTop;
      ganttTimeline.scrollTop = ganttHoursPanel.scrollTop;
      _scrollSyncing = false;
    });
    ganttTimeline.addEventListener('scroll', () => {
      syncIntensityScroll();
      syncRulerScroll();
      if (_scrollSyncing) return;
      _scrollSyncing = true;
      ganttTaskList.scrollTop = ganttTimeline.scrollTop;
      ganttHoursPanel.scrollTop = ganttTimeline.scrollTop;
      _scrollSyncing = false;
    });

    // Scroll-wheel: horizontal two-finger swipe pans the timeline at 1/3 speed;
    // vertical scroll zooms toward the cursor position. Both components are
    // handled independently so a slightly diagonal swipe pans correctly instead
    // of accidentally zooming.
    const wheelZoom = (e) => {
      e.preventDefault();
      // Any horizontal component → pan the timeline at 1/3 speed
      if (e.deltaX !== 0) {
        ganttTimeline.scrollLeft += e.deltaX / 3;
      }
      // Vertical component only when the gesture is not primarily horizontal → zoom.
      if (e.deltaY !== 0 && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        // Cursor position relative to the timeline content (in "day" units)
        const rect     = ganttTimeline.getBoundingClientRect();
        const cursorX  = e.clientX - rect.left;           // px within visible area
        const contentX = ganttTimeline.scrollLeft + cursorX; // px within content
        const dayAtCursor = contentX / pxPerDay;

        const oldPx = pxPerDay;
        if (e.deltaY < 0) {
          pxPerDay = Math.min(pxPerDay * 1.04, 200);
        } else {
          pxPerDay = Math.max(pxPerDay / 1.04, minPxPerDayForFit());
        }
        if (pxPerDay !== oldPx) {
          autoScale();
          // Keep the same day under the cursor after the scale change
          ganttTimeline.scrollLeft = dayAtCursor * pxPerDay - cursorX;
          render();
        }
      }
    };
    ganttTimeline.addEventListener('wheel', wheelZoom, { passive: false });
    if (ganttRuler) ganttRuler.addEventListener('wheel', wheelZoom, { passive: false });
    if (intensityBarWrapper) intensityBarWrapper.addEventListener('wheel', wheelZoom, { passive: false });

    // Global mouse/key events
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (conn.active) { cancelConnecting(); return; }
        if (timelineSel.overlayEl) { clearTimelineSelection(); return; }
        // Go back one drill-down level
        if (parentStack.length && !document.querySelector('.modal.show')) {
          parentStack.pop();
          currentParentId = parentStack.length ? parentStack[parentStack.length - 1].entry.id : null;
          render();
        }
      }
    });

    const cancelBtn = document.getElementById('cancelConnecting');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelConnecting);

    // Cancel connecting by clicking empty timeline space
    ganttTimeline.addEventListener('click', (e) => {
      if (conn.active) {
        if (!e.target.closest('.gantt-bar-container')) cancelConnecting();
        return;
      }
      // Clear date-range selection when clicking on an empty spot
      if (!e.target.closest('.gantt-bar-container') && !e.target.closest('.gantt-time-selection')) {
        clearTimelineSelection();
      }
    });

    // Cancel connecting by clicking empty space in task list
    ganttTaskList.addEventListener('click', (e) => {
      if (!conn.active) return;
      if (!e.target.closest('.gantt-task-row')) cancelConnecting();
    });

    // Cancel connecting on right-click anywhere
    document.addEventListener('contextmenu', (e) => {
      if (conn.active) { e.preventDefault(); cancelConnecting(); }
    });

    // Toggle dependency arrows button
    const toggleDepsBtn = document.getElementById('toggleDepsBtn');
    if (toggleDepsBtn) {
      ganttTimeline.classList.toggle('deps-hidden', !depsVisible);
      toggleDepsBtn.classList.toggle('active', depsVisible);
      toggleDepsBtn.addEventListener('click', () => {
        depsVisible = !depsVisible;
        toggleDepsBtn.classList.toggle('active', depsVisible);
        ganttTimeline.classList.toggle('deps-hidden', !depsVisible);
        render();
      });
    }

    parentStack     = [];
    currentParentId = null;
    chartStart      = null;
    chartEnd        = null;

    autoScale();

    // --- Set up task-list header: collapse toggle + add button ---
    const tasksHeader = document.querySelector('.gantt-tasks-header');
    if (tasksHeader) {
      tasksHeader.innerHTML = '';

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'gantt-tasks-toggle';
      toggleBtn.textContent = '\u25C0'; // ◀
      toggleBtn.title = 'Collapse task list';
      toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleTaskList(); });
      tasksHeader.appendChild(toggleBtn);

      const label = document.createElement('span');
      label.className = 'gantt-tasks-header-label';
      label.textContent = 'Task';
      tasksHeader.appendChild(label);

      const addBtn = document.createElement('button');
      addBtn.className = 'gantt-tasks-add-btn';
      addBtn.textContent = '+';
      addBtn.title = 'Add new task (N)';
      addBtn.setAttribute('data-help', 'Add a new task (keyboard shortcut: N)');
      addBtn.addEventListener('click', (e) => { e.stopPropagation(); showAddEntryModal(); });
      tasksHeader.appendChild(addBtn);
    }

    // Move breadcrumb above the gantt container for better visibility
    const ganttContainer = document.getElementById('ganttContainer');
    if (ganttBreadcrumb && ganttContainer && ganttContainer.parentNode) {
      ganttContainer.parentNode.insertBefore(ganttBreadcrumb, ganttContainer);
    }

    // Right-click on empty timeline space → add task at clicked date
    ganttTimeline.addEventListener('contextmenu', onTimelineContextMenu);

    // Left-button drag on empty timeline → date-range selection (single row)
    ganttTimeline.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (conn.active || drag.active) return;
      if (e.target.closest('.gantt-bar-container') || e.target.closest('.gantt-bar')) return;

      // Clear any existing selection
      clearTimelineSelection();

      const rect = ganttTimeline.getBoundingClientRect();
      const x    = e.clientX - rect.left + ganttTimeline.scrollLeft;
      const y    = e.clientY - rect.top  + ganttTimeline.scrollTop;
      const day  = Math.floor(x / pxPerDay);
      // Clamp row index to [0, numVisibleRows-1] so clicks below the last row
      // are handled gracefully.
      const numRows  = ganttRows.querySelectorAll('.gantt-row-bg').length;
      const maxRow   = Math.max(0, numRows - 1);
      const rowIndex = Math.min(maxRow, Math.max(0, Math.floor(y / ROW_H)));
      const rowTop   = rowIndex * ROW_H;

      timelineSel.active      = true;
      timelineSel.startDay    = day;
      timelineSel.endDay      = day;
      timelineSel.mouseStartX = e.pageX;
      timelineSel.rowTop      = rowTop;
      timelineSel.rowIndex    = rowIndex;

      const overlay = document.createElement('div');
      overlay.className = 'gantt-time-selection';
      overlay.style.cssText = 'left:' + (day * pxPerDay) + 'px;width:' + pxPerDay + 'px;' +
                               'top:' + rowTop + 'px;height:' + ROW_H + 'px;';
      ganttRows.appendChild(overlay);
      timelineSel.overlayEl = overlay;
    });

    render();
  }

  function clearTimelineSelection() {
    if (timelineSel.overlayEl && timelineSel.overlayEl.parentNode) {
      timelineSel.overlayEl.parentNode.removeChild(timelineSel.overlayEl);
    }
    timelineSel.active    = false;
    timelineSel.overlayEl = null;
  }

  function autoScale() {
    if (pxPerDay >= 40)      scale = 'day';
    else if (pxPerDay >= 14) scale = 'week';
    else                     scale = 'month';
  }

  // ── Collapsible task-list column ──────────────────────────────────────────
  function toggleTaskList() {
    taskListCollapsed = !taskListCollapsed;
    const container = document.getElementById('ganttContainer');
    container.classList.toggle('task-list-collapsed', taskListCollapsed);

    const toggleBtn = container.querySelector('.gantt-tasks-toggle');
    if (toggleBtn) {
      toggleBtn.textContent = taskListCollapsed ? '\u25B6' : '\u25C0'; // ▶ or ◀
      toggleBtn.title       = taskListCollapsed ? 'Expand task list' : 'Collapse task list';
    }
  }

  // ── Right-click on empty timeline → add task at clicked date ─────────────
  function onTimelineContextMenu(e) {
    if (conn.active) return;
    if (e.target.closest('.gantt-bar-container') || e.target.closest('.gantt-bar')) return;

    e.preventDefault();

    const rect      = ganttTimeline.getBoundingClientRect();
    const x         = e.clientX - rect.left + ganttTimeline.scrollLeft;
    const dayOffset = Math.floor(x / pxPerDay);
    const clickDate = addDays(chartStart, dayOffset);
    const dateStr   = toDateStr(clickDate);

    const items = [];

    // If a range selection is active, offer to add a task spanning that range
    if (timelineSel.overlayEl) {
      const selStart = Math.min(timelineSel.startDay, timelineSel.endDay);
      const selEnd   = Math.max(timelineSel.startDay, timelineSel.endDay);
      const selStartStr = toDateStr(addDays(chartStart, selStart));
      const selEndStr   = toDateStr(addDays(chartStart, selEnd + 1));
      items.push({ icon: '+', label: 'Add task for selection (' + selStartStr + ' – ' + selEndStr + ')',
        action: () => { clearTimelineSelection(); showAddEntryModal(undefined, selStartStr, selEndStr); } });
      items.push({ separator: true });
    }

    items.push({ icon: '+', label: 'Add task here (' + dateStr + ')',
      action: () => showAddEntryModal(undefined, dateStr, toDateStr(addDays(clickDate, 7))) });

    if (clipboardData) {
      items.push({ icon: '📋', label: 'Paste task here',
        action: () => pasteEntries(dateStr) });
    }

    U().showContextMenu(e.pageX, e.pageY, items);
  }

  // =========================================================================
  // Render
  // =========================================================================
  function render() {
    if (!S().currentProject) return;

    const entries   = visibleEntries();
    autoSetChartRange(entries);

    const totalDays = Math.max(1, daysBetween(chartStart, chartEnd));
    const timelineW = totalDays * pxPerDay;

    document.getElementById('chartStartDate').value = toDateStr(chartStart);
    document.getElementById('chartEndDate').value   = toDateStr(chartEnd);

    // Rebuild row-index map
    rowIndexMap = {};
    entries.forEach((e, i) => { rowIndexMap[e.id] = i; });

    renderTaskList(entries);
    renderRuler(timelineW, totalDays);
    renderRowsAndBars(entries, timelineW);
    renderDependencyArrows(entries, timelineW);
    renderIntensityBar(timelineW, totalDays);
    renderHoursPanel(entries);
    renderBreadcrumb();
  }

  // ─── task list (left column) ──────────────────────────────────────────────
  function renderTaskList(entries) {
    ganttTaskList.innerHTML = '';
    entries.forEach(entry => {
      const hasChildren = S().ganttEntries.some(e => e.parent_id === entry.id);
      const depth = entry._depth || 0;
      const color = getEntryColor(entry);
      const linkedTodo = S().todos.find(t => t.gantt_entry_id === entry.id);
      const isCompleted = linkedTodo && linkedTodo.status === 'done';

      const row = document.createElement('div');
      row.className = 'gantt-task-row'
        + (S().selectedGanttIds.has(entry.id) ? ' selected' : '')
        + (isCompleted ? ' gantt-completed' : '');
      row.dataset.id = entry.id;

      // Drag handle for reparenting / reordering
      const grip = document.createElement('span');
      grip.className = 'gantt-task-grip';
      grip.textContent = '\u2261';  // ≡
      grip.title = 'Drag to reorder or move under another task';
      grip.setAttribute('aria-label', 'Drag to reorder or move under another task');
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startReparentDrag(e, entry, row);
      });
      row.appendChild(grip);

      // Indent placeholder
      const ind = document.createElement('span');
      ind.className = 'gantt-task-indent';
      ind.style.width = (depth * 16) + 'px';
      row.appendChild(ind);

      // Expand indicator
      const isExpanded = expandedIds.has(entry.id);
      const exp = document.createElement('span');
      if (hasChildren) {
        exp.className = 'gantt-task-expand' + (isExpanded ? ' expanded' : '');
        exp.textContent = isExpanded ? '\u25BC' : '\u25B6';
        exp.title = isExpanded ? 'Collapse sub-entries' : 'Expand sub-entries (double-click to drill down)';
        exp.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isExpanded) { expandedIds.delete(entry.id); } else { expandedIds.add(entry.id); }
          render();
        });
      } else {
        exp.style.cssText = 'width:16px;display:inline-block;flex-shrink:0';
      }
      row.appendChild(exp);

      // Colour dot
      const dot = document.createElement('span');
      dot.className = 'gantt-task-color-dot';
      dot.style.background = color;
      row.appendChild(dot);

      // Completed checkmark (shown when linked todo is 'done')
      if (isCompleted) {
        const check = document.createElement('span');
        check.className = 'gantt-completed-check';
        check.textContent = '\u2713'; // ✓
        check.title = 'Task completed';
        row.appendChild(check);
      }

      // Name
      const name = document.createElement('span');
      name.className = 'gantt-task-name';
      name.textContent = entry.title;
      name.title = entry.title + (entry.notes ? '\n\n' + entry.notes : '');
      row.appendChild(name);

      // Persistent folder-link icon (always visible when URL is set)
      if (entry.folder_url) {
        const folderLink = document.createElement('a');
        folderLink.className = 'gantt-folder-link';
        folderLink.href      = ensureAbsoluteUrl(entry.folder_url);
        folderLink.target    = '_blank';
        folderLink.rel       = 'noopener noreferrer';
        folderLink.title     = 'Open folder: ' + entry.folder_url;
        folderLink.textContent = '\uD83D\uDCC2';
        folderLink.addEventListener('click', (e) => e.stopPropagation());
        row.appendChild(folderLink);
      }

      // Action buttons (visible on hover)
      const actions = document.createElement('div');
      actions.className = 'gantt-task-actions';
      actions.appendChild(makeBtn('\u270F', 'Edit',         () => showEditEntryModal(entry)));

      const hasTodo = S().todos.some(t => t.gantt_entry_id === entry.id);
      const todoBtn = makeBtn(hasTodo ? '\u2713' : '\u2611', 'Add to Todo', () => { if (!hasTodo) addToTodo(entry); });
      if (hasTodo) { todoBtn.style.color = '#2e7d32'; todoBtn.title = 'Already in Todo list'; }
      actions.appendChild(todoBtn);

      actions.appendChild(makeBtn('+',      'Add sub-task', () => showAddEntryModal(entry.id)));
      actions.appendChild(makeBtn('\uD83D\uDDD1', 'Delete', () => deleteEntry(entry)));
      row.appendChild(actions);

      // Selection / connecting
      row.addEventListener('click', (e) => {
        // When in connecting mode, clicking a task list row finishes the connection
        if (conn.active) {
          if (conn.sourceId !== entry.id) {
            e.stopPropagation();
            finishConnecting(entry);
          }
          return;
        }
        if (e.shiftKey) {
          S().selectedGanttIds.has(entry.id)
            ? S().selectedGanttIds.delete(entry.id)
            : S().selectedGanttIds.add(entry.id);
        } else {
          S().selectedGanttIds.clear();
          S().selectedGanttIds.add(entry.id);
        }
        U().updateDeleteBtn();
        render();
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // contextmenu is handled globally when connecting; skip here
        if (conn.active) return;
        showEntryContextMenu(e.pageX, e.pageY, entry);
      });

      ganttTaskList.appendChild(row);
    });
  }

  function makeBtn(icon, title, fn) {
    const b = document.createElement('button');
    b.className = 'gantt-task-action-btn';
    b.textContent = icon;
    b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  // ─── reparent / reorder drag-and-drop ────────────────────────────────────
  function startReparentDrag(e, entry, rowEl) {
    reparentDrag.active  = true;
    reparentDrag.entryId = entry.id;
    reparentDrag.startY  = e.clientY;
    reparentDrag.dropMode = null;
    reparentDrag.dropTargetId = null;
    reparentDrag.dropIndicatorEl = null;

    // Create floating ghost
    const ghost = rowEl.cloneNode(true);
    ghost.className = 'gantt-task-row reparent-ghost';
    ghost.style.width = rowEl.offsetWidth + 'px';
    ghost.style.left  = rowEl.getBoundingClientRect().left + 'px';
    ghost.style.top   = e.clientY - ROW_H / 2 + 'px';
    document.body.appendChild(ghost);
    reparentDrag.dragEl = ghost;

    document.body.style.cursor     = 'grabbing';
    document.body.style.userSelect = 'none';

    document.addEventListener('mousemove', onReparentMove);
    document.addEventListener('mouseup', onReparentUp);
  }

  function _clearReparentFeedback() {
    const rows = ganttTaskList.querySelectorAll('.gantt-task-row');
    rows.forEach(r => r.classList.remove('reparent-target', 'reparent-root-target'));
    ganttTaskList.classList.remove('reparent-root-target');
    if (reparentDrag.dropIndicatorEl) {
      reparentDrag.dropIndicatorEl.remove();
      reparentDrag.dropIndicatorEl = null;
    }
    if (reparentDrag.dropIndicatorTimelineEl) {
      reparentDrag.dropIndicatorTimelineEl.remove();
      reparentDrag.dropIndicatorTimelineEl = null;
    }
    reparentDrag.dropMode = null;
    reparentDrag.dropTargetId = null;
  }

  function onReparentMove(e) {
    if (!reparentDrag.active) return;

    // Move ghost
    reparentDrag.dragEl.style.top = (e.clientY - ROW_H / 2) + 'px';

    _clearReparentFeedback();

    const allRows = [...ganttTaskList.querySelectorAll('.gantt-task-row')];
    if (!allRows.length) return;

    const listRect  = ganttTaskList.getBoundingClientRect();
    const scrollTop = ganttTaskList.scrollTop;
    const rowsRect  = ganttRows.getBoundingClientRect();

    // Add a matching drop indicator in the timeline (ganttRows) area.
    function _addTimelineIndicator(targetId) {
      const rowBgEl = ganttRows.querySelector(`.gantt-row-bg[data-id="${targetId}"]`);
      if (!rowBgEl) return;
      const bgRect = rowBgEl.getBoundingClientRect();
      const tInd = document.createElement('div');
      tInd.className = 'reorder-drop-indicator';
      tInd.style.top = (bgRect.top - rowsRect.top + ganttTimeline.scrollTop) + 'px';
      ganttRows.appendChild(tInd);
      reparentDrag.dropIndicatorTimelineEl = tInd;
    }

    // Add a bottom-edge indicator in the timeline for the last row.
    function _addTimelineIndicatorBottom(targetId) {
      const rowBgEl = ganttRows.querySelector(`.gantt-row-bg[data-id="${targetId}"]`);
      if (!rowBgEl) return;
      const bgRect = rowBgEl.getBoundingClientRect();
      const tInd = document.createElement('div');
      tInd.className = 'reorder-drop-indicator';
      tInd.style.top = (bgRect.bottom - rowsRect.top + ganttTimeline.scrollTop) + 'px';
      ganttRows.appendChild(tInd);
      reparentDrag.dropIndicatorTimelineEl = tInd;
    }

    // Determine which row the cursor is near and whether we're in the gap
    // between rows (reorder) or in the middle of a row (reparent).
    let matched = false;
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      if (row.dataset.id === reparentDrag.entryId) continue;
      const rect = row.getBoundingClientRect();
      const threshold = rect.height * 0.3; // top/bottom 30% = reorder zone

      if (e.clientY < rect.top + threshold) {
        // Drop BEFORE this row (reorder)
        reparentDrag.dropMode     = 'before';
        reparentDrag.dropTargetId = row.dataset.id;
        const indY = rect.top - listRect.top + scrollTop;
        const ind = document.createElement('div');
        ind.className = 'reorder-drop-indicator';
        ind.style.top = indY + 'px';
        ganttTaskList.appendChild(ind);
        reparentDrag.dropIndicatorEl = ind;
        _addTimelineIndicator(row.dataset.id);
        matched = true;
        break;
      } else if (e.clientY <= rect.bottom - threshold) {
        // Drop ONTO this row (reparent to it)
        reparentDrag.dropMode     = 'onto';
        reparentDrag.dropTargetId = row.dataset.id;
        row.classList.add('reparent-target');
        matched = true;
        break;
      }
      // else: cursor is in the bottom 30% of this row → check next row's top
    }

    if (!matched) {
      // Cursor is below all rows → insert at end (reorder after last row)
      const lastRow = allRows[allRows.length - 1];
      if (lastRow && lastRow.dataset.id !== reparentDrag.entryId) {
        reparentDrag.dropMode     = 'after';
        reparentDrag.dropTargetId = lastRow.dataset.id;
        const rect = lastRow.getBoundingClientRect();
        const indY = rect.bottom - listRect.top + scrollTop;
        const ind = document.createElement('div');
        ind.className = 'reorder-drop-indicator';
        ind.style.top = indY + 'px';
        ganttTaskList.appendChild(ind);
        reparentDrag.dropIndicatorEl = ind;
        _addTimelineIndicatorBottom(lastRow.dataset.id);
      } else if (ganttTaskList.contains(document.elementFromPoint(e.clientX, e.clientY))) {
        ganttTaskList.classList.add('reparent-root-target');
        reparentDrag.dropMode = 'root';
      }
    }
  }

  async function onReparentUp(e) {
    document.removeEventListener('mousemove', onReparentMove);
    document.removeEventListener('mouseup', onReparentUp);

    if (!reparentDrag.active) return;

    // Cleanup
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    if (reparentDrag.dragEl) {
      reparentDrag.dragEl.remove();
      reparentDrag.dragEl = null;
    }

    const dropMode     = reparentDrag.dropMode;
    const dropTargetId = reparentDrag.dropTargetId;
    const entryId      = reparentDrag.entryId;

    _clearReparentFeedback();

    reparentDrag.active  = false;
    reparentDrag.entryId = null;

    if (!dropMode) return; // dropped outside
    if (!dropTargetId && dropMode !== 'root') return;

    if (dropMode === 'before' || dropMode === 'after') {
      // ── Reorder / cross-level move ────────────────────────────────────────
      const movedEntry  = S().ganttEntries.find(e => e.id === entryId);
      const targetEntry = S().ganttEntries.find(e => e.id === dropTargetId);
      if (movedEntry && targetEntry && movedEntry.parent_id !== targetEntry.parent_id) {
        // Moving across levels: reparent first so reorderEntries can proceed
        const newParentId = targetEntry.parent_id || null;
        // Prevent circular reparenting
        if (newParentId === entryId) return;
        const childrenOf = {};
        S().ganttEntries.forEach(en => {
          const pid = en.parent_id || '__root__';
          if (!childrenOf[pid]) childrenOf[pid] = [];
          childrenOf[pid].push(en);
        });
        const isDescendant = (tId, ancestorId) => {
          const kids = childrenOf[ancestorId] || [];
          for (const child of kids) {
            if (child.id === tId) return true;
            if (isDescendant(tId, child.id)) return true;
          }
          return false;
        };
        if (isDescendant(newParentId, entryId)) return;
        try {
          const updated = await API('PUT', '/api/gantt/' + entryId, { parent_id: newParentId });
          const idx = S().ganttEntries.findIndex(x => x.id === entryId);
          if (idx !== -1) S().ganttEntries[idx] = updated.entry;
          if (newParentId) expandedIds.add(newParentId);
        } catch (err) {
          console.error('Reparent failed:', err);
          render();
          return;
        }
      }
      await reorderEntries(entryId, dropTargetId, dropMode === 'before');
    } else if (dropMode === 'onto') {
      // ── Reparent: change parent_id ────────────────────────────────────────
      if (dropTargetId === entryId) return;

      const entry = S().ganttEntries.find(x => x.id === entryId);
      if (!entry) return;

      const newParentId = dropTargetId;
      if (entry.parent_id === newParentId) return;

      // Prevent circular reparenting
      const childrenOf = {};
      S().ganttEntries.forEach(en => {
        const pid = en.parent_id || '__root__';
        if (!childrenOf[pid]) childrenOf[pid] = [];
        childrenOf[pid].push(en);
      });
      const isDescendant = (targetId, ancestorId) => {
        const kids = childrenOf[ancestorId] || [];
        for (const child of kids) {
          if (child.id === targetId) return true;
          if (isDescendant(targetId, child.id)) return true;
        }
        return false;
      };
      if (newParentId === entryId || isDescendant(newParentId, entryId)) return;

      try {
        const updated = await API('PUT', '/api/gantt/' + entryId, { parent_id: newParentId });
        const idx = S().ganttEntries.findIndex(x => x.id === entryId);
        if (idx !== -1) S().ganttEntries[idx] = updated.entry;
        if (newParentId && newParentId !== currentParentId) {
          expandedIds.add(newParentId);
        }
        U().updateUndoRedoBtns?.();
      } catch (err) {
        console.error('Reparent failed:', err);
      }
      render();
    } else if (dropMode === 'root') {
      // ── Promote to root (or current drill-down level) ─────────────────────
      const entry = S().ganttEntries.find(x => x.id === entryId);
      if (!entry) return;
      const newParentId = currentParentId || null;
      if (entry.parent_id === newParentId) return;
      try {
        const updated = await API('PUT', '/api/gantt/' + entryId, { parent_id: newParentId });
        const idx = S().ganttEntries.findIndex(x => x.id === entryId);
        if (idx !== -1) S().ganttEntries[idx] = updated.entry;
        U().updateUndoRedoBtns?.();
      } catch (err) {
        console.error('Reparent to root failed:', err);
      }
      render();
    }
  }

  /**
   * Reorder entries: move `movedId` to be immediately before or after `targetId`.
   * Only entries sharing the same parent as `movedId` are re-positioned.
   */
  async function reorderEntries(movedId, targetId, insertBefore) {
    const all = S().ganttEntries;
    const movedEntry = all.find(e => e.id === movedId);
    if (!movedEntry) return;

    const parentId = movedEntry.parent_id;
    // Siblings: same parent, sorted by current position then created_at
    let siblings = all
      .filter(e => e.parent_id === parentId)
      .sort((a, b) => (a.position - b.position) || (a.created_at > b.created_at ? 1 : -1));

    // Check target shares the same parent (drop across different levels = no-op)
    const targetEntry = all.find(e => e.id === targetId);
    if (!targetEntry || targetEntry.parent_id !== parentId) return;

    // Remove moved entry from its current position
    siblings = siblings.filter(e => e.id !== movedId);

    // Insert moved entry at the correct position
    const targetIdx = siblings.findIndex(e => e.id === targetId);
    if (targetIdx === -1) return;
    const insertIdx = insertBefore ? targetIdx : targetIdx + 1;
    siblings.splice(insertIdx, 0, movedEntry);

    // Assign clean sequential positions
    const positions = siblings.map((e, i) => ({ id: e.id, position: i }));

    // Check if the order actually changed
    const anyChanged = positions.some(p => {
      const entry = all.find(e => e.id === p.id);
      return entry && entry.position !== p.position;
    });
    if (!anyChanged) return;

    try {
      const result = await API('POST', '/api/gantt/' + S().currentProject.id + '/reorder', { positions });
      result.entries.forEach(updated => {
        const idx = S().ganttEntries.findIndex(e => e.id === updated.id);
        if (idx !== -1) S().ganttEntries[idx].position = updated.position;
      });
      U().updateUndoRedoBtns?.();
    } catch (err) {
      console.error('Reorder failed:', err);
    }
    render();
  }

  /** Returns siblings of `entry` (same parent_id) sorted by position then created_at. */
  function getSortedSiblings(entry) {
    return S().ganttEntries
      .filter(e => e.parent_id === entry.parent_id)
      .sort((a, b) => (a.position - b.position) || (a.created_at > b.created_at ? 1 : -1));
  }

  /**
   * Shared implementation for move-up / move-down.
   * `delta` is -1 for up, +1 for down.
   */
  async function moveEntryByDelta(entry, delta) {
    const siblings = getSortedSiblings(entry);
    const idx = siblings.findIndex(e => e.id === entry.id);
    const swapIdx = idx + delta;
    if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return;
    const positions = siblings.map((e, i) => ({ id: e.id, position: i }));
    positions[idx].position = swapIdx;
    positions[swapIdx].position = idx;
    try {
      const result = await API('POST', '/api/gantt/' + S().currentProject.id + '/reorder', { positions });
      result.entries.forEach(updated => {
        const i = S().ganttEntries.findIndex(e => e.id === updated.id);
        if (i !== -1) S().ganttEntries[i].position = updated.position;
      });
      U().updateUndoRedoBtns?.();
    } catch (err) {
      console.error('Move ' + (delta < 0 ? 'up' : 'down') + ' failed:', err);
    }
    render();
  }

  /** Move an entry one position up among its siblings. */
  function moveEntryUp(entry)   { return moveEntryByDelta(entry, -1); }

  /** Move an entry one position down among its siblings. */
  function moveEntryDown(entry) { return moveEntryByDelta(entry, +1); }

  // ─── ruler ────────────────────────────────────────────────────────────────
  function renderRuler(timelineW, totalDays) {
    ganttRuler.style.width    = timelineW + 'px';
    ganttRuler.style.position = 'relative';
    ganttRuler.innerHTML      = '';

    const today = new Date(); today.setHours(0, 0, 0, 0);

    if (scale === 'day') {
      forEachDay(chartStart, chartEnd, (d, i) => {
        ganttRuler.appendChild(makeRulerCell(
          i * pxPerDay, pxPerDay, formatDay(d), d.getDay() === 1 ? 'major' : ''
        ));
      });
    } else if (scale === 'week') {
      forEachDay(chartStart, chartEnd, (d, i) => {
        if (d.getDay() === 1 || i === 0) {
          // Calculate days until next Monday (or end of chart) for proper cell width
          const daysLeft = daysBetween(d, chartEnd);
          let cellDays;
          if (d.getDay() === 1) {
            cellDays = Math.min(7, daysLeft);
          } else {
            // Partial first week: days until next Monday
            cellDays = Math.min((8 - d.getDay()) % 7 || 7, daysLeft);
          }
          ganttRuler.appendChild(makeRulerCell(
            i * pxPerDay, cellDays * pxPerDay,
            'W' + getWeekNumber(d) + ' \u2013 ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
            'major'
          ));
        }
      });
    } else {
      let cur = new Date(chartStart);
      while (cur <= chartEnd) {
        const offset = daysBetween(chartStart, cur);
        const dim    = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
        // For partial first month, only count remaining days in that month
        const cellDays = Math.min(dim - cur.getDate() + 1, daysBetween(cur, chartEnd));
        ganttRuler.appendChild(makeRulerCell(
          offset * pxPerDay, cellDays * pxPerDay,
          cur.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
          'major'
        ));
        cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      }
    }

    // Today line
    if (today >= chartStart && today <= chartEnd) {
      const line = document.createElement('div');
      line.className = 'gantt-ruler-today';
      line.style.left = (daysBetween(chartStart, today) * pxPerDay) + 'px';
      ganttRuler.appendChild(line);
    }

    // Re-sync ruler horizontal position after rebuilding content
    syncRulerScroll();
  }

  function makeRulerCell(left, width, label, cls) {
    const d = document.createElement('div');
    d.className = 'gantt-ruler-cell ' + (cls || '');
    d.style.cssText = 'left:' + left + 'px;width:' + width + 'px;min-width:' + width + 'px;';
    d.textContent = label;
    return d;
  }

  // ─── rows & bars ──────────────────────────────────────────────────────────
  function renderRowsAndBars(entries, timelineW) {
    ganttRows.style.width = timelineW + 'px';
    ganttRows.innerHTML   = '';

    entries.forEach(entry => {
      const rowBg = document.createElement('div');
      rowBg.className     = 'gantt-row-bg';
      rowBg.style.height  = ROW_H + 'px';
      rowBg.dataset.id    = entry.id;
      rowBg.addEventListener('dblclick', () => drillDown(entry));

      // Allow dragging the row background to reorder (same as grip but from timeline side)
      rowBg.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (conn.active || drag.active) return;
        if (e.target.closest('.gantt-bar-container') || e.target.closest('.gantt-bar')) return;
        // Only start reorder drag if mouse moves vertically enough (avoid interfering with clicks)
        const startY = e.clientY;
        const startX = e.clientX;
        let started = false;
        const onMove = (mv) => {
          if (!started && (Math.abs(mv.clientY - startY) > 6 || Math.abs(mv.clientX - startX) > 6)) {
            if (Math.abs(mv.clientY - startY) > Math.abs(mv.clientX - startX)) {
              started = true;
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
              const taskRow = ganttTaskList.querySelector(`.gantt-task-row[data-id="${entry.id}"]`);
              if (taskRow) startReparentDrag(mv, entry, taskRow);
            }
          }
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      const bar = buildBar(entry);
      if (bar) rowBg.appendChild(bar);
      ganttRows.appendChild(rowBg);
    });

    // Re-attach selection overlay (cleared by innerHTML = '') if still active
    if (timelineSel.overlayEl) {
      ganttRows.appendChild(timelineSel.overlayEl);
    }
  }

  function buildBar(entry) {
    const start = parseDate(entry.start_date);
    const end   = parseDate(entry.end_date);
    if (!start || !end || start > chartEnd || end < chartStart) return null;

    const clippedStart = start < chartStart ? chartStart : start;
    const leftDays  = daysBetween(chartStart, clippedStart);
    const widthDays = Math.max(MIN_DAYS, daysBetween(clippedStart, end));
    const left  = leftDays  * pxPerDay;
    const width = widthDays * pxPerDay;

    const color       = getEntryColor(entry);
    const hasChildren = S().ganttEntries.some(e => e.parent_id === entry.id);
    const isSelected  = S().selectedGanttIds.has(entry.id);
    const deps        = S().dependencies || [];
    const hasDepsIn   = deps.some(d => d.target_id === entry.id);
    const hasDepsOut  = deps.some(d => d.source_id === entry.id);
    const linkedTodo  = S().todos.find(t => t.gantt_entry_id === entry.id);
    const isCompleted = linkedTodo && linkedTodo.status === 'done';

    const container = document.createElement('div');
    container.className     = 'gantt-bar-container';
    container.style.cssText = 'left:' + left + 'px;width:' + width + 'px;';
    container.dataset.id    = entry.id;

    const bar = document.createElement('div');
    bar.className        = 'gantt-bar' + (isSelected ? ' selected' : '') + (isCompleted ? ' gantt-bar-completed' : '');
    bar.style.background = color;
    bar.style.width      = '100%';
    if (U().isColorDark(color)) {
      bar.style.color = '#fff';
    }
    bar.title = entry.title + '\n' + entry.start_date + ' \u2192 ' + entry.end_date +
                (entry.hours_estimate ? '\n' + entry.hours_estimate + 'h estimated' : '') +
                (entry.notes ? '\n\n' + entry.notes : '');

    // Label
    const label = document.createElement('span');
    label.className   = 'gantt-bar-label';
    label.textContent = entry.title;
    bar.appendChild(label);

    // Completed checkmark badge on the bar
    if (isCompleted) {
      const barCheck = document.createElement('span');
      barCheck.className   = 'gantt-bar-completed-check';
      barCheck.textContent = '\u2713'; // ✓
      barCheck.title       = 'Task completed';
      bar.appendChild(barCheck);
    }

    // Hours badge on bar
    const totalH = calcTotalHours(entry.id);
    if (totalH > 0) {
      const hoursBadge = document.createElement('span');
      hoursBadge.className   = 'gantt-bar-hours';
      hoursBadge.textContent = fmtH(totalH);
      bar.appendChild(hoursBadge);
    }

    // Folder link icon on the bar (only when URL is set)
    if (entry.folder_url) {
      const folderBtn = document.createElement('a');
      folderBtn.className = 'gantt-bar-folder-btn';
      folderBtn.href      = ensureAbsoluteUrl(entry.folder_url);
      folderBtn.target    = '_blank';
      folderBtn.rel       = 'noopener noreferrer';
      folderBtn.title     = 'Open folder';
      folderBtn.textContent = '\uD83D\uDCC2';
      folderBtn.addEventListener('click', (e) => e.stopPropagation());
      folderBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      bar.appendChild(folderBtn);
    }

    // Sub-chart indicator (clickable expand/collapse)
    let barIndicator = null;
    if (hasChildren) {
      const isExpanded = expandedIds.has(entry.id);
      const ind = document.createElement('span');
      ind.className   = 'has-children-indicator';
      ind.textContent = isExpanded ? '\u25BC' : '\u25B6';
      ind.title       = isExpanded ? 'Collapse sub-entries' : 'Expand sub-entries';
      ind.addEventListener('mousedown', (e) => e.stopPropagation());
      ind.addEventListener('click', (e) => {
        e.stopPropagation();
        if (expandedIds.has(entry.id)) { expandedIds.delete(entry.id); } else { expandedIds.add(entry.id); }
        render();
      });
      bar.appendChild(ind);
      barIndicator = ind;
    }

    // ── Left resize handle ─────────────────────────────────────────────────
    const hLeft = document.createElement('div');
    hLeft.className = 'gantt-bar-handle left';
    hLeft.title     = 'Drag to change start date';
    hLeft.dataset.help = 'Drag left edge to change the start date';
    hLeft.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      startDrag(e, 'resize-left', entry, bar, container);
    });
    bar.appendChild(hLeft);

    // ── Right resize handle ────────────────────────────────────────────────
    const hRight = document.createElement('div');
    hRight.className = 'gantt-bar-handle right';
    hRight.title     = 'Drag to change end date';
    hRight.dataset.help = 'Drag right edge to change the end date';
    hRight.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      startDrag(e, 'resize-right', entry, bar, container);
    });
    bar.appendChild(hRight);

    // ── Input node (left edge of bar – receives dependency arrows) ─────────
    const inputNode = document.createElement('div');
    inputNode.className = 'dep-node input-node' + (hasDepsIn ? ' always-visible' : '');
    inputNode.title     = 'Input: this task depends on another (click while connecting)';
    inputNode.dataset.help = 'Input node (◀): click here while in connecting mode to set this task as a dependency target';
    inputNode.textContent = '\u25C4';

    inputNode.addEventListener('click', (e) => {
      e.stopPropagation();
      if (conn.active) finishConnecting(entry);
    });
    inputNode.addEventListener('mouseenter', () => {
      if (conn.active && conn.sourceId !== entry.id) {
        inputNode.classList.add('connecting-target');
      }
    });
    inputNode.addEventListener('mouseleave', () => {
      inputNode.classList.remove('connecting-target');
    });
    bar.appendChild(inputNode);

    // ── Output node (right edge of bar – sends dependency arrows) ─────────
    const outputNode = document.createElement('div');
    outputNode.className = 'dep-node output-node' + (hasDepsOut ? ' always-visible' : '');
    outputNode.title     = 'Output: click to connect a dependency to another task';
    outputNode.dataset.help = 'Output node (▶): click to start connecting a dependency arrow from this task to another';
    outputNode.textContent = '\u25BA';

    outputNode.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!conn.active) startConnecting(entry, container);
    });
    bar.appendChild(outputNode);

    // ── Bar body drag (move) ───────────────────────────────────────────────
    bar.addEventListener('mousedown', (e) => {
      if (conn.active) return; // don't start drag during connecting mode
      if (e.target === hLeft || e.target === hRight ||
          e.target === inputNode || e.target === outputNode ||
          e.target === barIndicator) return;
      e.preventDefault();
      startDrag(e, 'move', entry, bar, container);
    });

    bar.addEventListener('dblclick', (e) => {
      if (conn.active) return;
      e.stopPropagation();
      drillDown(entry);
    });
    bar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // contextmenu is handled globally when connecting; skip here
      if (conn.active) return;
      showEntryContextMenu(e.pageX, e.pageY, entry);
    });

    // When in connecting mode, clicking anywhere on this bar finishes the connection
    container.addEventListener('click', (e) => {
      if (conn.active && conn.sourceId !== entry.id) {
        e.stopPropagation();
        finishConnecting(entry);
      }
    });

    container.appendChild(bar);
    return container;
  }

  // =========================================================================
  // Drag – resize & move
  // =========================================================================
  function startDrag(e, type, entry, barEl, containerEl) {
    drag.active      = true;
    drag.type        = type;
    drag.entryId     = entry.id;
    drag.startX      = e.pageX;
    drag.origStart   = entry.start_date;
    drag.origEnd     = entry.end_date;
    drag.ghostEl     = barEl;
    drag.containerEl = containerEl;
    drag.snappedDays = 0;
    drag.origLeftPx  = parseFloat(containerEl.style.left)  || 0;
    drag.origWidthPx = parseFloat(containerEl.style.width) || 0;

    barEl.style.opacity    = '0.75';
    barEl.style.cursor     = type === 'move' ? 'grabbing' : 'col-resize';
    document.body.style.cursor    = type === 'move' ? 'grabbing' : 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function onMouseMove(e) {
    // ── drag live preview (pixel-precise, snaps on release) ────────────────
    if (drag.active) {
      const deltaX = e.pageX - drag.startX;

      // Move/resize the bar at pixel precision so the edge stays at the cursor
      if (drag.type === 'move') {
        drag.containerEl.style.left = (drag.origLeftPx + deltaX) + 'px';
      } else if (drag.type === 'resize-left') {
        const newLeft  = drag.origLeftPx  + deltaX;
        const newWidth = drag.origWidthPx - deltaX;
        if (newWidth >= MIN_DAYS * pxPerDay) {
          drag.containerEl.style.left  = newLeft  + 'px';
          drag.containerEl.style.width = newWidth + 'px';
        }
      } else if (drag.type === 'resize-right') {
        const newWidth = drag.origWidthPx + deltaX;
        if (newWidth >= MIN_DAYS * pxPerDay) {
          drag.containerEl.style.width = newWidth + 'px';
        }
      }

      // Update tooltip with day-snapped dates
      const deltaDays = Math.round(deltaX / pxPerDay);
      if (deltaDays !== drag.snappedDays) {
        drag.snappedDays = deltaDays;
        const { newStart, newEnd } = calcDragDates(deltaDays);
        if (drag.ghostEl) drag.ghostEl.title = newStart + ' \u2192 ' + newEnd;
      }
    }

    // ── timeline date-range selection ──────────────────────────────────────
    if (timelineSel.active && timelineSel.overlayEl && ganttTimeline) {
      const rect    = ganttTimeline.getBoundingClientRect();
      const x       = e.clientX - rect.left + ganttTimeline.scrollLeft;
      const day     = Math.floor(x / pxPerDay);
      timelineSel.endDay = day;
      const startDay = Math.min(timelineSel.startDay, day);
      const endDay   = Math.max(timelineSel.startDay, day);
      timelineSel.overlayEl.style.left  = (startDay * pxPerDay) + 'px';
      timelineSel.overlayEl.style.width = ((endDay - startDay + 1) * pxPerDay) + 'px';
    }

    // ── rubber-band connecting line ────────────────────────────────────────
    if (conn.active && conn.tempLine) {
      const svgEl = document.getElementById('depArrowsSvg');
      if (!svgEl) return;
      // Use ganttTimeline (not ganttRows) so scrollLeft is not counted twice
      const rect       = ganttTimeline.getBoundingClientRect();
      const scrollLeft = ganttTimeline.scrollLeft;
      const scrollTop  = ganttTimeline.scrollTop;
      const mx = e.clientX - rect.left  + scrollLeft;
      const my = e.clientY - rect.top   + scrollTop;
      const sx = conn.sx;
      const sy = conn.sy;
      const dx   = mx - sx;
      const cpx  = Math.max(Math.abs(dx) * 0.4, 40);
      conn.tempLine.setAttribute('d',
        `M ${sx} ${sy} C ${sx + cpx} ${sy}, ${mx - cpx} ${my}, ${mx} ${my}`);
    }
  }

  async function onMouseUp(e) {
    // ── finalize timeline selection ────────────────────────────────────────
    if (timelineSel.active) {
      timelineSel.active = false;
      // If barely moved (< 5px), treat as a click and clear selection
      if (Math.abs(e.pageX - timelineSel.mouseStartX) < 5) {
        clearTimelineSelection();
      }
      // else: leave the overlay visible so the user can right-click it
    }

    if (!drag.active) return;

    document.body.style.cursor    = '';
    document.body.style.userSelect = '';
    if (drag.ghostEl) { drag.ghostEl.style.opacity = ''; drag.ghostEl.style.cursor = ''; }

    // Capture drag state and reset immediately to prevent sticking
    const deltaDays    = Math.round((e.pageX - drag.startX) / pxPerDay);
    const { newStart, newEnd } = calcDragDates(deltaDays);
    const entryId      = drag.entryId;
    const containerEl  = drag.containerEl;
    const origStart    = drag.origStart;
    const origEnd      = drag.origEnd;

    drag.active = false; drag.type = null; drag.entryId = null;
    drag.ghostEl = null; drag.containerEl = null;

    if (deltaDays === 0) {
      // No movement → treat as a click: select the entry.
      if (e.shiftKey) {
        if (S().selectedGanttIds.has(entryId)) {
          S().selectedGanttIds.delete(entryId);
        } else {
          S().selectedGanttIds.add(entryId);
        }
      } else {
        S().selectedGanttIds.clear();
        S().selectedGanttIds.add(entryId);
      }
      U().updateDeleteBtn();
      render();
      return;
    }

    if (deltaDays !== 0) {
      // Expand chart date range if entry moved/resized outside it
      expandChartRange({ start_date: newStart, end_date: newEnd });

      try {
        const updated = await API('PUT', '/api/gantt/' + entryId, {
          start_date: newStart, end_date: newEnd,
        });
        const idx = S().ganttEntries.findIndex(x => x.id === entryId);
        if (idx !== -1) {
          S().ganttEntries[idx] = updated.entry;
          await expandParentDates(updated.entry);
        }
        U().updateUndoRedoBtns?.();
      } catch (err) {
        console.error('Save drag failed:', err);
        updateBarVisual(containerEl, origStart, origEnd);
      }
      render();
    }
  }

  function calcDragDates(deltaDays) {
    const os = parseDate(drag.origStart);
    const oe = parseDate(drag.origEnd);
    let newStart = drag.origStart;
    let newEnd   = drag.origEnd;

    if (drag.type === 'move') {
      newStart = toDateStr(addDays(os, deltaDays));
      newEnd   = toDateStr(addDays(oe, deltaDays));
    } else if (drag.type === 'resize-left') {
      const p = addDays(os, deltaDays);
      newStart = toDateStr(daysBetween(p, oe) >= MIN_DAYS ? p : addDays(oe, -MIN_DAYS));
    } else if (drag.type === 'resize-right') {
      const p = addDays(oe, deltaDays);
      newEnd = toDateStr(daysBetween(os, p) >= MIN_DAYS ? p : addDays(os, MIN_DAYS));
    }
    return { newStart, newEnd };
  }

  function updateBarVisual(containerEl, newStart, newEnd) {
    if (!containerEl) return;
    const s  = parseDate(newStart);
    const en = parseDate(newEnd);
    const cs = s < chartStart ? chartStart : s;
    const leftDays  = daysBetween(chartStart, cs);
    const widthDays = Math.max(MIN_DAYS, daysBetween(cs, en));
    containerEl.style.left  = (leftDays  * pxPerDay) + 'px';
    containerEl.style.width = (widthDays * pxPerDay) + 'px';
  }

  // =========================================================================
  // Dependency Connecting
  // =========================================================================
  function startConnecting(entry) {
    conn.active   = true;
    conn.sourceId = entry.id;
    document.body.classList.add('connecting-mode');

    // Source point: right edge of bar at row vertical centre
    const rowIdx = rowIndexMap[entry.id] !== undefined ? rowIndexMap[entry.id] : 0;
    const endDate = parseDate(entry.end_date);
    const sx = Math.max(0, daysBetween(chartStart, endDate)) * pxPerDay;
    const sy = rowIdx * ROW_H + ROW_H / 2;
    conn.sx = sx;
    conn.sy = sy;

    // Create SVG rubber-band bezier path
    const svgEl = ensureDepSvg();
    const path  = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${sx} ${sy} C ${sx + 40} ${sy}, ${sx + 40} ${sy}, ${sx} ${sy}`);
    path.setAttribute('stroke', 'rgba(46,125,50,0.85)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-dasharray', '6 3');
    path.setAttribute('fill', 'none');
    path.setAttribute('marker-end', 'url(#depArrow)');
    svgEl.appendChild(path);
    conn.tempLine = path;

    const banner = document.getElementById('connectingBanner');
    if (banner) banner.classList.remove('hidden');
  }

  async function finishConnecting(targetEntry) {
    if (!conn.active || conn.sourceId === targetEntry.id) return;
    const sourceId = conn.sourceId;
    cancelConnecting();

    try {
      const data = await API('POST', '/api/dependencies', {
        project_id: S().currentProject.id,
        source_id: sourceId,
        target_id: targetEntry.id,
      });
      if (!S().dependencies.some(d => d.id === data.dep.id)) {
        S().dependencies.push(data.dep);
      }
      render();
    } catch (err) {
      console.error('Create dependency failed:', err);
    }
  }

  function cancelConnecting() {
    if (conn.tempLine && conn.tempLine.parentNode) {
      conn.tempLine.parentNode.removeChild(conn.tempLine);
    }
    conn.active = false; conn.sourceId = null; conn.tempLine = null;
    document.body.classList.remove('connecting-mode');
    const banner = document.getElementById('connectingBanner');
    if (banner) banner.classList.add('hidden');
  }

  // =========================================================================
  // Dependency SVG arrows
  // =========================================================================
  function ensureDepSvg() {
    let svg = document.getElementById('depArrowsSvg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'depArrowsSvg';
      svg.style.cssText =
        'position:absolute;top:0;left:0;width:100%;height:100%;' +
        'overflow:visible;z-index:8;';
      ganttRows.style.position = 'relative';
      ganttRows.appendChild(svg);
    }
    return svg;
  }

  function renderDependencyArrows(entries) {
    const svg = ensureDepSvg();

    // Remove old static arrows + defs (keep rubber-band temp line if present)
    Array.from(svg.querySelectorAll('.dep-arrow, .dep-arrow-hit, defs')).forEach(el => el.remove());

    // When arrows are hidden, stop here (rubber-band temp line stays if connecting)
    if (!depsVisible) return;

    // Arrowhead marker definition
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'depArrow');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('refX', '7');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', '0 0, 8 3, 0 6');
    poly.setAttribute('fill', 'rgba(80,80,80,0.75)');
    marker.appendChild(poly);
    defs.appendChild(marker);
    svg.insertBefore(defs, svg.firstChild);

    const deps = S().dependencies || [];
    deps.forEach(dep => {
      const srcIdx = rowIndexMap[dep.source_id];
      const tgtIdx = rowIndexMap[dep.target_id];
      if (srcIdx === undefined || tgtIdx === undefined) return;

      const srcEntry = entries[srcIdx];
      const tgtEntry = entries[tgtIdx];
      if (!srcEntry || !tgtEntry) return;

      const x1 = Math.max(0, daysBetween(chartStart, parseDate(srcEntry.end_date)))   * pxPerDay;
      const x2 = Math.max(0, daysBetween(chartStart, parseDate(tgtEntry.start_date))) * pxPerDay;
      const y1 = srcIdx * ROW_H + ROW_H / 2;
      const y2 = tgtIdx * ROW_H + ROW_H / 2;

      // Gentler bezier curve (reduced control-point factor vs the old 0.5)
      const dx   = Math.abs(x2 - x1);
      const cpx  = Math.max(dx * 0.25, MIN_BEZIER_CP);
      const d    = 'M ' + x1 + ' ' + y1 +
                   ' C ' + (x1 + cpx) + ' ' + y1 + ',' +
                   (x2 - cpx) + ' ' + y2 + ',' +
                   x2 + ' ' + y2;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', 'rgba(80,80,80,0.65)');
      path.setAttribute('stroke-width', '1.8');
      path.setAttribute('fill', 'none');
      path.setAttribute('marker-end', 'url(#depArrow)');
      path.classList.add('dep-arrow');

      // Wide invisible hit-area for easier clicking
      const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hitArea.setAttribute('d', d);
      hitArea.setAttribute('stroke', 'transparent');
      hitArea.setAttribute('stroke-width', '14');
      hitArea.setAttribute('fill', 'none');
      hitArea.classList.add('dep-arrow-hit');
      hitArea.style.pointerEvents = 'stroke';
      hitArea.style.cursor        = 'pointer';
      hitArea.title = srcEntry.title + ' \u2192 ' + tgtEntry.title;

      // Red ✕ delete button at the bezier midpoint – appears on hover
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const delBtn = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      delBtn.classList.add('dep-delete-btn');
      delBtn.setAttribute('transform', `translate(${mx},${my})`);
      delBtn.style.cursor = 'pointer';
      delBtn.style.pointerEvents = 'all';

      const delCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      delCircle.setAttribute('r', '9');
      delCircle.setAttribute('fill', '#e53935');
      delCircle.setAttribute('stroke', '#fff');
      delCircle.setAttribute('stroke-width', '1.5');

      const delText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      delText.setAttribute('text-anchor', 'middle');
      delText.setAttribute('dominant-baseline', 'central');
      delText.setAttribute('fill', '#fff');
      delText.setAttribute('font-size', '11');
      delText.setAttribute('font-weight', 'bold');
      delText.textContent = '\u2715';

      delBtn.appendChild(delCircle);
      delBtn.appendChild(delText);
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteDependency(dep.id);
      });

      // Hover: show ✕ button and highlight arrow; small delay prevents flicker
      // when moving between hitArea and delBtn.
      let _depHoverTimer;
      const showDepHover = () => {
        clearTimeout(_depHoverTimer);
        path.classList.add('dep-arrow-hover');
        delBtn.style.opacity = '1';
      };
      const hideDepHover = () => {
        _depHoverTimer = setTimeout(() => {
          path.classList.remove('dep-arrow-hover');
          delBtn.style.opacity = '0';
        }, 80);
      };
      hitArea.addEventListener('mouseenter', showDepHover);
      hitArea.addEventListener('mouseleave', hideDepHover);
      delBtn.addEventListener('mouseenter', showDepHover);
      delBtn.addEventListener('mouseleave', hideDepHover);

      svg.appendChild(hitArea);
      svg.appendChild(path);
      svg.appendChild(delBtn);
    });

    // Keep rubber-band line on top
    if (conn.tempLine && conn.tempLine.parentNode !== svg) {
      svg.appendChild(conn.tempLine);
    }
  }

  async function deleteDependency(depId) {
    await API('DELETE', '/api/dependencies/' + depId);
    S().dependencies = S().dependencies.filter(d => d.id !== depId);
    render();
  }

  // =========================================================================
  // Total-Hours Panel (right column)
  // =========================================================================
  function renderHoursPanel(entries) {
    if (!ganttHoursPanel) return;
    ganttHoursPanel.innerHTML = '';

    const capacity = S().currentTeam ? S().currentTeam.capacity_hours_month : 160;
    let viewTotal = 0;

    entries.forEach(entry => {
      const total = calcTotalHours(entry.id);
      viewTotal += +(entry.hours_estimate) || 0; // project total = own hours only at top level

      const row = document.createElement('div');
      row.className = 'gantt-hours-row' + (total > 0 ? ' has-hours' : '');
      if (total > capacity) row.classList.add('overloaded');
      row.textContent = total > 0 ? fmtH(total) : '\u2014';
      row.title = total > 0
        ? fmtH(total) + ' total (incl. sub-tasks)'
        : 'No hours estimated';
      ganttHoursPanel.appendChild(row);
    });

    // Update panel header with view total (only root-level visible entries
    // to avoid double-counting inline-expanded children).
    const header = document.getElementById('ganttHoursHeader');
    if (header) {
      const t = entries
        .filter(e => (e._depth || 0) === 0)
        .reduce((sum, e) => sum + calcTreeTotal(e.id), 0);
      header.textContent = t > 0 ? fmtH(t) : 'Total h';
      header.title       = t > 0 ? fmtH(t) + ' total hours in this view' : 'Total hours';
    }
  }

  /**
   * Recursively sum hours for an entry and all its descendants
   * (regardless of what sub-chart level is currently visible).
   *
   * Returns the *remaining* budget for entries that have their own
   * hours_estimate set: remaining = own - sum_of_children_allocations.
   * "Child allocation" is calcTreeTotal (the full budget claimed by a
   * child subtree), NOT calcTotalHours of the child, to prevent
   * double-subtracting nested budgets.
   */
  function calcTotalHours(entryId) {
    const entry = S().ganttEntries.find(e => e.id === entryId);
    if (!entry) return 0;
    const children = S().ganttEntries.filter(e => e.parent_id === entryId);
    if (children.length === 0) {
      // Leaf task: count own hours only
      return +(entry.hours_estimate) || 0;
    }
    const own = +(entry.hours_estimate) || 0;
    if (own > 0) {
      // Parent has an hour budget: subtract each child's total allocation
      // (use calcTreeTotal so nested sub-budgets aren't double-counted).
      let childTotal = 0;
      children.forEach(child => { childTotal += calcTreeTotal(child.id); });
      return Math.max(0, own - childTotal);
    }
    // No budget on parent: show sum of children's displayed hours
    let childSum = 0;
    children.forEach(child => { childSum += calcTotalHours(child.id); });
    return childSum;
  }

  /**
   * Total hours for an entire tree (parent budget or child sum, whichever is
   * larger). Used for the header "Total h" so the number reflects the full
   * project scope instead of only the remaining budget.  When a parent has
   * no budget (hours_estimate is 0 or null) the child sum is returned.
   */
  function calcTreeTotal(entryId) {
    const entry = S().ganttEntries.find(e => e.id === entryId);
    if (!entry) return 0;
    const children = S().ganttEntries.filter(e => e.parent_id === entryId);
    if (children.length === 0) return +(entry.hours_estimate) || 0;
    let childSum = 0;
    children.forEach(child => { childSum += calcTreeTotal(child.id); });
    return Math.max(+(entry.hours_estimate) || 0, childSum);
  }

  function fmtH(h) {
    h = +h || 0;
    return Number.isInteger(h) ? h + 'h' : h.toFixed(1) + 'h';
  }

  // =========================================================================
  // Intensity Bar
  // =========================================================================
  function renderIntensityBar(timelineW, totalDays) {
    const canvas   = intensityBarCanvas;
    const H        = 32;
    const capacity = S().currentTeam ? S().currentTeam.capacity_hours_month : 160;

    canvas.width  = timelineW;
    canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, timelineW, H);

    const periodDays     = scale === 'day' ? 1 : scale === 'week' ? 7 : 30;
    const hoursPerPeriod = capacity * (periodDays / 30);

    const hoursPerDay = new Float64Array(totalDays + 1);
    // Build a set of entry IDs that have children so we can handle
    // parent budget remaining vs leaf hours correctly.
    const parentIdsSet = new Set();
    S().ganttEntries.forEach(e => { if (e.parent_id) parentIdsSet.add(e.parent_id); });

    S().ganttEntries.forEach(entry => {
      if (!entry.hours_estimate) return;
      const isParent = parentIdsSet.has(entry.id);
      let h;
      if (isParent) {
        // Parent with budget: only spread the remaining (budget − children) hours
        h = calcTotalHours(entry.id);          // already clamped to ≥ 0
        if (h <= 0) return;                    // children consumed the whole budget
      } else {
        h = +(entry.hours_estimate);
      }
      const s  = parseDate(entry.start_date);
      const en = parseDate(entry.end_date);
      if (!s || !en) return;
      const span   = Math.max(1, daysBetween(s, en));
      const dailyH = h / span;
      for (let d = 0; d < totalDays; d++) {
        const day = addDays(chartStart, d);
        if (day >= s && day < en) hoursPerDay[d] += dailyH;
      }
    });

    let ps = 0;
    while (ps < totalDays) {
      const pe = Math.min(ps + periodDays, totalDays);
      let hours = 0;
      for (let d = ps; d < pe; d++) hours += hoursPerDay[d];

      const ratio = Math.min(hours / Math.max(hoursPerPeriod, 0.1), 2);
      const r = Math.round(Math.min(255, ratio * 255));
      const g = Math.round(Math.max(0, 255 - ratio * 255));
      const a = 0.15 + Math.min(ratio, 1) * 0.7;

      ctx.fillStyle = 'rgba(' + r + ',' + g + ',0,' + a + ')';
      ctx.fillRect(ps * pxPerDay, 0, (pe - ps) * pxPerDay, H - 4);

      if (hours > 0 && (pe - ps) * pxPerDay > 30) {
        ctx.fillStyle = ratio > 0.8 ? '#b71c1c' : '#2e7d32';
        ctx.font      = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(ratio * 100) + '%', (ps + (pe - ps) / 2) * pxPerDay, H - 6);
      }
      ps += periodDays;
    }

    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, H - 4, timelineW, 4);
  }

  function syncIntensityScroll() {
    if (intensityBarWrapper) {
      intensityBarWrapper.style.marginLeft = '-' + ganttTimeline.scrollLeft + 'px';
    }
  }

  // Shift the ruler content horizontally to match the timeline's horizontal scroll.
  // The ruler lives in a clip wrapper (overflow:hidden) so this simulates native scroll.
  function syncRulerScroll() {
    if (ganttRuler) {
      ganttRuler.style.marginLeft = '-' + ganttTimeline.scrollLeft + 'px';
    }
  }

  // =========================================================================
  // Breadcrumb
  // =========================================================================
  function renderBreadcrumb() {
    ganttBreadcrumb.innerHTML = '';
    if (!parentStack.length) return;

    // ← Back button to go one level up
    const backBtn = document.createElement('button');
    backBtn.className = 'gantt-bc-back';
    backBtn.textContent = '\u2190 Back';
    backBtn.title = 'Go one level up';
    backBtn.addEventListener('click', () => {
      parentStack.pop();
      currentParentId = parentStack.length ? parentStack[parentStack.length - 1].entry.id : null;
      render();
    });
    ganttBreadcrumb.appendChild(backBtn);

    const root = document.createElement('span');
    root.className  = 'gantt-bc-item';
    root.textContent = (S().currentProject && S().currentProject.name) || 'Project';
    root.addEventListener('click', () => {
      parentStack = []; currentParentId = null; render();
    });
    ganttBreadcrumb.appendChild(root);

    parentStack.forEach((crumb, i) => {
      const sep = document.createElement('span');
      sep.className   = 'gantt-bc-sep';
      sep.textContent = ' \u203A ';
      ganttBreadcrumb.appendChild(sep);

      if (i < parentStack.length - 1) {
        const item = document.createElement('span');
        item.className  = 'gantt-bc-item';
        item.textContent = crumb.label;
        item.addEventListener('click', () => {
          parentStack = parentStack.slice(0, i + 1);
          currentParentId = crumb.entry.id;
          render();
        });
        ganttBreadcrumb.appendChild(item);
      } else {
        const cur = document.createElement('span');
        cur.className  = 'gantt-bc-current';
        cur.textContent = crumb.label;
        ganttBreadcrumb.appendChild(cur);
      }
    });
  }

  // =========================================================================
  // Sub-Gantt Drill-Down
  // =========================================================================
  function drillDown(entry) {
    parentStack.push({ entry, label: entry.title });
    currentParentId = entry.id;
    render();
  }

  // =========================================================================
  // Entry Modals
  // =========================================================================
  function showAddEntryModal(parentId, startDateOverride, endDateOverride) {
    const today    = startDateOverride || toDateStr(new Date());
    const startDt  = parseDate(today) || new Date();
    const nextWeek = endDateOverride   || toDateStr(addDays(startDt, 7));

    U().openModal('Add Gantt Entry', buildEntryFormHtml({
      title: '', start_date: today, end_date: nextWeek,
      hours_estimate: '', color_variation: 0, notes: '', folder_url: '',
    }), async () => {
      const vals = readEntryForm();
      if (!vals.title) return alert('Title is required');
      try {
        const data = await API('POST', '/api/gantt', {
          project_id: S().currentProject.id,
          parent_id: parentId !== undefined ? parentId : currentParentId,
          ...vals,
        });
        S().ganttEntries.push(data.entry);
        await expandParentDates(data.entry);
        expandChartRange(data.entry);
        // Auto-expand the parent so the new child is visible inline
        if (data.entry.parent_id && data.entry.parent_id !== currentParentId) {
          expandedIds.add(data.entry.parent_id);
        }
        render();
        U().closeModal();
        U().updateUndoRedoBtns?.();

        // Ask if the new entry should also be added to the todo list
        if (confirm('Add "' + data.entry.title + '" to the Todo list as well?')) {
          addToTodo(data.entry);
        }
      } catch (err) {
        alert('Save failed: ' + err.message);
      }
    });
  }

  function showEditEntryModal(entry) {
    U().openModal('Edit Entry', buildEntryFormHtml(entry), async () => {
      const vals = readEntryForm();
      if (!vals.title) return alert('Title is required');
      try {
        const data = await API('PUT', '/api/gantt/' + entry.id, vals);
        const idx = S().ganttEntries.findIndex(e => e.id === entry.id);
        if (idx !== -1) {
          S().ganttEntries[idx] = data.entry;
          await expandParentDates(data.entry);
          expandChartRange(data.entry);
        }
        render();
        U().closeModal();
        U().updateUndoRedoBtns?.();
      } catch (err) {
        alert('Save failed: ' + err.message);
      }
    });
  }

  function buildEntryFormHtml(entry) {
    const vars = U().generateColorVariations((S().user && S().user.base_color) || '#2196F3');
    const swatches = vars.map((c, i) =>
      '<div class="color-var-swatch' + (entry.color_variation === i ? ' selected' : '') +
      '" data-idx="' + i + '" style="background:' + c + '" title="Phase ' + (i + 1) + '"></div>'
    ).join('');

    // For parent entries: compute child hours and show a hint below the hours input
    const childEntries = entry.id ? S().ganttEntries.filter(e => e.parent_id === entry.id) : [];
    let childHoursHtml = '';
    if (childEntries.length > 0) {
      let childSum = 0;
      childEntries.forEach(c => { childSum += calcTotalHours(c.id); });
      if (childSum > 0) {
        const own = +(entry.hours_estimate) || 0;
        if (own > 0) {
          const remaining = Math.max(0, own - childSum);
          childHoursHtml = '<small style="color:var(--text-muted);font-size:11px;margin-top:3px;display:block">' +
            'Sub-tasks use ' + fmtH(childSum) + ' \u2014 ' + fmtH(remaining) + ' remaining of your ' + fmtH(own) + ' budget' +
            '</small>';
        } else {
          childHoursHtml = '<small style="color:var(--text-muted);font-size:11px;margin-top:3px;display:block">' +
            'Sub-tasks total: ' + fmtH(childSum) +
            '</small>';
        }
      }
    }

    return '<div class="form-group">' +
      '<label>Title</label>' +
      '<input type="text" id="feTitle" value="' + U().escHtml(entry.title || '') + '" placeholder="Task name">' +
      '</div>' +
      '<div style="display:flex;gap:12px">' +
        '<div class="form-group" style="flex:1"><label>Start Date</label>' +
          '<input type="date" id="feStart" value="' + (entry.start_date || '') + '"></div>' +
        '<div class="form-group" style="flex:1"><label>End Date</label>' +
          '<input type="date" id="feEnd" value="' + (entry.end_date || '') + '"></div>' +
      '</div>' +
      '<div class="form-group"><label>Hours Estimate</label>' +
        '<input type="number" id="feHours" value="' + (entry.hours_estimate || '') + '" min="0" step="0.5" placeholder="0">' +
        childHoursHtml +
      '</div>' +
      '<div class="form-group"><label>Phase / Colour Variation</label>' +
        '<div class="color-variation-picker" id="colorVarPicker">' + swatches + '</div>' +
        '<input type="hidden" id="feColorVar" value="' + (entry.color_variation || 0) + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Folder Link (optional)</label>' +
        '<div style="display:flex;gap:6px;align-items:center">' +
          '<input type="url" id="feFolderUrl" value="' + U().escHtml(entry.folder_url || '') + '" ' +
            'placeholder="https://\u2026sharepoint.com/\u2026  or any URL" style="flex:1">' +
          (entry.folder_url
            ? '<a href="' + U().escHtml(ensureAbsoluteUrl(entry.folder_url)) + '" target="_blank" rel="noopener" ' +
              'class="btn btn-secondary btn-sm" title="Open folder">\uD83D\uDCC2 Open</a>'
            : '') +
        '</div>' +
        '<small style="color:var(--text-muted);font-size:11px;margin-top:3px;display:block">' +
          'Paste a SharePoint, OneDrive, network or web folder URL.' +
        '</small>' +
      '</div>' +
      '<div class="form-group"><label>Notes</label>' +
        '<textarea id="feNotes" placeholder="Optional notes">' + U().escHtml(entry.notes || '') + '</textarea>' +
      '</div>';
  }

  // Colour swatch click – delegated
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('color-var-swatch')) {
      document.querySelectorAll('.color-var-swatch').forEach(s => s.classList.remove('selected'));
      e.target.classList.add('selected');
      const inp = document.getElementById('feColorVar');
      if (inp) inp.value = e.target.dataset.idx;
    }
  });

  function readEntryForm() {
    let folderUrl = (document.getElementById('feFolderUrl') && document.getElementById('feFolderUrl').value.trim()) || '';
    if (folderUrl && !/^https?:\/\//i.test(folderUrl) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(folderUrl)) {
      // No URL scheme present (e.g. "youtube.com") – prepend https://
      folderUrl = 'https://' + folderUrl;
    }
    return {
      title:           (document.getElementById('feTitle') && document.getElementById('feTitle').value.trim()) || '',
      start_date:      (document.getElementById('feStart') && document.getElementById('feStart').value) || '',
      end_date:        (document.getElementById('feEnd')   && document.getElementById('feEnd').value)   || '',
      hours_estimate:  parseFloat((document.getElementById('feHours') && document.getElementById('feHours').value)) || 0,
      color_variation: parseInt((document.getElementById('feColorVar') && document.getElementById('feColorVar').value)) || 0,
      notes:           (document.getElementById('feNotes') && document.getElementById('feNotes').value) || '',
      folder_url:      folderUrl,
    };
  }

  // =========================================================================
  // Context Menu
  // =========================================================================
  function showEntryContextMenu(x, y, entry) {
    const hasChildren = S().ganttEntries.some(e => e.parent_id === entry.id);
    const siblings = getSortedSiblings(entry);
    const sibIdx = siblings.findIndex(e => e.id === entry.id);
    const canMoveUp   = sibIdx > 0;
    const canMoveDown = sibIdx < siblings.length - 1;
    U().showContextMenu(x, y, [
      { icon: '\u270F', label: 'Edit',                 action: () => showEditEntryModal(entry) },
      { icon: '+',      label: 'Add sub-task',          action: () => showAddEntryModal(entry.id) },
      hasChildren
        ? { icon: '\u25BC', label: 'Open sub-chart',   action: () => drillDown(entry) }
        : null,
      { separator: true },
      canMoveUp   ? { icon: '\u2B06', label: 'Move up',   action: () => moveEntryUp(entry) }   : null,
      canMoveDown ? { icon: '\u2B07', label: 'Move down', action: () => moveEntryDown(entry) } : null,
      (canMoveUp || canMoveDown) ? { separator: true } : null,
      { icon: '\uD83D\uDCCB', label: 'Copy',            action: () => copyEntry(entry, false) },
      { icon: '\u2702',       label: 'Cut',             action: () => copyEntry(entry, true) },
      clipboardData
        ? { icon: '\uD83D\uDCCB', label: 'Paste here', action: () => pasteEntries(entry.start_date) }
        : null,
      { separator: true },
      { icon: '\uD83D\uDCC2',
        label: entry.folder_url ? 'Open SharePoint folder' : 'Set SharePoint folder\u2026',
        action: () => entry.folder_url
          ? window.open(ensureAbsoluteUrl(entry.folder_url), '_blank', 'noopener')
          : showEditEntryModal(entry) },
      { icon: '\uD83D\uDD17', label: 'Connect dependency', action: () => startConnecting(entry) },
      { icon: '\u2611', label: 'Add to Todo',           action: () => addToTodo(entry) },
      { separator: true },
      { icon: '\uD83D\uDDD1', label: 'Delete',          action: () => deleteEntry(entry), danger: true },
    ].filter(Boolean));
  }

  // =========================================================================
  // Copy / Paste
  // =========================================================================
  function collectSubtree(entryId) {
    const entry = S().ganttEntries.find(e => e.id === entryId);
    if (!entry) return [];
    let result = [Object.assign({}, entry)];
    const children = S().ganttEntries.filter(e => e.parent_id === entryId);
    children.forEach(child => { result = result.concat(collectSubtree(child.id)); });
    return result;
  }

  function copyEntry(entry, cut) {
    clipboardData = { entries: collectSubtree(entry.id), rootId: entry.id, cut };
  }

  /** Called from app.js keyboard handler – copies the first selected entry */
  function copySelected(cut) {
    const id = S().selectedGanttIds.size > 0 ? [...S().selectedGanttIds][0] : null;
    if (!id) return;
    const entry = S().ganttEntries.find(e => e.id === id);
    if (entry) copyEntry(entry, cut);
  }

  /** Called from app.js keyboard handler – pastes at today */
  function pasteAtDate() {
    if (!clipboardData) return;
    pasteEntries(toDateStr(new Date()));
  }

  async function pasteEntries(pasteStartDate) {
    if (!clipboardData || !S().currentProject) return;
    const { entries, rootId, cut } = clipboardData;
    const root = entries.find(e => e.id === rootId);
    if (!root) return;

    // Calculate day offset from original root start to paste position
    const rootStart  = parseDate(root.start_date);
    const pasteStart = parseDate(pasteStartDate);
    const dayOffset  = daysBetween(rootStart, pasteStart);

    // Sort entries so parents come before their children
    const sorted = [];
    const addSorted = (id) => {
      const e = entries.find(x => x.id === id);
      if (!e || sorted.includes(e)) return;
      sorted.push(e);
      entries.filter(x => x.parent_id === id).forEach(c => addSorted(c.id));
    };
    addSorted(rootId);

    const idMap = {}; // old id → new id
    for (const e of sorted) {
      const newParentId = e.id === rootId
        ? currentParentId  // paste root at current chart level
        : (idMap[e.parent_id] !== undefined ? idMap[e.parent_id] : null);
      const newStart = toDateStr(addDays(parseDate(e.start_date), dayOffset));
      const newEnd   = toDateStr(addDays(parseDate(e.end_date),   dayOffset));
      try {
        const data = await API('POST', '/api/gantt', {
          project_id:      S().currentProject.id,
          parent_id:       newParentId,
          title:           e.title,
          start_date:      newStart,
          end_date:        newEnd,
          hours_estimate:  e.hours_estimate,
          color_variation: e.color_variation,
          notes:           e.notes,
          folder_url:      e.folder_url,
        });
        idMap[e.id] = data.entry.id;
        S().ganttEntries.push(data.entry);
        expandChartRange(data.entry);
        if (data.entry.parent_id && data.entry.parent_id !== currentParentId) {
          expandedIds.add(data.entry.parent_id);
        }
      } catch (err) {
        console.error('Paste failed for entry "' + e.title + '":', err);
      }
    }

    if (cut) {
      // Delete originals in reverse order (children before parents)
      for (const e of [...sorted].reverse()) {
        try {
          await API('DELETE', '/api/gantt/' + e.id);
          S().ganttEntries = S().ganttEntries.filter(x => x.id !== e.id);
          S().dependencies = S().dependencies.filter(d => d.source_id !== e.id && d.target_id !== e.id);
        } catch (err) { console.warn('Cut-delete failed for entry "' + e.title + '":', err); }
      }
      clipboardData = null; // cut can only be pasted once
    }

    render();
  }

  // =========================================================================
  // Delete entry
  // =========================================================================
  async function deleteEntry(entry) {
    if (!confirm('Delete "' + entry.title + '"?')) return;
    await API('DELETE', '/api/gantt/' + entry.id);
    S().ganttEntries  = S().ganttEntries.filter(e => e.id !== entry.id);
    // Remove related deps locally (server cascades)
    S().dependencies  = S().dependencies.filter(
      d => d.source_id !== entry.id && d.target_id !== entry.id
    );
    S().selectedGanttIds.delete(entry.id);
    U().updateDeleteBtn();
    U().updateUndoRedoBtns?.();
    render();
  }

  // =========================================================================
  // Auto-expand parent date range when a child falls outside it
  // =========================================================================
  async function expandParentDates(entry) {
    if (!entry.parent_id) return;
    const parent = S().ganttEntries.find(e => e.id === entry.parent_id);
    if (!parent) return;
    let changed = false;
    let newStart = parent.start_date;
    let newEnd   = parent.end_date;
    if (entry.start_date < newStart) { newStart = entry.start_date; changed = true; }
    if (entry.end_date   > newEnd)   { newEnd   = entry.end_date;   changed = true; }
    if (!changed) return;
    try {
      const data = await API('PUT', '/api/gantt/' + parent.id, { start_date: newStart, end_date: newEnd });
      const idx = S().ganttEntries.findIndex(e => e.id === parent.id);
      if (idx !== -1) S().ganttEntries[idx] = data.entry;
      // Recursively expand grandparent if needed
      await expandParentDates(data.entry);
    } catch (err) { console.warn('expandParentDates:', err); }
  }
  // =========================================================================
  async function addToTodo(entry) {
    if (S().todos.some(t => t.gantt_entry_id === entry.id)) return;
    const data = await API('POST', '/api/todos', {
      project_id:     entry.project_id,
      gantt_entry_id: entry.id,
      title:          entry.title,
      due_date:       entry.end_date,
    });
    S().todos.push(data.todo);
    if (window.todoModule) window.todoModule.render();
    render();
  }

  // =========================================================================
  // Date helpers
  // =========================================================================

  /** Expand the visible chart date range if the given entry falls outside it. */
  function expandChartRange(entry) {
    const s  = parseDate(entry.start_date);
    const en = parseDate(entry.end_date);
    let changed = false;
    if (s && chartStart && s < chartStart) {
      chartStart = new Date(s);
      chartStart.setDate(chartStart.getDate() - 7);
      changed = true;
    }
    if (en && chartEnd && en > chartEnd) {
      chartEnd = new Date(en);
      chartEnd.setDate(chartEnd.getDate() + 14);
      changed = true;
    }
    return changed;
  }

  function parseDate(str) {
    if (!str) return null;
    const d = new Date(str + 'T00:00:00');
    return isNaN(d) ? null : d;
  }
  function toDateStr(d) {
    if (!d) return '';
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }
  function addDays(date, days) {
    const d = new Date(date); d.setDate(d.getDate() + days); return d;
  }
  function daysBetween(a, b) {
    return Math.floor((b - a) / 86400000);
  }
  // Returns the minimum pxPerDay at which the full chart range fits in the
  // visible timeline area – used as the lower bound when zooming out.
  function minPxPerDayForFit() {
    if (!chartStart || !chartEnd) return 0.5;
    const totalDays = Math.max(1, daysBetween(chartStart, chartEnd));
    const w = ganttTimeline ? ganttTimeline.clientWidth : 0;
    // Always allow at least 0.5 px/day so the chart remains usable.
    return Math.max(0.5, w > 0 ? w / totalDays : 0.5);
  }
  function forEachDay(start, end, fn) {
    let cur = new Date(start), i = 0;
    while (cur <= end) { fn(new Date(cur), i); cur.setDate(cur.getDate() + 1); i++; }
  }
  function getWeekNumber(d) {
    const jan1 = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  }
  function formatDay(d) {
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // =========================================================================
  // Visible entries + auto chart range
  // =========================================================================
  function visibleEntries() {
    const all   = S().ganttEntries;

    // Build parent → children map once (O(n) instead of repeated O(n) filters)
    const childrenOf = {};
    all.forEach(e => {
      const pid = e.parent_id;
      if (!childrenOf[pid]) childrenOf[pid] = [];
      childrenOf[pid].push(e);
    });

    // Sort each sibling group by position then created_at so that drag-reorder
    // changes (which update .position values without re-sorting the master array)
    // are immediately reflected in the rendered order.
    Object.values(childrenOf).forEach(group =>
      group.sort((a, b) => (a.position - b.position) || (a.created_at > b.created_at ? 1 : -1))
    );

    const roots  = childrenOf[currentParentId] || [];
    const result = [];

    function addWithChildren(entry, depth) {
      entry._depth = depth;           // transient, used for indent
      result.push(entry);
      if (expandedIds.has(entry.id)) {
        const kids = childrenOf[entry.id] || [];
        kids.forEach(child => addWithChildren(child, depth + 1));
      }
    }

    roots.forEach(r => addWithChildren(r, 0));
    return result;
  }

  function autoSetChartRange(entries) {
    const inputStart = document.getElementById('chartStartDate').value;
    if (chartStart && inputStart) return;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    let earliest = new Date(today), latest = new Date(today);
    latest.setDate(latest.getDate() + 90);

    entries.forEach(e => {
      const s = parseDate(e.start_date), en = parseDate(e.end_date);
      if (s && s < earliest) earliest = s;
      if (en && en > latest)  latest   = en;
    });
    earliest.setDate(earliest.getDate() - 7);
    latest.setDate(latest.getDate() + 14);
    chartStart = earliest;
    chartEnd   = latest;
  }

})();
