'use strict';

// ==========================================================================
// OnlineProjectPlanner – Gantt Chart Module
//
// Features:
//  • Time-scaled ruler (day / week / month zoom)
//  • Drag bar body        → move entry (changes start + end together)
//  • Drag LEFT handle     → resize: changes start_date only
//  • Drag RIGHT handle    → resize: changes end_date only
//  • Dependency nodes     → output node (right edge) + input node (left edge), darker-shade circles
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
  const ROW_H    = 40;  // px default row height
  const MIN_DAYS = 1;   // minimum bar width in days
  const MIN_BEZIER_CP = 20; // minimum bezier control-point distance (px) for dep arrows
  const NARROW_BAR_PX = 60; // px threshold: bars narrower than this get overflow-visible text
  const HIDE_LABEL_PX = 30; // px threshold: bars narrower than this hide the label entirely
  const DEFAULT_TASK_COL_WIDTH = 260; // px default task column width
  const MIN_TASK_COL_WIDTH = 120;     // px minimum task column width when resizing
  const MAX_TASK_COL_WIDTH = 600;     // px maximum task column width when resizing

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
  // rowYMap: entryId -> Y-center position in px (accounts for variable row heights)
  let rowYMap = {};
  let timelineContextRowId = null;
  let _sanitizeIntervalId = null;    // periodic recalculation timer
  const _pendingRowHeightFix = new Set(); // entry IDs whose row_height needs DB reset

  // ─── Sanitize entries ────────────────────────────────────────────────────
  // Remove orphaned entries whose parent no longer exists (cascade), and
  // clear stale same_row references.  This ensures hours always reflect
  // exactly what the user can see.
  function sanitizeEntries() {
    const state = S();
    if (!state || !state.ganttEntries) return false;

    let changed = false;

    // 1. Detect orphaned entries (parent_id points to a non-existent entry).
    //    These are remnants of subtree deletions that didn't fully propagate.
    //    Remove them recursively (their children are orphans too).
    let removedThisPass;
    do {
      removedThisPass = false;
      const currentIds = new Set(state.ganttEntries.map(e => e.id));
      const toRemove = new Set();
      state.ganttEntries.forEach(e => {
        if (e.parent_id && !currentIds.has(e.parent_id)) {
          // parent_id doesn't reference currentParentId (drill-down root) either
          if (e.parent_id !== currentParentId) {
            toRemove.add(e.id);
          }
        }
      });
      if (toRemove.size > 0) {
        state.ganttEntries = state.ganttEntries.filter(e => !toRemove.has(e.id));
        state.dependencies = state.dependencies.filter(
          d => !toRemove.has(d.source_id) && !toRemove.has(d.target_id)
        );
        removedThisPass = true;
        changed = true;
      }
    } while (removedThisPass);

    // 2. Clear stale same_row references
    const finalIds = new Set(state.ganttEntries.map(e => e.id));
    state.ganttEntries.forEach(e => {
      if (e.same_row && !finalIds.has(e.same_row)) {
        e.same_row = null;
        changed = true;
      }
    });

    // 3. Reset row_height values that are below the enforced UI minimum (28 px).
    //    Values below this threshold can only have been written by an older buggy
    //    code path (e.g. accidentally saving a lane height instead of the full
    //    row height).  getEntryRowHeight() already clamps for rendering, but
    //    clearing the stored value entirely restores the default ROW_H so bars
    //    appear at their correct full height again.  IDs are queued for DB
    //    persistence so the fix survives page reloads.
    state.ganttEntries.forEach(e => {
      const h = parseInt(e.row_height, 10);
      if (Number.isFinite(h) && h < 28) {
        e.row_height = null;
        _pendingRowHeightFix.add(e.id);
        changed = true;
      }
    });

    return changed;
  }

  function getEntryRowLabel(entry) {
    return (entry.row_label && entry.row_label.trim()) || entry.title || '';
  }

  function getEntryRowHeight(entry) {
    const h = parseInt(entry && entry.row_height, 10);
    return Number.isFinite(h) ? Math.max(28, Math.min(500, h)) : ROW_H;
  }

  // Returns the number of visual lanes needed for entry's row by simulating
  // the greedy overlap algorithm on all bars (owner + same_row guests) without
  // touching the DOM.  Requires chartStart / chartEnd / pxPerDay to be set.
  // Results are memoized in _laneCountCache for the duration of one render.
  function computeLaneCount(entry) {
    if (!chartStart || !chartEnd || !pxPerDay) return 1;
    if (_laneCountCache && _laneCountCache.has(entry.id)) {
      return _laneCountCache.get(entry.id);
    }

    function barInterval(e) {
      if (+e.row_only) return null;
      const start = parseDate(e.start_date);
      const end   = parseDate(e.end_date);
      if (!start || !end || start > chartEnd || end < chartStart) return null;
      const clippedStart = start < chartStart ? chartStart : start;
      const leftDays  = daysBetween(chartStart, clippedStart);
      const widthDays = Math.max(MIN_DAYS, daysBetween(clippedStart, end));
      const left  = leftDays * pxPerDay;
      return { left, right: left + widthDays * pxPerDay };
    }

    const intervals = [];
    const ownerIv = barInterval(entry);
    if (ownerIv) intervals.push(ownerIv);
    S().ganttEntries.forEach(g => {
      if (g.same_row !== entry.id) return;
      const iv = barInterval(g);
      if (iv) intervals.push(iv);
    });

    if (intervals.length <= 1) {
      if (_laneCountCache) _laneCountCache.set(entry.id, 1);
      return 1;
    }

    intervals.sort((a, b) => a.left - b.left);
    const lanes = [];
    intervals.forEach(iv => {
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        const last = lanes[i][lanes[i].length - 1];
        // 0.5 px tolerance absorbs sub-pixel rounding without misclassifying
        // genuinely adjacent (touching) bars as overlapping.
        if (last.right <= iv.left + 0.5) { lanes[i].push(iv); placed = true; break; }
      }
      if (!placed) lanes.push([iv]);
    });
    const result = lanes.length;
    if (_laneCountCache) _laneCountCache.set(entry.id, result);
    return result;
  }

  // Returns the row height to use for rendering, expanded to accommodate
  // same-row lane splitting so that every lane keeps full-height bars.
  // Formula: max(storedHeight, laneCount × ROW_H) which guarantees each
  // lane has (ROW_H - barPad*2) ≈ 32 px of bar space.
  function getEffectiveEntryRowHeight(entry) {
    const stored = getEntryRowHeight(entry);
    const lanes  = computeLaneCount(entry);
    return lanes > 1 ? Math.max(stored, lanes * ROW_H) : stored;
  }

  function getSnapDaysForCurrentScale() {
    if (scale === 'month') return 7; // month view snaps to weeks
    return 1; // week/day view snaps to days
  }

  // ── clipboard state ────────────────────────────────────────────────────────
  let clipboardData = null; // { entries: Entry[], rootIds: number[], cut: boolean }

  // ── multi-select range tracking ────────────────────────────────────────────
  let lastClickedId = null; // last task clicked without shift – used for range select

  // ── timeline selection drag state ─────────────────────────────────────────
  const timelineSel = {
    active: false,
    startDay: 0,
    endDay: 0,
    mouseStartX: 0,
    mouseStartY: 0,      // Y coordinate when drag started
    startRowIndex: -1,   // row index where drag started
    endRowIndex: -1,     // row index at current mouse position
    shiftKey: false,     // whether Shift was held when the drag began
    overlayEl: null,
    rowTop: 0,       // top px of the row where drag started (kept for compat)
    rowIndex: -1,    // index of the row where drag started (kept for compat)
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
    snapActivePx: null,       // current snap target pixel (null = not snapping)
    snapTargetEntryId: null,  // entry whose edge is currently snapped to
    // ── vertical row-drag fields ──────────────────────────────────────────
    startY: 0,                  // initial pageY for vertical tracking
    origRowIndex: -1,           // index of entry's row in visibleEntries()
    parentRowBg: null,          // the .gantt-row-bg element containing the bar
    rowDropMode: null,          // null | 'onto' | 'between-before' | 'between-after'
    rowDropTargetId: null,      // id of the target row entry
    rowDropIndicatorEl: null,   // blue dotted indicator in timeline
    rowDropIndicatorTaskEl: null, // matching indicator in task list
  };

  // ── connecting state ──────────────────────────────────────────────────────
  const conn = {
    active: false,
    sourceId: null,
    tempLine: null,     // SVG <path> for rubber-band
    sx: 0,              // source x (right edge of bar)
    sy: 0,              // source y (vertical centre of row)
  };

  // ── share-row linking state ────────────────────────────────────────────────
  const shareRowLink = {
    active: false,
    sourceId: null,     // entry being linked (will get same_row set)
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

  // ── lane-count memoization cache (reset at the start of each render) ─────
  // computeLaneCount() may be called multiple times per entry per render cycle
  // (once each from renderTaskList, renderRowsAndBars, renderHoursPanel, and
  // rowYMap).  Caching by entry.id avoids re-iterating ganttEntries each time.
  let _laneCountCache = null; // Map<entryId, number> | null

  const rowHeightDrag = {
    active: false,
    entryId: null,
    startY: 0,
    startHeight: ROW_H,
  };

  // ── Long-press touch-drag state ────────────────────────────────────────────
  let _lpTimer   = null;  // setTimeout handle for long-press detection
  let _lpTouchId = null;  // Touch.identifier being tracked
  let _lpStartX  = 0;     // initial touch X (clientX / pageX depending on context)
  let _lpStartY  = 0;
  const _LP_DELAY     = 500; // ms hold required to activate drag
  const _LP_THRESHOLD = 8;   // px movement that cancels the long-press

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  let ganttTaskList, ganttRows, ganttRuler, ganttBreadcrumb,
      ganttTimeline, intensityBarCanvas, intensityBarWrapper, ganttHoursPanel;

  // ── Shared hover tooltip (one element reused by all bars) ─────────────────
  let _barTooltipEl = null;
  let _barTooltipX = 0, _barTooltipY = 0; // last known cursor position
  function _getBarTooltip() {
    if (!_barTooltipEl) {
      _barTooltipEl = document.createElement('div');
      _barTooltipEl.className = 'gantt-bar-tooltip';
      document.body.appendChild(_barTooltipEl);
    }
    return _barTooltipEl;
  }
  function _showBarTooltip(entry, color, textColor, clientX, clientY) {
    _barTooltipX = clientX;
    _barTooltipY = clientY;
    const tip = _getBarTooltip();
    tip.style.background = color;
    tip.style.color = textColor;
    const dates = entry.start_date + ' → ' + entry.end_date;
    const hours = entry.hours_estimate ? +entry.hours_estimate + 'h estimated' : '';
    tip.innerHTML =
      '<div class="gantt-bar-tooltip-title">' + _esc(entry.title) + '</div>' +
      '<div class="gantt-bar-tooltip-meta">' + _esc(dates) + (hours ? '&ensp;·&ensp;' + _esc(hours) : '') + '</div>' +
      (entry.notes ? '<div class="gantt-bar-tooltip-notes">' + _esc(entry.notes) + '</div>' : '');
    // Make visible and position after first layout pass so dimensions are known
    tip.classList.add('visible');
    requestAnimationFrame(() => _positionBarTooltip(tip, _barTooltipX, _barTooltipY));
  }
  function _positionBarTooltip(tip, clientX, clientY) {
    _barTooltipX = clientX;
    _barTooltipY = clientY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const offset = 14;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const left = (clientX + offset + tw > vw - 8) ? Math.max(4, clientX - tw - offset) : clientX + offset;
    const top  = (clientY + offset + th > vh - 8) ? Math.max(4, clientY - th - offset) : clientY + offset;
    tip.style.left = left + 'px';
    tip.style.top  = top  + 'px';
  }
  function _hideBarTooltip() {
    if (_barTooltipEl) _barTooltipEl.classList.remove('visible');
  }
  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── snap indicator lines (two lines: one per edge) ───────────────────────
  let snapLineEl  = null;
  let snapLine2El = null;

  function _setSnapLineRowBounds(el) {
    const dragRowIdx = (drag.entryId !== null && rowIndexMap[drag.entryId] !== undefined)
      ? rowIndexMap[drag.entryId] : 0;
    const snapRowIdx = (drag.snapTargetEntryId !== null && rowIndexMap[drag.snapTargetEntryId] !== undefined)
      ? rowIndexMap[drag.snapTargetEntryId] : dragRowIdx;
    const topRow = Math.min(dragRowIdx, snapRowIdx);
    const botRow = Math.max(dragRowIdx, snapRowIdx);
    el.style.top    = (topRow * ROW_H) + 'px';
    el.style.height = ((botRow - topRow + 1) * ROW_H) + 'px';
  }

  let _snapLineVisible = false;

  function showSnapLine(px) {
    if (!ganttRows) return;
    if (!snapLineEl) {
      snapLineEl = document.createElement('div');
      snapLineEl.className = 'gantt-snap-line';
      ganttRows.appendChild(snapLineEl);
    }
    snapLineEl.style.left = px + 'px';
    _setSnapLineRowBounds(snapLineEl);
    if (!_snapLineVisible) { _snapLineVisible = true; window.soundsModule?.play('snap_line'); }
    snapLineEl.style.display = 'block';
  }

  function showSnapLine2(px) {
    if (!ganttRows) return;
    if (!snapLine2El) {
      snapLine2El = document.createElement('div');
      snapLine2El.className = 'gantt-snap-line';
      ganttRows.appendChild(snapLine2El);
    }
    snapLine2El.style.left = px + 'px';
    _setSnapLineRowBounds(snapLine2El);
    snapLine2El.style.display = 'block';
  }

  function hideSnapLine() {
    _snapLineVisible = false;
    if (snapLineEl)  snapLineEl.style.display  = 'none';
    if (snapLine2El) snapLine2El.style.display = 'none';
  }


  /**
   * Get the display colour for an entry.  When inline-expanded (depth > 0)
   * the colour is derived from the root visible ancestor, lightened by depth.
   * If the subtask has its own colour variation that differs from the parent,
   * use the subtask's colour (still lightened by depth).
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
      // If the subtask has its own colour variation that differs from the
      // parent's, honour it (still lightened by depth for visual distinction).
      const ownVar = entry.color_variation || 0;
      const ancestorVar = ancestor.color_variation || 0;
      if (ownVar !== ancestorVar) {
        const ownColor = U().getUserColor(entry.user_id, entry.color_variation);
        return U().lightenColor(ownColor, depth * 0.15);
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
    const sel = S().selectedGanttIds;
    if (sel.size === 0) return;
    if (sel.size > 1) {
      const entries = S().ganttEntries.filter(e => sel.has(e.id));
      if (entries.length > 0) showBulkEditModal(entries);
      return;
    }
    const id = [...sel][0];
    const entry = S().ganttEntries.find(e => e.id === id);
    if (entry) showEditEntryModal(entry);
  }

  // =========================================================================
  // Public API
  // =========================================================================
  window.ganttModule = { init, render, showAddEntryModal, copySelected, pasteAtDate, zoomIn, zoomOut, editSelected, setSnapPx, setSnapEnabled, setProximityPx };

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
    if (ganttRuler) ganttRuler.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rect      = ganttRuler.getBoundingClientRect();
      const x         = e.clientX - rect.left + ganttTimeline.scrollLeft;
      const dayOffset = Math.floor(x / pxPerDay);
      const dateStr   = toDateStr(addDays(chartStart, dayOffset));
      U().showContextMenu(e.pageX, e.pageY, [
        { icon: '\uD83D\uDEA9', label: 'Add milestone here (' + dateStr + ')',
          action: () => showAddMilestoneModal(dateStr) },
      ]);
    });
    if (intensityBarWrapper) intensityBarWrapper.addEventListener('wheel', wheelZoom, { passive: false });

    // Global mouse/key events
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (conn.active) { cancelConnecting(); return; }
        if (shareRowLink.active) { cancelShareRow(); return; }
        if (timelineSel.overlayEl) { clearTimelineSelection(); return; }
        // Go back one drill-down level
        if (parentStack.length && !document.querySelector('.modal.show')) {
          parentStack.pop();
          currentParentId = parentStack.length ? parentStack[parentStack.length - 1].entry.id : null;
          chartStart = null;
          chartEnd   = null;
          render();
        }
      }
    });

    const cancelBtn = document.getElementById('cancelConnecting');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelConnecting);
    const cancelShareRowBtn = document.getElementById('cancelShareRow');
    if (cancelShareRowBtn) cancelShareRowBtn.addEventListener('click', cancelShareRow);

    // Cancel connecting/share-row by clicking empty timeline space
    ganttTimeline.addEventListener('click', (e) => {
      if (conn.active) {
        if (!e.target.closest('.gantt-bar-container')) cancelConnecting();
        return;
      }
      if (shareRowLink.active) {
        if (!e.target.closest('.gantt-bar-container')) cancelShareRow();
        return;
      }
      // Clear date-range selection when clicking on an empty spot
      if (!e.target.closest('.gantt-bar-container') && !e.target.closest('.gantt-time-selection')) {
        clearTimelineSelection();
      }
    });

    // Cancel connecting/share-row by clicking empty space in task list
    ganttTaskList.addEventListener('click', (e) => {
      if (conn.active && !e.target.closest('.gantt-task-row')) { cancelConnecting(); return; }
      if (shareRowLink.active && !e.target.closest('.gantt-task-row')) { cancelShareRow(); return; }
    });

    // Cancel connecting/share-row on right-click anywhere
    document.addEventListener('contextmenu', (e) => {
      if (conn.active) { e.preventDefault(); cancelConnecting(); }
      if (shareRowLink.active) { e.preventDefault(); cancelShareRow(); }
    });

    // Toggle dependency arrows – driven by the settings checkbox
    const showArrowsCheck = document.getElementById('settingsShowArrows');
    if (showArrowsCheck) {
      depsVisible = showArrowsCheck.checked;
      ganttTimeline.classList.toggle('deps-hidden', !depsVisible);
      showArrowsCheck.addEventListener('change', () => {
        depsVisible = showArrowsCheck.checked;
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

      // Draggable column-width resizer at the right edge of the header
      const colResizer = document.createElement('div');
      colResizer.className = 'gantt-task-col-resizer';
      colResizer.title = 'Drag to resize task column';
      colResizer.addEventListener('mousedown', (e) => {
        if (taskListCollapsed) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--task-col-w')) || DEFAULT_TASK_COL_WIDTH;
        colResizer.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        const onMove = (mv) => {
          const newW = Math.max(MIN_TASK_COL_WIDTH, Math.min(MAX_TASK_COL_WIDTH, startW + (mv.clientX - startX)));
          document.documentElement.style.setProperty('--task-col-w', newW + 'px');
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          colResizer.classList.remove('active');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          const finalW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--task-col-w')) || DEFAULT_TASK_COL_WIDTH;
          localStorage.setItem('ganttTaskColW', finalW);
          render();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      tasksHeader.appendChild(colResizer);

      // Restore saved column width from localStorage
      const savedColW = parseInt(localStorage.getItem('ganttTaskColW'));
      if (savedColW >= MIN_TASK_COL_WIDTH && savedColW <= MAX_TASK_COL_WIDTH) {
        document.documentElement.style.setProperty('--task-col-w', savedColW + 'px');
      }
    }

    // Move breadcrumb above the gantt container for better visibility
    const ganttContainer = document.getElementById('ganttContainer');
    if (ganttBreadcrumb && ganttContainer && ganttContainer.parentNode) {
      ganttContainer.parentNode.insertBefore(ganttBreadcrumb, ganttContainer);
    }

    // Right-click on empty timeline space → add task at clicked date
    ganttTimeline.addEventListener('contextmenu', onTimelineContextMenu);

    // Right-click on empty task-list space → add empty row
    ganttTaskList.addEventListener('contextmenu', (e) => {
      if (conn.active || shareRowLink.active || reparentDrag.active) return;
      if (e.target.closest('.gantt-task-row')) return; // let task-row handler fire
      e.preventDefault();
      const menuItems = [
        { icon: '▤', label: 'Add empty row/category', action: () => showAddEmptyRowModal() },
        { icon: '+', label: 'Add task',                action: () => showAddEntryModal() },
      ];
      if (clipboardData) {
      menuItems.push({ icon: '\uD83D\uDCCB', label: 'Paste here', action: () => pasteEntries(null) });
      }
      U().showContextMenu(e.pageX, e.pageY, menuItems);
    });

    // Left-button drag on empty timeline → marquee selection
    ganttTimeline.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (conn.active || drag.active) return;
      if (e.target.closest('.gantt-bar-container') || e.target.closest('.gantt-bar')) return;

      // Clear any existing selection overlay
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

      timelineSel.active         = true;
      timelineSel.startDay       = day;
      timelineSel.endDay         = day;
      timelineSel.mouseStartX    = e.pageX;
      timelineSel.mouseStartY    = e.pageY;
      timelineSel.startRowIndex  = rowIndex;
      timelineSel.endRowIndex    = rowIndex;
      timelineSel.shiftKey       = e.shiftKey;
      timelineSel.rowTop         = rowTop;
      timelineSel.rowIndex       = rowIndex;

      const overlay = document.createElement('div');
      overlay.className = 'gantt-time-selection';
      overlay.style.cssText = 'left:' + (day * pxPerDay) + 'px;width:' + pxPerDay + 'px;' +
                               'top:' + rowTop + 'px;height:' + ROW_H + 'px;';
      ganttRows.appendChild(overlay);
      timelineSel.overlayEl = overlay;
    });

    // Periodic recalculation: sanitize stale entries and re-render every
    // 60 seconds so deleted-task hours never linger in the totals.
    // Also persists any row_height corrections queued by sanitizeEntries()
    // so they survive across page reloads.
    if (_sanitizeIntervalId) clearInterval(_sanitizeIntervalId);
    let _sanitizeBusy = false;
    _sanitizeIntervalId = setInterval(async () => {
      if (!S().currentProject || _sanitizeBusy) return;
      _sanitizeBusy = true;
      try {
        // Drain the set of IDs whose corrupted row_height (< 28 px) was already
        // cleared in JS state by sanitizeEntries().  Persist null to the DB in
        // parallel so the fix is not lost on the next page load.  Re-queue any
        // IDs whose API call failed so they are retried on the next tick.
        if (_pendingRowHeightFix.size > 0) {
          const ids = [..._pendingRowHeightFix];
          _pendingRowHeightFix.clear();
          const results = await Promise.allSettled(
            ids.map(id => API('PUT', '/api/gantt/' + id, { row_height: null }))
          );
          results.forEach((result, i) => {
            if (result.status === 'rejected') _pendingRowHeightFix.add(ids[i]);
          });
        }
        render();
      } finally {
        _sanitizeBusy = false;
      }
    }, 60000);

    render();
  }

  function clearTimelineSelection() {
    if (timelineSel.overlayEl && timelineSel.overlayEl.parentNode) {
      timelineSel.overlayEl.parentNode.removeChild(timelineSel.overlayEl);
    }
    timelineSel.active    = false;
    timelineSel.overlayEl = null;
  }

  // Select all gantt entries whose bar visually overlaps the current marquee.
  // addToExisting = true → Shift-mode: add to selection; false → replace.
  function selectEntriesInMarquee(addToExisting) {
    const startRow = Math.min(timelineSel.startRowIndex, timelineSel.endRowIndex);
    const endRow   = Math.max(timelineSel.startRowIndex, timelineSel.endRowIndex);
    const startDay = Math.min(timelineSel.startDay, timelineSel.endDay);
    const endDay   = Math.max(timelineSel.startDay, timelineSel.endDay);

    const selStartDate = addDays(chartStart, startDay);
    const selEndDate   = addDays(chartStart, endDay);

    if (!addToExisting) S().selectedGanttIds.clear();

    S().ganttEntries.forEach(entry => {
      const rowIdx = rowIndexMap[entry.id];
      if (rowIdx === undefined || rowIdx < startRow || rowIdx > endRow) return;
      const entryStart = parseDate(entry.start_date);
      const entryEnd   = parseDate(entry.end_date);
      if (!entryStart || !entryEnd) return;
      // Overlap: entry ends on or after selection start, starts on or before selection end
      if (entryEnd >= selStartDate && entryStart <= selEndDate) {
        S().selectedGanttIds.add(entry.id);
      }
    });

    U().updateDeleteBtn();
    render();
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
    if (conn.active || shareRowLink.active) return;
    if (e.target.closest('.gantt-bar-container') || e.target.closest('.gantt-bar')) return;

    e.preventDefault();

    const rect      = ganttTimeline.getBoundingClientRect();
    const x         = e.clientX - rect.left + ganttTimeline.scrollLeft;
    const dayOffset = Math.floor(x / pxPerDay);
    const clickDate = addDays(chartStart, dayOffset);
    const dateStr   = toDateStr(clickDate);
    const rowBg = e.target.closest('.gantt-row-bg');
    timelineContextRowId = rowBg ? rowBg.dataset.id : null;

    const items = [];

    // If a range selection is active, offer to add a task spanning that range
    if (timelineSel.overlayEl) {
      const selStart = Math.min(timelineSel.startDay, timelineSel.endDay);
      const selEnd   = Math.max(timelineSel.startDay, timelineSel.endDay);
      const selStartStr = toDateStr(addDays(chartStart, selStart));
      const selEndStr   = toDateStr(addDays(chartStart, selEnd + 1));
      items.push({ icon: '+', label: 'Add task for selection (' + selStartStr + ' – ' + selEndStr + ')',
        action: () => { clearTimelineSelection(); showAddEntryModal(undefined, selStartStr, selEndStr, timelineContextRowId); } });
      items.push({ separator: true });
    }

    items.push({ icon: '\uD83D\uDEA9', label: 'Add milestone here (' + dateStr + ')',
      action: () => showAddMilestoneModal(dateStr) });

    items.push({ icon: '+', label: 'Add task here (' + dateStr + ')',
      action: () => showAddEntryModal(undefined, dateStr, toDateStr(addDays(clickDate, 7)), timelineContextRowId) });
    items.push({ icon: '▤', label: 'Add empty row/category',
      action: () => showAddEmptyRowModal() });

    if (clipboardData) {
      items.push({ icon: '📋', label: 'Paste task here',
        action: () => pasteEntries(dateStr) });
    }

    // ── Quick settings submenu ─────────────────────────────────────────────
    items.push({ separator: true });
    items.push({
      icon: '⚙',
      label: 'Settings',
      children: [
        {
          icon: snapEnabled ? '\u2713' : '',
          label: 'Snap to task edges',
          action: () => {
            const nv = !snapEnabled;
            setSnapEnabled(nv);
            const cb = document.getElementById('settingsSnapEnabled');
            if (cb) cb.checked = nv;
          },
        },
        {
          icon: depsVisible ? '\u2713' : '',
          label: 'Show dependency arrows',
          action: () => {
            depsVisible = !depsVisible;
            ganttTimeline.classList.toggle('deps-hidden', !depsVisible);
            const cb = document.getElementById('settingsShowArrows');
            if (cb) cb.checked = depsVisible;
            render();
          },
        },
        {
          icon: document.documentElement.classList.contains('dark-mode') ? '\u2713' : '',
          label: 'Dark mode',
          action: () => {
            const nv = !document.documentElement.classList.contains('dark-mode');
            localStorage.setItem('ganttDarkMode', nv);
            document.documentElement.classList.toggle('dark-mode', nv);
            const cb = document.getElementById('settingsDarkMode');
            if (cb) cb.checked = nv;
          },
        },
      ],
    });

    U().showContextMenu(e.pageX, e.pageY, items);
  }

  // =========================================================================
  // Render
  // =========================================================================
  function render() {
    if (!S().currentProject) return;

    // Reset per-render memoization caches.
    _laneCountCache = new Map();

    // Sanitize stale data (orphaned entries, broken same_row refs)
    // so that hours always match what the user can see.
    sanitizeEntries();

    const entries   = visibleEntries();
    const wasFreshRange = !chartStart;
    autoSetChartRange(entries);
    if (wasFreshRange) {
      pxPerDay = minPxPerDayForFit();
      autoScale();
    }

    const totalDays = Math.max(1, daysBetween(chartStart, chartEnd));
    const timelineW = totalDays * pxPerDay;

    document.getElementById('chartStartDate').value = toDateStr(chartStart);
    document.getElementById('chartEndDate').value   = toDateStr(chartEnd);

    // Rebuild row-index map
    rowIndexMap = {};
    entries.forEach((e, i) => { rowIndexMap[e.id] = i; });

    // Map same-row entries to their target's row index
    S().ganttEntries.forEach(e => {
      if (e.same_row && rowIndexMap[e.same_row] !== undefined) {
        rowIndexMap[e.id] = rowIndexMap[e.same_row];
      }
    });

    // Build cumulative Y-center map (accounts for variable row heights,
    // including auto-expansion for same-row lane splitting).
    rowYMap = {};
    let cumulativeY = 0;
    entries.forEach(e => {
      const h = getEffectiveEntryRowHeight(e);
      rowYMap[e.id] = cumulativeY + h / 2;
      cumulativeY += h;
    });
    // Same-row entries share the owner's Y center
    S().ganttEntries.forEach(e => {
      if (e.same_row && rowYMap[e.same_row] !== undefined) {
        rowYMap[e.id] = rowYMap[e.same_row];
      }
    });

    renderTaskList(entries);
    renderRuler(timelineW, totalDays);
    renderRowsAndBars(entries, timelineW);
    renderMilestones();
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
      const rowIsExpanded = getEffectiveEntryRowHeight(entry) > ROW_H;

      const row = document.createElement('div');
      row.className = 'gantt-task-row'
        + (S().selectedGanttIds.has(entry.id) ? ' selected' : '')
        + (isCompleted ? ' gantt-completed' : '')
        + (rowIsExpanded ? ' row-expanded' : '');
      row.dataset.id = entry.id;
      row.style.minHeight = getEffectiveEntryRowHeight(entry) + 'px';

      // Drag handle for reparenting / reordering
      const grip = document.createElement('span');
      grip.className = 'gantt-task-grip';
      grip.innerHTML = '<svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor" aria-hidden="true">' +
        '<circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>' +
        '<circle cx="2" cy="6" r="1.2"/><circle cx="6" cy="6" r="1.2"/>' +
        '<circle cx="2" cy="10" r="1.2"/><circle cx="6" cy="10" r="1.2"/>' +
        '</svg>';
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
        check.textContent = '\u2705'; // ✅
        check.title = 'Task completed';
        row.appendChild(check);
      }

      // Name
      const name = document.createElement('span');
      name.className = 'gantt-task-name';
      name.textContent = getEntryRowLabel(entry);
      name.title = 'Row: ' + getEntryRowLabel(entry) + '\nTask: ' + entry.title + (entry.notes ? '\n\n' + entry.notes : '');
      name.addEventListener('dblclick', async (e) => {
        e.stopPropagation();
        const newLabel = prompt('Edit row name', getEntryRowLabel(entry));
        if (newLabel === null) return;
        try {
          const data = await API('PUT', '/api/gantt/' + entry.id, { row_label: newLabel });
          const idx = S().ganttEntries.findIndex(en => en.id === entry.id);
          if (idx !== -1) S().ganttEntries[idx] = data.entry;
          render();
        } catch (err) {
          alert('Failed to rename row: ' + err.message);
        }
      });
      row.appendChild(name);

      const rowResize = document.createElement('span');
      rowResize.className = 'gantt-row-resize-handle';
      rowResize.title = 'Drag to change row height';
      rowResize.textContent = '⋮';
      rowResize.addEventListener('mousedown', (e) => startRowHeightDrag(e, entry.id));
      row.appendChild(rowResize);

      // Same-row badge (show count of tasks sharing this row)
      const sameRowCount = S().ganttEntries.filter(e => e.same_row === entry.id).length;
      if (sameRowCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'gantt-same-row-badge';
        badge.textContent = '+' + sameRowCount;
        badge.title = sameRowCount + ' additional task' + (sameRowCount > 1 ? 's' : '') + ' sharing this row';
        row.appendChild(badge);
      }

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

      // Row height expand/collapse toggle (⊕ expand to double height, ⊖ collapse to default)
      const expandToggleBtn = makeBtn(rowIsExpanded ? '\u229F' : '\u229E', rowIsExpanded ? 'Collapse row height' : 'Expand row height', async () => {
        const currentH = getEntryRowHeight(entry);
        const newH = currentH > ROW_H ? ROW_H : ROW_H * 2;
        const idx = S().ganttEntries.findIndex(en => en.id === entry.id);
        if (idx === -1) return;
        S().ganttEntries[idx].row_height = newH;
        render();
        try { await API('PUT', '/api/gantt/' + entry.id, { row_height: newH }); } catch (_) {}
      });
      actions.appendChild(expandToggleBtn);

      actions.appendChild(makeBtn('\u270F', 'Edit',         () => showEditEntryModal(entry)));

      const hasTodo = S().todos.some(t => t.gantt_entry_id === entry.id);
      const todoBtn = makeBtn(hasTodo ? '\u2713' : '\u2611', 'Add to Todo', () => { if (!hasTodo) addToTodo(entry); });
      if (hasTodo) { todoBtn.style.color = '#2e7d32'; todoBtn.title = 'Already in Todo list'; }
      actions.appendChild(todoBtn);

      actions.appendChild(makeBtn('+',      'Add sub-task', () => showAddEntryModal(entry.id)));
      actions.appendChild(makeBtn('\uD83D\uDDD1', 'Delete', () => deleteEntry(entry)));
      row.appendChild(actions);

      // Selection / connecting / share-row
      row.addEventListener('click', (e) => {
        // When in connecting mode, clicking a task list row finishes the connection
        if (conn.active) {
          if (conn.sourceId !== entry.id) {
            e.stopPropagation();
            finishConnecting(entry);
          }
          return;
        }
        // When in share-row mode, clicking a task list row finishes the share
        if (shareRowLink.active) {
          if (shareRowLink.sourceId !== entry.id) {
            e.stopPropagation();
            finishShareRow(entry);
          }
          return;
        }
        if (e.shiftKey && lastClickedId) {
          // Range select: select all visible entries between lastClickedId and this one
          const vis = visibleEntries();
          const aIdx = vis.findIndex(en => en.id === lastClickedId);
          const bIdx = vis.findIndex(en => en.id === entry.id);
          if (aIdx !== -1 && bIdx !== -1) {
            const lo = Math.min(aIdx, bIdx);
            const hi = Math.max(aIdx, bIdx);
            for (let i = lo; i <= hi; i++) {
              S().selectedGanttIds.add(vis[i].id);
            }
          } else {
            // Fallback: just toggle the clicked entry
            S().selectedGanttIds.has(entry.id)
              ? S().selectedGanttIds.delete(entry.id)
              : S().selectedGanttIds.add(entry.id);
          }
        } else if (e.shiftKey) {
          // Shift with no prior anchor: toggle this entry
          S().selectedGanttIds.has(entry.id)
            ? S().selectedGanttIds.delete(entry.id)
            : S().selectedGanttIds.add(entry.id);
          lastClickedId = entry.id;
        } else {
          S().selectedGanttIds.clear();
          S().selectedGanttIds.add(entry.id);
          lastClickedId = entry.id;
        }
        U().updateDeleteBtn();
        render();
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // contextmenu is handled globally when connecting/share-row; also skip during drag
        if (conn.active || shareRowLink.active || reparentDrag.active) return;
        showEntryContextMenu(e.pageX, e.pageY, entry);
      });

      // ── Touch: long-press on row to start reparent / reorder drag ──────────
      row.addEventListener('touchstart', (e) => {
        if (reparentDrag.active || drag.active || conn.active) return;
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        _lpTouchId = t.identifier;
        _lpStartX  = t.clientX;
        _lpStartY  = t.clientY;
        row.classList.add('long-press-pending');
        _lpTimer = setTimeout(() => {
          row.classList.remove('long-press-pending');
          if (navigator.vibrate) navigator.vibrate(10);
          startReparentDrag(_touchProxy(t), entry, row);
          // startReparentDrag adds mouse listeners – swap them for touch listeners
          document.removeEventListener('mousemove', onReparentMove);
          document.removeEventListener('mouseup',   onReparentUp);
          document.addEventListener('touchmove',   _onReparentTouchMove,  { passive: false });
          document.addEventListener('touchend',    _onReparentTouchEnd);
          document.addEventListener('touchcancel', _onReparentTouchEnd);
        }, _LP_DELAY);
      }, { passive: true });

      row.addEventListener('touchmove', (e) => {
        if (!_lpTimer) return;
        const t = _findTouch(e.changedTouches, _lpTouchId);
        if (!t) return;
        if (Math.abs(t.clientX - _lpStartX) > _LP_THRESHOLD ||
            Math.abs(t.clientY - _lpStartY) > _LP_THRESHOLD) {
          _lpCancel(row);
        }
      }, { passive: true });

      row.addEventListener('touchend',    () => _lpCancel(row));
      row.addEventListener('touchcancel', () => _lpCancel(row));

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

  function startRowHeightDrag(e, entryId) {
    e.preventDefault();
    e.stopPropagation();
    const entry = S().ganttEntries.find(en => en.id === entryId);
    if (!entry) return;
    rowHeightDrag.active = true;
    rowHeightDrag.entryId = entryId;
    rowHeightDrag.startY = e.clientY;
    rowHeightDrag.startHeight = getEntryRowHeight(entry);
    document.addEventListener('mousemove', onRowHeightDragMove);
    document.addEventListener('mouseup', onRowHeightDragUp);
  }

  function onRowHeightDragMove(e) {
    if (!rowHeightDrag.active) return;
    const newHeight = Math.max(28, Math.min(500, rowHeightDrag.startHeight + (e.clientY - rowHeightDrag.startY)));
    const idx = S().ganttEntries.findIndex(en => en.id === rowHeightDrag.entryId);
    if (idx === -1) return;
    S().ganttEntries[idx].row_height = newHeight;
    render();
  }

  async function onRowHeightDragUp() {
    if (!rowHeightDrag.active) return;
    document.removeEventListener('mousemove', onRowHeightDragMove);
    document.removeEventListener('mouseup', onRowHeightDragUp);
    const entry = S().ganttEntries.find(en => en.id === rowHeightDrag.entryId);
    if (entry) {
      try { await API('PUT', '/api/gantt/' + entry.id, { row_height: getEntryRowHeight(entry) }); } catch (_) {}
    }
    rowHeightDrag.active = false;
    rowHeightDrag.entryId = null;
  }

  // ─── reparent / reorder drag-and-drop ────────────────────────────────────
  function startReparentDrag(e, entry, rowEl) {
    // Cancel any active marquee selection so it doesn't linger
    clearTimelineSelection();

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

  // ─── Touch / long-press helpers ───────────────────────────────────────────

  /** Cancel a pending long-press and clear visual feedback from el (if given). */
  function _lpCancel(el) {
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
    if (el) el.classList.remove('long-press-pending');
    _lpTouchId = null;
  }

  /** Build a minimal mouse-event proxy from a Touch object. */
  function _touchProxy(t) {
    return {
      clientX:  t.clientX  || 0,
      clientY:  t.clientY  || 0,
      pageX:    t.pageX    || 0,
      pageY:    t.pageY    || 0,
      shiftKey: false,
    };
  }

  /** Find a touch by identifier in a TouchList without allocating an array. */
  function _findTouch(list, id) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === id) return list[i];
    }
    return null;
  }

  // Touch handlers for reparent (task-list) drag ────────────────────────────
  function _onReparentTouchMove(e) {
    if (!reparentDrag.active) return;
    const t = _findTouch(e.touches, _lpTouchId);
    if (!t) return;
    e.preventDefault(); // stop page scroll while dragging
    onReparentMove(_touchProxy(t));
  }

  function _onReparentTouchEnd() {
    document.removeEventListener('touchmove',   _onReparentTouchMove);
    document.removeEventListener('touchend',    _onReparentTouchEnd);
    document.removeEventListener('touchcancel', _onReparentTouchEnd);
    _lpTouchId = null;
    onReparentUp({});
  }

  // Touch handlers for bar move / resize drag ───────────────────────────────
  function _onBarTouchMove(e) {
    if (!drag.active) return;
    const t = _findTouch(e.touches, _lpTouchId);
    if (!t) return;
    e.preventDefault(); // stop page scroll while dragging
    onMouseMove(_touchProxy(t));
  }

  async function _onBarTouchEnd(e) {
    document.removeEventListener('touchmove',   _onBarTouchMove);
    document.removeEventListener('touchend',    _onBarTouchEnd);
    document.removeEventListener('touchcancel', _onBarTouchEnd);
    const ch = e.changedTouches;
    const t  = _findTouch(ch, _lpTouchId) || ch[0] || {};
    _lpTouchId = null;
    await onMouseUp(_touchProxy(t));
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
    if (snapLineEl)  { snapLineEl.remove();  snapLineEl  = null; }
    if (snapLine2El) { snapLine2El.remove(); snapLine2El = null; }
    ganttRows.innerHTML   = '';

    let cumulativeRowY = 0;
    entries.forEach(entry => {
      const rowBg = document.createElement('div');
      rowBg.className     = 'gantt-row-bg';
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

      const bar = (+entry.row_only) ? null : buildBar(entry);
      if (bar) rowBg.appendChild(bar);

      // Also render bars for entries that share this row (same_row === entry.id).
      // Use the effective row height so bars are sized for the expanded row.
      const entryRowHeight = getEffectiveEntryRowHeight(entry);
      rowBg.style.height   = entryRowHeight + 'px';
      const sameRowEntries = S().ganttEntries.filter(e => e.same_row === entry.id);
      sameRowEntries.forEach(srEntry => {
        const srBar = buildBar(srEntry, entryRowHeight);
        if (srBar) rowBg.appendChild(srBar);
      });

      // ── Overlap detection: split overlapping bars into lanes ───────────
      const allContainers = rowBg.querySelectorAll('.gantt-bar-container');
      if (allContainers.length > 1) {
        const intervals = [];
        allContainers.forEach(c => {
          const l = parseFloat(c.style.left);
          const w = parseFloat(c.style.width);
          intervals.push({ el: c, left: l, right: l + w });
        });
        intervals.sort((a, b) => a.left - b.left);
        // Greedy lane assignment (calendar-style)
        const lanes = [];
        intervals.forEach(iv => {
          let placed = false;
          for (let i = 0; i < lanes.length; i++) {
            const last = lanes[i][lanes[i].length - 1];
            if (last.right <= iv.left + 0.5) {
              lanes[i].push(iv);
              iv.lane = i;
              placed = true;
              break;
            }
          }
          if (!placed) { iv.lane = lanes.length; lanes.push([iv]); }
        });
        if (lanes.length > 1) {
          const barPad = Math.max(4, Math.round(entryRowHeight * 0.1));
          const avail  = entryRowHeight - barPad * 2;
          const laneH  = avail / lanes.length;
          intervals.forEach(iv => {
            iv.el.style.top    = (barPad + iv.lane * laneH) + 'px';
            iv.el.style.height = Math.max(16, laneH) + 'px';
            // Update rowYMap so dependency arrows point to the lane center
            const barId = iv.el.dataset.id;
            if (barId) {
              rowYMap[barId] = cumulativeRowY + barPad + iv.lane * laneH + laneH / 2;
            }
          });
        }
      }

      cumulativeRowY += entryRowHeight;
      ganttRows.appendChild(rowBg);
    });

    // Re-attach selection overlay (cleared by innerHTML = '') if still active
    if (timelineSel.overlayEl) {
      ganttRows.appendChild(timelineSel.overlayEl);
    }
  }

  // Recalculate bar heights in a rowBg based on current overlap state.
  // Called both from renderRowsAndBars (via the inline logic) and live from
  // onMouseMove so bars pop to full height as soon as they stop overlapping
  // during a drag — without waiting for a full re-render.
  function _recalcRowLanes(rowBg) {
    const rh = parseFloat(rowBg.style.height);
    if (!rh) return;
    const barPad = Math.max(4, Math.round(rh * 0.1));
    const allC = rowBg.querySelectorAll('.gantt-bar-container');
    if (allC.length < 2) {
      if (allC.length === 1) {
        allC[0].style.top    = barPad + 'px';
        allC[0].style.height = Math.max(16, rh - barPad * 2) + 'px';
      }
      return;
    }
    const ivs = [];
    allC.forEach(c => {
      const l = parseFloat(c.style.left);
      const w = parseFloat(c.style.width);
      ivs.push({ el: c, left: l, right: l + w });
    });
    ivs.sort((a, b) => a.left - b.left);
    const lanes = [];
    ivs.forEach(iv => {
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i][lanes[i].length - 1].right <= iv.left + 0.5) {
          lanes[i].push(iv); iv.lane = i; placed = true; break;
        }
      }
      if (!placed) { iv.lane = lanes.length; lanes.push([iv]); }
    });
    if (lanes.length > 1) {
      const laneH = (rh - barPad * 2) / lanes.length;
      ivs.forEach(iv => {
        iv.el.style.top    = (barPad + iv.lane * laneH) + 'px';
        iv.el.style.height = Math.max(16, laneH) + 'px';
      });
    } else {
      ivs.forEach(iv => {
        iv.el.style.top    = barPad + 'px';
        iv.el.style.height = Math.max(16, rh - barPad * 2) + 'px';
      });
    }
  }

  // =========================================================================
  // Milestones / Deadlines
  // =========================================================================

  // Accepts only #rrggbb hex colours (what <input type=color> produces).
  // Falls back to a safe default to prevent CSS injection.
  function _safeColor(c, fallback) {
    return /^#[0-9a-fA-F]{6}$/.test(c) ? c : (fallback || '#e53935');
  }

  function renderMilestones() {
    // Ensure ganttRows is a positioned container for the absolute milestone lines
    ganttRows.style.position = 'relative';

    // Remove stale milestone elements from ruler and rows
    ganttRuler.querySelectorAll('.gantt-milestone-marker').forEach(el => el.remove());
    ganttRows.querySelectorAll('.gantt-milestone-line').forEach(el => el.remove());

    const milestones = S().milestones || [];
    milestones.forEach(ms => {
      const date = parseDate(ms.date);
      if (!date || date < chartStart || date > chartEnd) return;

      const x     = Math.round(daysBetween(chartStart, date) * pxPerDay);
      const color = _safeColor(ms.color);
      const label = ms.label || '';

      // ── Ruler diamond marker ─────────────────────────────────────────────
      const marker = document.createElement('div');
      marker.className        = 'gantt-milestone-marker';
      marker.style.left       = x + 'px';
      marker.style.backgroundColor = color;
      marker.title            = (label ? label + ' — ' : '') + ms.date;
      ganttRuler.appendChild(marker);

      // ── Vertical dashed line spanning all rows ───────────────────────────
      const line = document.createElement('div');
      line.className         = 'gantt-milestone-line';
      line.style.left        = x + 'px';
      line.style.borderLeftColor = color;

      // Hover: reuse shared bar tooltip
      line.addEventListener('mouseenter', (e) => {
        const tip = _getBarTooltip();
        tip.style.background = color;
        tip.style.color      = U().isColorDark(color) ? '#fff' : 'rgba(0,0,0,.8)';
        tip.innerHTML =
          '<div class="gantt-bar-tooltip-title">' + _esc(label || 'Milestone') + '</div>' +
          '<div class="gantt-bar-tooltip-meta">' + _esc(ms.date) + '</div>';
        tip.classList.add('visible');
        requestAnimationFrame(() => _positionBarTooltip(tip, e.clientX, e.clientY));
      });
      line.addEventListener('mousemove', (e) => _positionBarTooltip(_getBarTooltip(), e.clientX, e.clientY));
      line.addEventListener('mouseleave', () => _hideBarTooltip());

      // Right-click: edit / delete
      line.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _hideBarTooltip();
        U().showContextMenu(e.pageX, e.pageY, [
          { icon: '\u270F', label: 'Edit milestone',   action: () => showEditMilestoneModal(ms) },
          { icon: '\uD83D\uDDD1', label: 'Delete milestone', danger: true, action: () => deleteMilestone(ms.id) },
        ]);
      });

      ganttRows.appendChild(line);
    });
  }

  function showAddMilestoneModal(dateStr) {
    const html =
      '<label style="display:block;margin-bottom:10px">Date<br>' +
      '<input id="msDate" type="date" value="' + _esc(dateStr) + '" style="width:100%"></label>' +
      '<label style="display:block;margin-bottom:10px">Label<br>' +
      '<input id="msLabel" type="text" placeholder="e.g. Launch deadline" style="width:100%"></label>' +
      '<label style="display:block">Color<br>' +
      '<input id="msColor" type="color" value="#e53935"></label>';
    U().openModal('Add Milestone', html, async () => {
      const date  = document.getElementById('msDate').value;
      const label = document.getElementById('msLabel').value.trim();
      const color = _safeColor(document.getElementById('msColor').value);
      if (!date) return alert('Date is required');
      try {
        const data = await API('POST', '/api/milestones', {
          project_id: S().currentProject.id, date, label, color,
        });
        if (!S().milestones) S().milestones = [];
        S().milestones.push(data.milestone);
        render();
        U().closeModal();
      } catch (err) { alert('Save failed: ' + err.message); }
    });
  }

  function showEditMilestoneModal(ms) {
    const html =
      '<label style="display:block;margin-bottom:10px">Date<br>' +
      '<input id="msDate" type="date" value="' + _esc(ms.date) + '" style="width:100%"></label>' +
      '<label style="display:block;margin-bottom:10px">Label<br>' +
      '<input id="msLabel" type="text" value="' + _esc(ms.label || '') + '" style="width:100%"></label>' +
      '<label style="display:block">Color<br>' +
      '<input id="msColor" type="color" value="' + _esc(_safeColor(ms.color)) + '"></label>';
    U().openModal('Edit Milestone', html, async () => {
      const date  = document.getElementById('msDate').value;
      const label = document.getElementById('msLabel').value.trim();
      const color = _safeColor(document.getElementById('msColor').value);
      if (!date) return alert('Date is required');
      try {
        const data = await API('PUT', '/api/milestones/' + ms.id, { date, label, color });
        const idx = (S().milestones || []).findIndex(m => m.id === ms.id);
        if (idx !== -1) S().milestones[idx] = data.milestone;
        render();
        U().closeModal();
      } catch (err) { alert('Save failed: ' + err.message); }
    });
  }

  async function deleteMilestone(id) {
    if (!confirm('Delete this milestone?')) return;
    try {
      await API('DELETE', '/api/milestones/' + id);
      S().milestones = (S().milestones || []).filter(m => m.id !== id);
      render();
    } catch (err) { alert('Delete failed: ' + err.message); }
  }

  function buildBar(entry, ownerRowHeight) {
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
    const hasDepsOut  = deps.some(d => d.source_id === entry.id);
    const linkedTodo  = S().todos.find(t => t.gantt_entry_id === entry.id);
    const isCompleted = linkedTodo && linkedTodo.status === 'done';

    const container = document.createElement('div');
    const rowHeight = ownerRowHeight || getEntryRowHeight(entry);
    const barPad = Math.max(4, Math.round(rowHeight * 0.1));
    container.className     = 'gantt-bar-container';
    container.style.cssText = 'left:' + left + 'px;width:' + width + 'px;top:' + barPad + 'px;height:' + Math.max(16, rowHeight - (barPad * 2)) + 'px;';
    container.dataset.id    = entry.id;

    const bar = document.createElement('div');
    const isNarrow = width < NARROW_BAR_PX;
    const isHideLabel = width < HIDE_LABEL_PX;
    bar.className        = 'gantt-bar' + (isSelected ? ' selected' : '') + (isCompleted ? ' gantt-bar-completed' : '') + (rowHeight > ROW_H ? ' gantt-bar-tall' : '') + (isNarrow ? ' gantt-bar-narrow' : '') + (isHideLabel ? ' gantt-bar-hide-label' : '');
    bar.style.background = color;
    bar.style.width      = '100%';
    const isDark = U().isColorDark(color);
    if (isDark) {
      bar.style.color = '#fff';
    }
    const _barTextColor = isDark ? '#fff' : 'rgba(0,0,0,.75)';

    // Label
    const label = document.createElement('span');
    label.className   = 'gantt-bar-label';
    label.textContent = entry.title;
    bar.appendChild(label);

    // Completed checkmark badge on the bar
    if (isCompleted) {
      const barCheck = document.createElement('span');
      barCheck.className   = 'gantt-bar-completed-check';
      barCheck.textContent = '\u2705'; // ✅
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
    hLeft.className = 'gantt-bar-handle left proximity-handle';
    hLeft.title     = 'Drag to change start date';
    hLeft.dataset.help = 'Drag left edge to change the start date';
    hLeft.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      startDrag(e, 'resize-left', entry, bar, container);
    });
    hLeft.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      _lpTouchId = t.identifier;
      startDrag(_touchProxy(t), 'resize-left', entry, bar, container);
      document.addEventListener('touchmove',   _onBarTouchMove,  { passive: false });
      document.addEventListener('touchend',    _onBarTouchEnd);
      document.addEventListener('touchcancel', _onBarTouchEnd);
    }, { passive: false });
    bar.appendChild(hLeft);

    // ── Right resize handle ────────────────────────────────────────────────
    const hRight = document.createElement('div');
    hRight.className = 'gantt-bar-handle right proximity-handle';
    hRight.title     = 'Drag to change end date';
    hRight.dataset.help = 'Drag right edge to change the end date';
    hRight.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      startDrag(e, 'resize-right', entry, bar, container);
    });
    hRight.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      _lpTouchId = t.identifier;
      startDrag(_touchProxy(t), 'resize-right', entry, bar, container);
      document.addEventListener('touchmove',   _onBarTouchMove,  { passive: false });
      document.addEventListener('touchend',    _onBarTouchEnd);
      document.addEventListener('touchcancel', _onBarTouchEnd);
    }, { passive: false });
    bar.appendChild(hRight);

    // ── Input node (left edge of bar – receives dependency arrows) ─────────
    const inputNode = document.createElement('div');
    inputNode.className = 'dep-node input-node';
    inputNode.title     = 'Input: this task depends on another (click while connecting)';
    inputNode.dataset.help = 'Input node: click here while in connecting mode to set this task as a dependency target';
    inputNode.style.background = U().darkenColor(color, 0.25);

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
    container.appendChild(inputNode);

    // ── Output node (bottom-right of bar – sends dependency arrows) ────────
    const outputNode = document.createElement('div');
    outputNode.className = 'dep-node output-node' + (hasDepsOut ? ' always-visible' : '');
    outputNode.title     = 'Output: click to connect a dependency to another task';
    outputNode.dataset.help = 'Output node: click to start connecting a dependency arrow from this task to another';
    outputNode.style.background = U().darkenColor(color, 0.25);

    outputNode.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!conn.active) startConnecting(entry, container);
    });
    container.appendChild(outputNode);

    // ── Hover: show styled tooltip with full task info ────────────────────
    container.addEventListener('mouseenter', (e) => {
      if (drag.active) return;
      container.style.zIndex = '10';
      _showBarTooltip(entry, color, _barTextColor, e.clientX, e.clientY);
    });

    // ── Proximity-based scaling for output node and resize handles ─────────
    container.addEventListener('mousemove', (e) => {
      if (drag.active) return;
      _positionBarTooltip(_getBarTooltip(), e.clientX, e.clientY);
      const rect = bar.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const w = rect.width;
      const h = rect.height;
      const prox = proximityPx;

      // Output node: right edge center
      const dxOut = w - x;
      const dyOut = h / 2 - y;
      const distOut = Math.sqrt(dxOut * dxOut + dyOut * dyOut);
      const scaleOut = Math.max(0, Math.min(1, 1 - distOut / prox));
      if (!outputNode.classList.contains('always-visible')) {
        outputNode.style.transform = 'translateY(-50%) scale(' + scaleOut + ')';
        outputNode.style.opacity   = scaleOut > 0 ? '1' : '0';
      }

      // Left handle: distance from left edge
      const distLeft = Math.abs(x);
      const opLeft = Math.max(0, Math.min(1, 1 - distLeft / prox));
      hLeft.style.opacity = opLeft;

      // Right handle: distance from right edge
      const distRight = Math.abs(w - x);
      const opRight = Math.max(0, Math.min(1, 1 - distRight / prox));
      hRight.style.opacity = opRight;
    });
    container.addEventListener('mouseleave', () => {
      if (drag.active) return;
      container.style.zIndex = '';
      _hideBarTooltip();
      // Reset proximity handles and output node
      if (!outputNode.classList.contains('always-visible')) {
        outputNode.style.transform = 'translateY(-50%) scale(0)';
        outputNode.style.opacity   = '0';
      }
      hLeft.style.opacity  = '0';
      hRight.style.opacity = '0';
    });

    // ── Bar body drag (move) ───────────────────────────────────────────────
    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // only left-click starts a drag
      if (conn.active || shareRowLink.active) return; // don't start drag during connecting/share-row mode
      if (e.target === hLeft || e.target === hRight ||
          e.target === inputNode || e.target === outputNode ||
          e.target === barIndicator) return;
      e.preventDefault();
      startDrag(e, 'move', entry, bar, container);
    });

    // Touch: long-press on bar body to start move drag
    bar.addEventListener('touchstart', (e) => {
      if (conn.active || shareRowLink.active) return;
      if (e.target === hLeft || e.target === hRight ||
          e.target === inputNode || e.target === outputNode ||
          e.target === barIndicator) return;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      _lpTouchId = t.identifier;
      _lpStartX  = t.pageX;
      _lpStartY  = t.pageY;
      bar.classList.add('long-press-pending');
      _lpTimer = setTimeout(() => {
        bar.classList.remove('long-press-pending');
        if (navigator.vibrate) navigator.vibrate(10);
        startDrag(_touchProxy(t), 'move', entry, bar, container);
        document.addEventListener('touchmove',   _onBarTouchMove,  { passive: false });
        document.addEventListener('touchend',    _onBarTouchEnd);
        document.addEventListener('touchcancel', _onBarTouchEnd);
      }, _LP_DELAY);
    }, { passive: true });

    bar.addEventListener('touchmove', (e) => {
      if (!_lpTimer) return;
      const t = _findTouch(e.changedTouches, _lpTouchId);
      if (!t) return;
      if (Math.abs(t.pageX - _lpStartX) > _LP_THRESHOLD ||
          Math.abs(t.pageY - _lpStartY) > _LP_THRESHOLD) {
        _lpCancel(bar);
      }
    }, { passive: true });

    bar.addEventListener('touchend',    () => _lpCancel(bar));
    bar.addEventListener('touchcancel', () => _lpCancel(bar));

    bar.addEventListener('dblclick', (e) => {
      if (conn.active) return;
      e.stopPropagation();
      _hideBarTooltip();
      showEditEntryModal(entry);
    });
    bar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // contextmenu is handled globally when connecting/share-row; also skip during drag
      if (conn.active || shareRowLink.active || drag.active) return;
      showEntryContextMenu(e.pageX, e.pageY, entry);
    });

    // When in connecting mode, clicking anywhere on this bar finishes the connection
    container.addEventListener('click', (e) => {
      if (conn.active && conn.sourceId !== entry.id) {
        e.stopPropagation();
        finishConnecting(entry);
      }
      if (shareRowLink.active && shareRowLink.sourceId !== entry.id) {
        e.stopPropagation();
        finishShareRow(entry);
      }
    });

    container.appendChild(bar);
    return container;
  }

  // =========================================================================
  // Drag – resize & move
  // =========================================================================

  // Returns snap-adjusted edge pixel position (or rawPx if no snap target nearby).
  // Snaps the dragged edge to the nearest start/end of another task within snapPx pixels.
  // When the user moves beyond snapPx away from the current snap point the snap is
  // released and a new target is searched for on the next call, so snapping always
  // re-engages whenever the cursor enters range of any task edge.
  // snapPx is configurable via setSnapPx() and persisted in localStorage.
  // snapEnabled can be toggled via setSnapEnabled() and persisted in localStorage.
  let snapPx = Math.max(0, parseInt(localStorage.getItem('ganttSnapPx') || '5', 10));
  let snapEnabled = (function () {
    const s = localStorage.getItem('ganttSnapEnabled');
    return s === null ? true : s === 'true';
  })();
  function setSnapPx(val) {
    snapPx = Math.max(0, Math.min(30, parseInt(val, 10) || 0));
    localStorage.setItem('ganttSnapPx', snapPx);
  }
  function setSnapEnabled(val) {
    snapEnabled = !!val;
    localStorage.setItem('ganttSnapEnabled', snapEnabled);
  }

  // Node proximity – how far from the corner/edge the output-node and resize
  // handles start appearing (scales 0→1 as cursor approaches).
  let proximityPx = Math.max(10, parseInt(localStorage.getItem('ganttProximityPx') || '60', 10));
  function setProximityPx(val) {
    proximityPx = Math.max(10, Math.min(200, parseInt(val, 10) || 60));
    localStorage.setItem('ganttProximityPx', proximityPx);
  }

  function applyEdgeSnap(rawPx) {
    if (!snapEnabled || snapPx === 0) return rawPx;

    // If currently snapped, check whether the snap has been broken
    if (drag.snapActivePx !== null) {
      if (Math.abs(rawPx - drag.snapActivePx) > snapPx) {
        drag.snapActivePx = null;
        drag.snapTargetEntryId = null;
        // fall through to find a new snap target
      } else {
        return drag.snapActivePx; // stay snapped
      }
    }

    // Look for a new snap target
    const best = nearestSnapTarget(rawPx);
    if (best !== null) {
      drag.snapActivePx = best.px;
      drag.snapTargetEntryId = best.entryId;
      return best.px;
    }
    return rawPx;
  }

  // Returns the pixel position of the nearest task edge within snapPx of rawPx,
  // or null if no edge is close enough.
  function nearestSnapTarget(rawPx) {
    let bestPx      = null;
    let bestEntryId = null;
    // bestDist starts at snapPx+1 so only edges strictly within snapPx qualify
    let bestDist = snapPx + 1;
    const entries = S().ganttEntries;
    for (let i = 0; i < entries.length; i++) {
      const en = entries[i];
      if (en.id === drag.entryId) continue;
      const startDate = parseDate(en.start_date);
      const endDate   = parseDate(en.end_date);
      if (!startDate || !endDate || !chartStart) continue;
      const startPx = daysBetween(chartStart, startDate) * pxPerDay;
      const endPx   = daysBetween(chartStart, endDate)   * pxPerDay;
      const dS = Math.abs(rawPx - startPx);
      const dE = Math.abs(rawPx - endPx);
      if (dS < bestDist) { bestDist = dS; bestPx = startPx; bestEntryId = en.id; }
      if (dE < bestDist) { bestDist = dE; bestPx = endPx; bestEntryId = en.id; }
    }
    return bestPx !== null ? { px: bestPx, entryId: bestEntryId } : null;
  }

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
    drag.snapActivePx = null;

    // ── vertical row-drag init ──────────────────────────────────────────
    drag.startY = e.pageY;
    drag.rowDropMode = null;
    drag.rowDropTargetId = null;
    drag.rowDropIndicatorEl = null;
    drag.rowDropIndicatorTaskEl = null;
    const rowBg = containerEl.closest('.gantt-row-bg');
    drag.parentRowBg = rowBg;
    const rowEntryId = rowBg?.dataset?.id;
    const vis = visibleEntries();
    drag.origRowIndex = vis.findIndex(en => en.id === rowEntryId);

    barEl.style.opacity    = '0.75';
    barEl.style.cursor     = type === 'move' ? 'grabbing' : 'col-resize';
    document.body.style.cursor    = type === 'move' ? 'grabbing' : 'col-resize';
    document.body.style.userSelect = 'none';

    _hideBarTooltip();

    // Disable hover transition during drag to prevent visual jitter
    if (type === 'move') containerEl.style.transition = 'none';
  }

  /** Clear blue dotted row-drop indicators shown during vertical bar drag. */
  function _clearBarRowIndicator() {
    if (drag.rowDropIndicatorEl) {
      drag.rowDropIndicatorEl.remove();
      drag.rowDropIndicatorEl = null;
    }
    if (drag.rowDropIndicatorTaskEl) {
      drag.rowDropIndicatorTaskEl.remove();
      drag.rowDropIndicatorTaskEl = null;
    }
    // Remove any highlight classes from task list rows
    const highlighted = ganttTaskList.querySelectorAll('.bar-row-drop-target');
    highlighted.forEach(r => r.classList.remove('bar-row-drop-target'));
    drag.rowDropMode = null;
    drag.rowDropTargetId = null;
  }

  function onMouseMove(e) {
    // ── drag live preview (pixel-precise, snaps on release) ────────────────
    if (drag.active) {
      const deltaX = e.pageX - drag.startX;

      if (drag.type === 'move') {
        const rawLeft  = drag.origLeftPx + deltaX;
        const rawRight = rawLeft + drag.origWidthPx;

        // Snap the closer end to the nearest task edge
        let effectiveLeft = rawLeft;
        let leftSnapped = false;
        let rightSnapped = false;
        if (snapEnabled && snapPx > 0) {
          const snapL = nearestSnapTarget(rawLeft);
          const snapR = nearestSnapTarget(rawRight);
          if (snapL !== null || snapR !== null) {
            const dL = snapL !== null ? Math.abs(rawLeft  - snapL.px) : Infinity;
            const dR = snapR !== null ? Math.abs(rawRight - snapR.px) : Infinity;
            if (dL <= dR) {
              effectiveLeft = snapL.px;
              leftSnapped = true;
              drag.snapTargetEntryId = snapL.entryId;
            } else {
              effectiveLeft = snapR.px - drag.origWidthPx;
              rightSnapped = true;
              drag.snapTargetEntryId = snapR.entryId;
            }
          } else {
            drag.snapTargetEntryId = null;
          }
        }

        drag.containerEl.style.left = effectiveLeft + 'px';
        // Only show snap lines when the bar edge aligns with another task edge
        if (leftSnapped) {
          showSnapLine(effectiveLeft);
          if (snapLine2El) snapLine2El.style.display = 'none';
        } else if (rightSnapped) {
          showSnapLine2(effectiveLeft + drag.origWidthPx);
          if (snapLineEl) snapLineEl.style.display = 'none';
        } else {
          hideSnapLine();
        }

        // ── Vertical row drag detection ──────────────────────────────────────
        const rawDeltaY = e.pageY - drag.startY;
        _clearBarRowIndicator();

        if (Math.abs(rawDeltaY) > ROW_H * 0.3) {
          // Translate bar vertically to follow cursor
          drag.containerEl.style.transform = 'translateY(' + rawDeltaY + 'px)';
          drag.containerEl.style.zIndex = '1000';
          if (drag.parentRowBg) drag.parentRowBg.style.zIndex = '100';

          // Determine which row the cursor is over
          const rowsRect = ganttRows.getBoundingClientRect();
          const relY = e.clientY - rowsRect.top;
          const vis = visibleEntries();

          // Build cumulative row tops accounting for variable row heights
          const rowTops = [];
          const rowHeights = [];
          let cumRowY = 0;
          vis.forEach(en => {
            rowTops.push(cumRowY);
            const rh = getEffectiveEntryRowHeight(en);
            rowHeights.push(rh);
            cumRowY += rh;
          });

          // Find which row contains relY
          let curRowIdx = vis.length; // default: below all rows
          let rowTopY = cumRowY;
          let curRowH = ROW_H;
          for (let i = 0; i < vis.length; i++) {
            if (relY < rowTops[i] + rowHeights[i]) {
              curRowIdx = i;
              rowTopY = rowTops[i];
              curRowH = rowHeights[i];
              break;
            }
          }

          const posInRow = relY - rowTopY;
          const threshold = curRowH * 0.3;

          if (curRowIdx >= 0 && curRowIdx < vis.length && curRowIdx !== drag.origRowIndex) {
            const targetId = vis[curRowIdx].id;

            // Determine drop zone: top / middle / bottom
            let dropMode;
            if (posInRow < threshold) {
              dropMode = 'between-before';
            } else if (posInRow > curRowH - threshold) {
              dropMode = 'between-after';
            } else {
              dropMode = 'onto';
            }

            // Adjacent-row correction: when the cursor is on the row directly
            // above/below the source, the near-edge zone produces a no-op
            // reorder (inserting after the row above or before the row below
            // puts the entry back in its original position).  Redirect these
            // zones so that a single-row move actually works.
            if (dropMode === 'between-after' && curRowIdx === drag.origRowIndex - 1) {
              dropMode = 'between-before';
            }
            if (dropMode === 'between-before' && curRowIdx === drag.origRowIndex + 1) {
              dropMode = 'between-after';
            }

            drag.rowDropMode = dropMode;
            drag.rowDropTargetId = targetId;

            if (dropMode === 'between-before') {
              const ind = document.createElement('div');
              ind.className = 'bar-row-drop-line';
              ind.style.top = rowTopY + 'px';
              ganttRows.appendChild(ind);
              drag.rowDropIndicatorEl = ind;
              const taskInd = document.createElement('div');
              taskInd.className = 'bar-row-drop-line';
              const taskRow = ganttTaskList.querySelector('.gantt-task-row[data-id="' + targetId + '"]');
              if (taskRow) {
                const listRect = ganttTaskList.getBoundingClientRect();
                taskInd.style.top = (taskRow.getBoundingClientRect().top - listRect.top + ganttTaskList.scrollTop) + 'px';
                ganttTaskList.appendChild(taskInd);
                drag.rowDropIndicatorTaskEl = taskInd;
              }
            } else if (dropMode === 'between-after') {
              const ind = document.createElement('div');
              ind.className = 'bar-row-drop-line';
              ind.style.top = (rowTopY + curRowH) + 'px';
              ganttRows.appendChild(ind);
              drag.rowDropIndicatorEl = ind;
              const taskInd = document.createElement('div');
              taskInd.className = 'bar-row-drop-line';
              const taskRow = ganttTaskList.querySelector('.gantt-task-row[data-id="' + targetId + '"]');
              if (taskRow) {
                const listRect = ganttTaskList.getBoundingClientRect();
                taskInd.style.top = (taskRow.getBoundingClientRect().bottom - listRect.top + ganttTaskList.scrollTop) + 'px';
                ganttTaskList.appendChild(taskInd);
                drag.rowDropIndicatorTaskEl = taskInd;
              }
            } else {
              // Onto: box around this row → share row
              const ind = document.createElement('div');
              ind.className = 'bar-row-drop-box';
              ind.style.top = rowTopY + 'px';
              ind.style.height = curRowH + 'px';
              ganttRows.appendChild(ind);
              drag.rowDropIndicatorEl = ind;
              const taskRow = ganttTaskList.querySelector('.gantt-task-row[data-id="' + targetId + '"]');
              if (taskRow) taskRow.classList.add('bar-row-drop-target');
            }
          } else if (curRowIdx >= vis.length && vis.length > 0) {
            // Below all rows → insert after last row
            const lastIdx = vis.length - 1;
            if (lastIdx !== drag.origRowIndex) {
              drag.rowDropMode = 'between-after';
              drag.rowDropTargetId = vis[lastIdx].id;
              const ind = document.createElement('div');
              ind.className = 'bar-row-drop-line';
              ind.style.top = cumRowY + 'px';
              ganttRows.appendChild(ind);
              drag.rowDropIndicatorEl = ind;
            }
          }
        } else {
          // Not enough vertical movement → clear vertical state
          drag.containerEl.style.transform = '';
          drag.containerEl.style.zIndex = '';
          if (drag.parentRowBg) drag.parentRowBg.style.zIndex = '';
        }
      } else if (drag.type === 'resize-left') {
        const rawLeft  = drag.origLeftPx  + deltaX;
        const rawWidth = drag.origWidthPx - deltaX;
        if (rawWidth >= MIN_DAYS * pxPerDay) {
          const effectivePx = applyEdgeSnap(rawLeft);
          const effectiveWidth = drag.origLeftPx + drag.origWidthPx - effectivePx;
          if (effectiveWidth >= MIN_DAYS * pxPerDay) {
            drag.containerEl.style.left  = effectivePx + 'px';
            drag.containerEl.style.width = effectiveWidth + 'px';
          }
          // Only show snap line when snapped to a task edge
          if (drag.snapActivePx !== null) {
            showSnapLine(effectivePx);
          } else {
            hideSnapLine();
          }
        }
      } else if (drag.type === 'resize-right') {
        const rawWidth = drag.origWidthPx + deltaX;
        if (rawWidth >= MIN_DAYS * pxPerDay) {
          const rawRightPx = drag.origLeftPx + rawWidth;
          const effectiveRightPx = applyEdgeSnap(rawRightPx);
          const effectiveWidth = effectiveRightPx - drag.origLeftPx;
          if (effectiveWidth >= MIN_DAYS * pxPerDay) {
            drag.containerEl.style.width = effectiveWidth + 'px';
          }
          // Only show snap line when snapped to a task edge
          if (drag.snapActivePx !== null) {
            showSnapLine(effectiveRightPx);
          } else {
            hideSnapLine();
          }
        }
      }

      // Live lane-height recalculation: as the bar moves, update heights so
      // bars pop to full height as soon as they stop overlapping (and shrink
      // back into lanes if they start overlapping again).
      if (drag.containerEl && drag.containerEl.parentElement) {
        _recalcRowLanes(drag.containerEl.parentElement);
      }

      // Update tooltip with day-snapped dates
      const snapDays = getSnapDaysForCurrentScale();
      const deltaDays = Math.round((deltaX / pxPerDay) / snapDays) * snapDays;
      if (deltaDays !== drag.snappedDays) {
        drag.snappedDays = deltaDays;
        const { newStart, newEnd } = calcDragDates(deltaDays);
        if (drag.ghostEl) drag.ghostEl.title = newStart + ' \u2192 ' + newEnd;
      }
    }

    // ── timeline marquee selection ─────────────────────────────────────────
    if (timelineSel.active && timelineSel.overlayEl && ganttTimeline) {
      const rect     = ganttTimeline.getBoundingClientRect();
      const x        = e.clientX - rect.left + ganttTimeline.scrollLeft;
      const y        = e.clientY - rect.top  + ganttTimeline.scrollTop;
      const day      = Math.floor(x / pxPerDay);
      const numRows  = ganttRows.querySelectorAll('.gantt-row-bg').length;
      const maxRow   = Math.max(0, numRows - 1);
      const rowIndex = Math.min(maxRow, Math.max(0, Math.floor(y / ROW_H)));

      timelineSel.endDay      = day;
      timelineSel.endRowIndex = rowIndex;

      const startDay = Math.min(timelineSel.startDay, day);
      const endDay   = Math.max(timelineSel.startDay, day);
      const startRow = Math.min(timelineSel.startRowIndex, rowIndex);
      const endRow   = Math.max(timelineSel.startRowIndex, rowIndex);

      timelineSel.overlayEl.style.left   = (startDay * pxPerDay) + 'px';
      timelineSel.overlayEl.style.width  = ((endDay - startDay + 1) * pxPerDay) + 'px';
      timelineSel.overlayEl.style.top    = (startRow * ROW_H) + 'px';
      timelineSel.overlayEl.style.height = ((endRow - startRow + 1) * ROW_H) + 'px';
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
    // ── finalize timeline marquee selection ───────────────────────────────
    if (timelineSel.active) {
      timelineSel.active = false;
      const movedEnough = Math.abs(e.pageX - timelineSel.mouseStartX) >= 5 ||
                          Math.abs(e.pageY - timelineSel.mouseStartY) >= 5;
      if (!movedEnough) {
        // Treat as a plain click – clear the overlay only
        clearTimelineSelection();
      } else {
        // Marquee drag: select entries inside the rectangle, then remove overlay
        selectEntriesInMarquee(timelineSel.shiftKey);
        clearTimelineSelection();
      }
    }

    if (!drag.active) return;

    document.body.style.cursor    = '';
    document.body.style.userSelect = '';
    if (drag.ghostEl) { drag.ghostEl.style.opacity = ''; drag.ghostEl.style.cursor = ''; }

    // Capture drag state and reset immediately to prevent sticking.
    // When a snap is active, compute deltaDays from the snapped pixel position
    // so the saved dates match the visually snapped bar position.
    // Task-edge snaps have priority: bypass the snapDays grid rounding so
    // the bar lands exactly on the snapped task edge (1-day precision).
    let deltaDays;
    const snapActivePx = drag.snapActivePx;
    const snapTargetId = drag.snapTargetEntryId;
    const dragType = drag.type;
    if (dragType === 'move') {
      // Use actual container position to account for snap adjustment.
      // Fallback to mouse delta if style.left is somehow unparseable.
      const actualLeft = parseFloat(drag.containerEl.style.left);
      if (snapTargetId !== null && !isNaN(actualLeft)) {
        // Snapped to a task edge – use exact day delta (1-day precision)
        deltaDays = Math.round((actualLeft - drag.origLeftPx) / pxPerDay);
      } else {
        const snapDays = getSnapDaysForCurrentScale();
        deltaDays = isNaN(actualLeft)
          ? Math.round(((e.pageX - drag.startX) / pxPerDay) / snapDays) * snapDays
          : Math.round(((actualLeft - drag.origLeftPx) / pxPerDay) / snapDays) * snapDays;
      }
    } else if (snapActivePx !== null && (dragType === 'resize-left' || dragType === 'resize-right')) {
      // Snapped to a task edge during resize – use exact day delta
      if (dragType === 'resize-left') {
        deltaDays = Math.round((snapActivePx - drag.origLeftPx) / pxPerDay);
      } else {
        deltaDays = Math.round((snapActivePx - drag.origLeftPx - drag.origWidthPx) / pxPerDay);
      }
    } else {
      const snapDays = getSnapDaysForCurrentScale();
      deltaDays = Math.round(((e.pageX - drag.startX) / pxPerDay) / snapDays) * snapDays;
    }
    const { newStart, newEnd } = calcDragDates(deltaDays);
    const entryId      = drag.entryId;
    const containerEl  = drag.containerEl;
    const origStart    = drag.origStart;
    const origEnd      = drag.origEnd;

    // Capture vertical row-drop state before resetting
    const rowDropMode      = drag.rowDropMode;
    const rowDropTargetId  = drag.rowDropTargetId;
    const hasRowChange     = rowDropMode && rowDropTargetId && rowDropTargetId !== entryId;

    // Clean up vertical visual state
    _clearBarRowIndicator();
    if (containerEl) {
      containerEl.style.transform  = '';
      containerEl.style.zIndex     = '';
      containerEl.style.transition = '';
    }
    if (drag.parentRowBg) drag.parentRowBg.style.zIndex = '';

    drag.active = false; drag.type = null; drag.entryId = null;
    drag.ghostEl = null; drag.containerEl = null;
    drag.snapActivePx = null; drag.snapTargetEntryId = null;
    drag.parentRowBg = null; drag.origRowIndex = -1;
    hideSnapLine();

    if (deltaDays === 0 && !hasRowChange) {
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

    // Play sound based on drag type and direction
    if (dragType === 'move') {
      window.soundsModule?.play('task_placed');
    } else if (dragType === 'resize-right') {
      window.soundsModule?.play(deltaDays > 0 ? 'stretch' : 'compress');
    } else if (dragType === 'resize-left') {
      window.soundsModule?.play(deltaDays < 0 ? 'stretch' : 'compress');
    }

    // ── Handle horizontal date change ──────────────────────────────────────
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

      // When moving (not resizing), shift all subtask descendants by the same delta
      if (dragType === 'move') {
        const descendants = [];
        const collectDesc = (pid) => {
          S().ganttEntries.forEach(e => {
            if (e.parent_id === pid) { descendants.push(e); collectDesc(e.id); }
          });
        };
        collectDesc(entryId);
        for (const child of descendants) {
          const cs = parseDate(child.start_date);
          const ce = parseDate(child.end_date);
          if (!cs || !ce) continue;
          const childNewStart = toDateStr(addDays(cs, deltaDays));
          const childNewEnd   = toDateStr(addDays(ce, deltaDays));
          expandChartRange({ start_date: childNewStart, end_date: childNewEnd });
          try {
            const upd = await API('PUT', '/api/gantt/' + child.id, {
              start_date: childNewStart, end_date: childNewEnd,
            });
            const ci = S().ganttEntries.findIndex(x => x.id === child.id);
            if (ci !== -1) S().ganttEntries[ci] = upd.entry;
          } catch (err) { console.error('Save subtask drag failed:', err); }
        }
      }
    }

    // ── Handle vertical row change ─────────────────────────────────────────
    if (hasRowChange) {
      if (rowDropMode === 'onto') {
        // Share row with the target entry
        const targetEntry = S().ganttEntries.find(en => en.id === rowDropTargetId);
        if (targetEntry) {
          // Resolve chain to find root row owner
          let resolvedTarget = targetEntry.id;
          const visited = new Set([entryId]);
          let cursor = targetEntry;
          while (cursor && cursor.same_row) {
            if (visited.has(cursor.same_row)) break;
            visited.add(cursor.same_row);
            const next = S().ganttEntries.find(en => en.id === cursor.same_row);
            if (!next) break;
            resolvedTarget = next.id;
            cursor = next;
          }
          if (resolvedTarget !== entryId) {
            // If this entry is a row owner, re-point its dependants to the first one
            const dependants = S().ganttEntries.filter(en => en.same_row === entryId);
            if (dependants.length > 0) {
              const newOwner = dependants[0].id;
              for (let di = 1; di < dependants.length; di++) {
                try {
                  const upd = await API('PUT', '/api/gantt/' + dependants[di].id, { same_row: newOwner });
                  const idx = S().ganttEntries.findIndex(en => en.id === dependants[di].id);
                  if (idx !== -1) S().ganttEntries[idx] = upd.entry;
                } catch (err) { console.error('Re-point same_row failed:', err); }
              }
              // Clear the first dependant's same_row (it becomes the new owner)
              try {
                const upd = await API('PUT', '/api/gantt/' + newOwner, { same_row: null });
                const idx = S().ganttEntries.findIndex(en => en.id === newOwner);
                if (idx !== -1) S().ganttEntries[idx] = upd.entry;
              } catch (err) { console.error('Clear new owner same_row failed:', err); }
            }
            try {
              // Release parent-child relationship if source is child of target
              const movedEntry = S().ganttEntries.find(en => en.id === entryId);
              const updatePayload = { same_row: resolvedTarget };
              if (movedEntry && movedEntry.parent_id === resolvedTarget) {
                updatePayload.parent_id = null;
              }
              const data = await API('PUT', '/api/gantt/' + entryId, updatePayload);
              const idx = S().ganttEntries.findIndex(en => en.id === entryId);
              if (idx !== -1) S().ganttEntries[idx] = data.entry;

              // Also release the reverse: if target is child of source
              const targetEntry2 = S().ganttEntries.find(en => en.id === resolvedTarget);
              if (targetEntry2 && targetEntry2.parent_id === entryId) {
                try {
                  const data2 = await API('PUT', '/api/gantt/' + resolvedTarget, { parent_id: null });
                  const idx2 = S().ganttEntries.findIndex(en => en.id === resolvedTarget);
                  if (idx2 !== -1) S().ganttEntries[idx2] = data2.entry;
                } catch (err2) { console.error('Release child from parent on drag failed:', err2); }
              }
            } catch (err) {
              console.error('Share row via bar drag failed:', err);
            }
          }
        }
      } else if (rowDropMode === 'between-before' || rowDropMode === 'between-after') {
        // Reorder: move this entry to the indicated position
        const movedEntry  = S().ganttEntries.find(en => en.id === entryId);
        const targetEntry = S().ganttEntries.find(en => en.id === rowDropTargetId);

        // If entry was sharing a row, unshare first
        if (movedEntry && movedEntry.same_row) {
          try {
            const data = await API('PUT', '/api/gantt/' + entryId, { same_row: null });
            const idx = S().ganttEntries.findIndex(en => en.id === entryId);
            if (idx !== -1) S().ganttEntries[idx] = data.entry;
          } catch (err) {
            console.error('Unshare before reorder failed:', err);
          }
        }

        // If cross-parent, reparent first (same logic as onReparentUp)
        if (movedEntry && targetEntry && movedEntry.parent_id !== targetEntry.parent_id) {
          const newParentId = targetEntry.parent_id || null;
          if (newParentId !== entryId) {
            const childrenOf = {};
            S().ganttEntries.forEach(en => {
              const pid = en.parent_id || '__root__';
              if (!childrenOf[pid]) childrenOf[pid] = [];
              childrenOf[pid].push(en);
            });
            const isDesc = (tId, ancestorId) => {
              const kids = childrenOf[ancestorId] || [];
              for (const child of kids) {
                if (child.id === tId) return true;
                if (isDesc(tId, child.id)) return true;
              }
              return false;
            };
            if (!isDesc(newParentId, entryId)) {
              try {
                const updated = await API('PUT', '/api/gantt/' + entryId, { parent_id: newParentId });
                const idx = S().ganttEntries.findIndex(x => x.id === entryId);
                if (idx !== -1) S().ganttEntries[idx] = updated.entry;
                if (newParentId) expandedIds.add(newParentId);
              } catch (err) {
                console.error('Reparent for row drag failed:', err);
                render();
                return;
              }
            }
          }
        }
        await reorderEntries(entryId, rowDropTargetId, rowDropMode === 'between-before');
        return; // reorderEntries already calls render()
      }
    }

    // Render if any change occurred (date or row)
    if (deltaDays !== 0 || hasRowChange) {
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
    window.soundsModule?.play('anchor_click');

    // Source point: right edge of bar at row vertical center (matches output node)
    const rowIdx = rowIndexMap[entry.id] !== undefined ? rowIndexMap[entry.id] : 0;
    const endDate = parseDate(entry.end_date);
    const sx = Math.max(0, daysBetween(chartStart, endDate)) * pxPerDay;
    const sy = rowYMap[entry.id] !== undefined ? rowYMap[entry.id] : (rowIdx * ROW_H + ROW_H / 2); // vertical center of the bar row
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
      window.soundsModule?.play('anchor_connect');
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

    const deps = S().dependencies || [];
    deps.forEach(dep => {
      const srcIdx = rowIndexMap[dep.source_id];
      const tgtIdx = rowIndexMap[dep.target_id];
      if (srcIdx === undefined || tgtIdx === undefined) return;

      // Look up the actual entry by ID (entries[idx] would be the row owner
      // for same-row entries, giving wrong dates / positions).
      const srcEntry = S().ganttEntries.find(e => e.id === dep.source_id) || entries[srcIdx];
      const tgtEntry = S().ganttEntries.find(e => e.id === dep.target_id) || entries[tgtIdx];
      if (!srcEntry || !tgtEntry) return;

      // Use the same clamping + MIN_DAYS logic as buildBar so the arrow
      // always starts from the visual right edge of the source bar.
      const srcStart    = parseDate(srcEntry.start_date);
      const srcEnd      = parseDate(srcEntry.end_date);
      const srcClipped  = (srcStart && srcStart < chartStart) ? chartStart : srcStart;
      const x1 = srcClipped
        ? (daysBetween(chartStart, srcClipped) + Math.max(MIN_DAYS, daysBetween(srcClipped, srcEnd))) * pxPerDay
        : Math.max(0, daysBetween(chartStart, srcEnd)) * pxPerDay;

      // Target: left edge of the visual bar (clamped to chart start)
      const tgtStart    = parseDate(tgtEntry.start_date);
      const tgtClipped  = (tgtStart && tgtStart < chartStart) ? chartStart : tgtStart;
      const x2 = tgtClipped
        ? Math.max(0, daysBetween(chartStart, tgtClipped)) * pxPerDay
        : Math.max(0, daysBetween(chartStart, parseDate(tgtEntry.start_date))) * pxPerDay;
      const y1 = rowYMap[dep.source_id] !== undefined ? rowYMap[dep.source_id] : (srcIdx * ROW_H + ROW_H / 2);
      const y2 = rowYMap[dep.target_id] !== undefined ? rowYMap[dep.target_id] : (tgtIdx * ROW_H + ROW_H / 2);

      // Gentler bezier curve (reduced control-point factor vs the old 0.5)
      const dx   = Math.abs(x2 - x1);
      const cpx  = Math.max(dx * 0.25, MIN_BEZIER_CP);
      // Line goes all the way to the target bar edge (no arrowhead, no inset)
      const d    = 'M ' + x1 + ' ' + y1 +
                   ' C ' + (x1 + cpx) + ' ' + y1 + ',' +
                   (x2 - cpx) + ' ' + y2 + ',' +
                   x2 + ' ' + y2;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', 'rgba(80,80,80,0.65)');
      path.setAttribute('stroke-width', '1.8');
      path.setAttribute('fill', 'none');
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

    entries.forEach(entry => {
      const h = calcRemainingHours(entry.id);

      const row = document.createElement('div');
      row.className = 'gantt-hours-row' + (h > 0 ? ' has-hours' : '');
      row.style.height = getEffectiveEntryRowHeight(entry) + 'px';
      if (h > capacity) row.classList.add('overloaded');
      row.textContent = h > 0 ? fmtH(h) : '\u2014';
      row.title = h > 0 ? fmtH(h) + ' estimated' : 'No hours estimated';
      ganttHoursPanel.appendChild(row);
    });

    // Update panel header with view total (recursive sum of all root-level entries' subtrees).
    const header = document.getElementById('ganttHoursHeader');
    if (header) {
      const t = entries
        .filter(e => (e._depth || 0) === 0)
        .reduce((sum, e) => sum + calcViewTotal(e.id), 0);
      header.textContent = t > 0 ? fmtH(t) : 'Total h';
      header.title       = t > 0 ? fmtH(t) + ' total hours in this view' : 'Total hours';
    }
  }

  /**
   * Hours for an entry: returns the entry's own hours_estimate plus the hours
   * of all same-row partners and all descendant entries (recursive).
   */
  function calcTotalHours(entryId, _visited) {
    if (!_visited) _visited = new Set();
    if (_visited.has(entryId)) return 0;
    _visited.add(entryId);

    const entry = S().ganttEntries.find(e => e.id === entryId);
    if (!entry) return 0;

    let total = +(entry.hours_estimate) || 0;

    // Add hours from entries sharing this row
    S().ganttEntries
      .filter(e => e.same_row === entryId)
      .forEach(e => { total += calcTotalHours(e.id, _visited); });

    // Add hours from child entries (subtasks)
    S().ganttEntries
      .filter(e => e.parent_id === entryId)
      .forEach(e => { total += calcTotalHours(e.id, _visited); });

    return total;
  }

  // calcTreeTotal, calcViewTotal, and calcRemainingHours are kept as aliases so
  // that call-sites throughout the module continue to work without change.
  function calcTreeTotal(entryId)      { return calcTotalHours(entryId); }
  function calcViewTotal(entryId)      { return calcTotalHours(entryId); }
  function calcRemainingHours(entryId) { return calcTotalHours(entryId); }

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

    const hoursPerDay = new Float64Array(totalDays + 1);
    // Build a set of all valid entry IDs to detect orphaned same_row references.
    const validEntryIds = new Set(S().ganttEntries.map(e => e.id));

    S().ganttEntries.forEach(entry => {
      if (!entry.hours_estimate) return;
      // Skip entries whose same_row target was deleted but not cleaned up yet
      // (they are invisible in the task list but would inflate the intensity bar).
      if (entry.same_row && !validEntryIds.has(entry.same_row)) return;
      const h = +(entry.hours_estimate);
      if (h <= 0) return;
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

    function drawPeriod(ps, pe) {
      if (pe <= ps) return;
      let hours = 0;
      for (let d = ps; d < pe; d++) hours += hoursPerDay[d];
      if (hours <= 0) return;
      const daysInPeriod   = pe - ps;
      // Capacity is expressed in hours/month; scale proportionally by actual days
      // in this period relative to the standard 30-day month baseline.
      const hoursPerPeriod = capacity * (daysInPeriod / 30);
      const ratio = Math.min(hours / Math.max(hoursPerPeriod, 0.1), 2);
      const r = Math.round(Math.min(255, ratio * 255));
      const g = Math.round(Math.max(0, 255 - ratio * 255));
      const a = 0.15 + Math.min(ratio, 1) * 0.7;
      ctx.fillStyle = 'rgba(' + r + ',' + g + ',0,' + a + ')';
      ctx.fillRect(ps * pxPerDay, 0, daysInPeriod * pxPerDay, H - 4);
      if (hours > 0 && daysInPeriod * pxPerDay > 30) {
        ctx.fillStyle = '#ffffff';
        ctx.font      = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(ratio * 100) + '%', (ps + daysInPeriod / 2) * pxPerDay, H - 6);
      }
    }

    if (scale === 'day') {
      for (let d = 0; d < totalDays; d++) drawPeriod(d, d + 1);
    } else if (scale === 'week') {
      // Use calendar week boundaries (Mondays) to match the ruler
      forEachDay(chartStart, chartEnd, (d, i) => {
        if (d.getDay() === 1 || i === 0) {
          const daysLeft = Math.min(daysBetween(d, chartEnd), totalDays - i);
          const cellDays = d.getDay() === 1
            ? Math.min(7, daysLeft)
            : Math.min((8 - d.getDay()) % 7 || 7, daysLeft); // days remaining in partial week
          drawPeriod(i, i + cellDays);
        }
      });
    } else {
      // Month scale: use calendar month boundaries to match the ruler
      let cur = new Date(chartStart);
      while (true) {
        const ps = daysBetween(chartStart, cur);
        if (ps >= totalDays) break;
        const nextMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
        const pe = Math.min(totalDays, daysBetween(chartStart, nextMonth));
        drawPeriod(ps, pe);
        cur = nextMonth;
      }
    }

    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, H - 4, timelineW, 4);
  }

  function syncIntensityScroll() {
    if (intensityBarCanvas) {
      intensityBarCanvas.style.marginLeft = '-' + ganttTimeline.scrollLeft + 'px';
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
      chartStart = null;
      chartEnd   = null;
      render();
    });
    ganttBreadcrumb.appendChild(backBtn);

    const root = document.createElement('span');
    root.className  = 'gantt-bc-item';
    root.textContent = (S().currentProject && S().currentProject.name) || 'Project';
    root.addEventListener('click', () => {
      parentStack = []; currentParentId = null;
      chartStart = null;
      chartEnd   = null;
      render();
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
          chartStart = null;
          chartEnd   = null;
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
    chartStart = null;
    chartEnd   = null;
    render();
  }

  // =========================================================================
  // Entry Modals
  // =========================================================================
  function showAddEntryModal(parentId, startDateOverride, endDateOverride, sameRowIdOverride, rowOnlyOverride) {
    const today    = startDateOverride || toDateStr(new Date());
    const startDt  = parseDate(today) || new Date();
    const nextWeek = endDateOverride   || toDateStr(addDays(startDt, 7));

    // Inherit color from the row being added to (same-row), falling back to parent, then 0
    const rowEntry = sameRowIdOverride ? S().ganttEntries.find(e => e.id === sameRowIdOverride) : null;
    const parentEntry = (parentId !== undefined) ? S().ganttEntries.find(e => e.id === parentId) : null;
    const defaultColorVariation = rowEntry ? (rowEntry.color_variation || 0)
      : parentEntry ? (parentEntry.color_variation || 0) : 0;

    U().openModal('Add Gantt Entry', buildEntryFormHtml({
      title: '', start_date: today, end_date: nextWeek,
      row_label: '', row_height: ROW_H, row_only: rowOnlyOverride ? 1 : 0,
      hours_estimate: '', color_variation: defaultColorVariation, notes: '', folder_url: '',
    }, parentId !== undefined), async () => {
      const vals = readEntryForm();
      if (!vals.title && vals.row_only) vals.title = vals.row_label || 'Category';
      if (!vals.row_label) vals.row_label = vals.title;
      if (!vals.title) return alert('Title is required');
      try {
        const data = await API('POST', '/api/gantt', {
          project_id: S().currentProject.id,
          parent_id: parentId !== undefined ? parentId : currentParentId,
          same_row: sameRowIdOverride || null,
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

  function showAddEmptyRowModal() {
    const vars = U().generateColorVariations((S().user && S().user.base_color) || '#2196F3');
    const swatches = vars.map((c, i) =>
      '<div class="color-var-swatch' + (i === 0 ? ' selected' : '') +
      '" data-idx="' + i + '" style="background:' + c + '" title="Phase ' + (i + 1) + '"></div>'
    ).join('');

    const html =
      '<div class="form-group">' +
        '<label>Row name</label>' +
        '<input type="text" id="feRowLabel" placeholder="Row/category name">' +
      '</div>' +
      '<div class="form-group">' +
        '<label><input type="checkbox" id="feRowOnly" checked> Row only (category/no bar)</label>' +
      '</div>' +
      '<div class="form-group"><label>Phase / Colour Variation</label>' +
        '<div class="color-variation-picker" id="colorVarPicker">' + swatches + '</div>' +
        '<input type="hidden" id="feColorVar" value="0">' +
      '</div>';

    U().openModal('Add Empty Row', html, async () => {
      const rowLabel = (document.getElementById('feRowLabel') && document.getElementById('feRowLabel').value.trim()) || '';
      const rowOnly  = !!(document.getElementById('feRowOnly') && document.getElementById('feRowOnly').checked);
      const colorVar = parseInt((document.getElementById('feColorVar') && document.getElementById('feColorVar').value) || '0', 10) || 0;
      const title    = rowLabel || 'Category';
      const today    = toDateStr(new Date());
      const nextWeek = toDateStr(addDays(new Date(), 7));
      try {
        const data = await API('POST', '/api/gantt', {
          project_id: S().currentProject.id,
          parent_id:  currentParentId,
          same_row:   null,
          title,
          row_label:       rowLabel || title,
          row_only:        rowOnly ? 1 : 0,
          start_date:      today,
          end_date:        nextWeek,
          hours_estimate:  0,
          color_variation: colorVar,
          notes:           '',
          folder_url:      '',
        });
        S().ganttEntries.push(data.entry);
        expandChartRange(data.entry);
        render();
        U().closeModal();
        U().updateUndoRedoBtns?.();
      } catch (err) {
        alert('Save failed: ' + err.message);
      }
    });
  }

  function showEditEntryModal(entry) {
    U().openModal('Edit Entry', buildEntryFormHtml(entry, !!entry.parent_id), async () => {
      const vals = readEntryForm();
      if (!vals.title && vals.row_only) vals.title = entry.title || vals.row_label || 'Category';
      if (!vals.row_label) vals.row_label = vals.title;
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

  // ── Bulk-edit modal for multiple selected tasks ────────────────────────
  function showBulkEditModal(entries) {
    const vars = U().generateColorVariations((S().user && S().user.base_color) || '#2196F3');
    const swatches = vars.map((c, i) =>
      '<div class="color-var-swatch" data-idx="' + i + '" style="background:' + c + '" title="Phase ' + (i + 1) + '"></div>'
    ).join('');

    // Notes & folder fields are only shown if ALL selected entries have them empty
    const anyHasNotes  = entries.some(e => e.notes && e.notes.trim());
    const anyHasFolder = entries.some(e => e.folder_url && e.folder_url.trim());

    let html =
      '<p style="color:var(--text-muted);margin:0 0 12px">' +
        'Editing <strong>' + entries.length + '</strong> tasks. Only the fields below will be changed.' +
      '</p>' +
      '<div class="form-group"><label>Phase / Colour Variation</label>' +
        '<div class="color-variation-picker" id="colorVarPicker">' + swatches + '</div>' +
        '<input type="hidden" id="feColorVar" value="">' +
        '<small style="color:var(--text-muted);font-size:11px;display:block">' +
          'Select a colour to apply to all selected tasks. Leave unselected to keep current colours.' +
        '</small>' +
      '</div>';

    if (!anyHasFolder) {
      html +=
        '<div class="form-group">' +
          '<label>Folder Link (optional)</label>' +
          '<input type="url" id="feFolderUrl" value="" ' +
            'placeholder="https://\u2026sharepoint.com/\u2026  or any URL" style="width:100%">' +
        '</div>';
    }

    if (!anyHasNotes) {
      html +=
        '<div class="form-group"><label>Notes</label>' +
          '<textarea id="feNotes" placeholder="Optional notes"></textarea>' +
        '</div>';
    }

    U().openModal('Edit ' + entries.length + ' Tasks', html, async () => {
      const colorVal = document.getElementById('feColorVar')?.value;
      const notesEl  = document.getElementById('feNotes');
      const folderEl = document.getElementById('feFolderUrl');

      const payload = {};
      if (colorVal !== '') payload.color_variation = parseInt(colorVal, 10);
      if (notesEl && notesEl.value.trim())  payload.notes = notesEl.value;
      if (folderEl && folderEl.value.trim()) {
        let url = folderEl.value.trim();
        if (url && !/^https?:\/\//i.test(url) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
          url = 'https://' + url;
        }
        payload.folder_url = url;
      }

      if (Object.keys(payload).length === 0) {
        U().closeModal();
        return;
      }

      try {
        const results = await Promise.all(
          entries.map(entry => API('PUT', '/api/gantt/' + entry.id, payload))
        );
        results.forEach(data => {
          const idx = S().ganttEntries.findIndex(e => e.id === data.entry.id);
          if (idx !== -1) S().ganttEntries[idx] = data.entry;
        });
        render();
        U().closeModal();
        U().updateUndoRedoBtns?.();
      } catch (err) {
        alert('Bulk edit failed: ' + err.message);
      }
    });
  }

  async function deleteSelectedEntries(entries) {
    if (!confirm('Delete ' + entries.length + ' tasks?')) return;
    try {
      const deletedIds = new Set();
      await Promise.all(entries.map(async entry => {
        try {
          const data = await API('DELETE', '/api/gantt/' + entry.id);
          (data.deleted_ids || [entry.id]).forEach(id => deletedIds.add(id));
        } catch (err) {
          // Entry may have already been recursively deleted along with a parent; treat as deleted
          deletedIds.add(entry.id);
        }
      }));
      S().ganttEntries = S().ganttEntries.filter(e => !deletedIds.has(e.id));
      S().dependencies = S().dependencies.filter(
        d => !deletedIds.has(d.source_id) && !deletedIds.has(d.target_id)
      );
      // Clear stale same_row references pointing to any deleted entry so they
      // don't become invisible orphans that still inflate the intensity bar.
      S().ganttEntries.forEach(e => {
        if (e.same_row && deletedIds.has(e.same_row)) e.same_row = null;
      });
      deletedIds.forEach(id => S().selectedGanttIds.delete(id));
      U().updateDeleteBtn();
      U().updateUndoRedoBtns?.();
      render();
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  function buildEntryFormHtml(entry, isSubtask) {
    const vars = U().generateColorVariations((S().user && S().user.base_color) || '#2196F3');
    const swatches = vars.map((c, i) =>
      '<div class="color-var-swatch' + (entry.color_variation === i ? ' selected' : '') +
      '" data-idx="' + i + '" style="background:' + c + '" title="Phase ' + (i + 1) + '"></div>'
    ).join('');

    const colorPickerHtml = isSubtask
      ? '<div class="form-group"><label>Phase / Colour Variation</label>' +
          '<div class="color-variation-picker" id="colorVarPicker">' + swatches + '</div>' +
          '<input type="hidden" id="feColorVar" value="' + (entry.color_variation || 0) + '">' +
          '<small style="color:var(--text-muted);font-size:11px;display:block">' +
            'Colour is inherited from the parent task by default. Select a swatch to override.' +
          '</small>' +
        '</div>'
      : '<div class="form-group"><label>Phase / Colour Variation</label>' +
          '<div class="color-variation-picker" id="colorVarPicker">' + swatches + '</div>' +
          '<input type="hidden" id="feColorVar" value="' + (entry.color_variation || 0) + '">' +
        '</div>';

    // No subtask-hours hint: each task's hours are independent.
    const childHoursHtml = '';

    return '<div class="form-group">' +
      '<label>Title</label>' +
      '<input type="text" id="feTitle" value="' + U().escHtml(entry.title || '') + '" placeholder="Task name">' +
      '</div>' +
      '<div class="form-group">' +
      '<label>Row name</label>' +
      '<input type="text" id="feRowLabel" value="' + U().escHtml(entry.row_label || entry.title || '') + '" placeholder="Row/category name">' +
      '</div>' +
      '<div class="form-group">' +
      '<label><input type="checkbox" id="feRowOnly" ' + ((+entry.row_only ? 'checked' : '')) + '> Row only (category/no bar)</label>' +
      '</div>' +
      '<div style="display:flex;gap:12px">' +
        '<div class="form-group" style="flex:1"><label>Start Date</label>' +
          '<input type="date" id="feStart" value="' + (entry.start_date || '') + '"></div>' +
        '<div class="form-group" style="flex:1"><label>End Date</label>' +
          '<input type="date" id="feEnd" value="' + (entry.end_date || '') + '"></div>' +
      '</div>' +
      '<div class="form-group"><label>Hours Estimate</label>' +
        '<input type="number" id="feHours" value="' + (entry.hours_set ? (entry.hours_estimate || 0) : '') + '" min="0" step="0.5" placeholder="0">' +
        childHoursHtml +
      '</div>' +
      colorPickerHtml +
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
    const title = (document.getElementById('feTitle') && document.getElementById('feTitle').value.trim()) || '';
    const rowLabel = (document.getElementById('feRowLabel') && document.getElementById('feRowLabel').value.trim()) || title;
    return {
      title:           title,
      row_label:       rowLabel,
      row_only:        !!(document.getElementById('feRowOnly') && document.getElementById('feRowOnly').checked),
      start_date:      (document.getElementById('feStart') && document.getElementById('feStart').value) || '',
      end_date:        (document.getElementById('feEnd')   && document.getElementById('feEnd').value)   || '',
      hours_estimate:  parseFloat((document.getElementById('feHours') && document.getElementById('feHours').value)) || 0,
      hours_set:       (document.getElementById('feHours') && document.getElementById('feHours').value !== '') ? 1 : 0,
      color_variation: parseInt((document.getElementById('feColorVar') && document.getElementById('feColorVar').value)) || 0,
      notes:           (document.getElementById('feNotes') && document.getElementById('feNotes').value) || '',
      folder_url:      folderUrl,
    };
  }

  // =========================================================================
  // Context Menu
  // =========================================================================

  // Build color-variation submenu items for an entry
  function buildColorSubmenu(entry) {
    const vars = U().generateColorVariations((S().user && S().user.base_color) || '#2196F3');
    return vars.map((color, i) => {
      // Validate hex color before interpolating into HTML (values are generated
      // by generateColorVariations but we guard against unexpected output).
      const safeColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#cccccc';
      return {
        icon: '<span style="display:inline-block;width:14px;height:14px;background:' + safeColor +
              ';border-radius:3px;vertical-align:middle;flex-shrink:0"></span>',
        label: 'Phase ' + (i + 1) + (entry.color_variation === i ? ' ✓' : ''),
        action: async () => {
          try {
            const data = await API('PUT', '/api/gantt/' + entry.id, { color_variation: i });
            const idx = S().ganttEntries.findIndex(e => e.id === entry.id);
            if (idx !== -1) S().ganttEntries[idx] = data.entry;
            render();
          } catch (err) {
            alert('Failed to update color: ' + err.message);
          }
        },
      };
    });
  }

  function showEntryContextMenu(x, y, entry) {
    // ── Multi-selection context menu ───────────────────────────────────────
    const sel = S().selectedGanttIds;
    if (sel.size > 1 && sel.has(entry.id)) {
      const selEntries = S().ganttEntries.filter(e => sel.has(e.id));
      U().showContextMenu(x, y, [
        { icon: '\u270F', label: 'Edit ' + selEntries.length + ' tasks\u2026', action: () => showBulkEditModal(selEntries) },
        { separator: true },
        { icon: '\uD83D\uDCCB', label: 'Copy ' + selEntries.length + ' tasks', action: () => copySelected(false) },
        { icon: '\u2702',       label: 'Cut '  + selEntries.length + ' tasks', action: () => copySelected(true) },
        clipboardData
          ? { icon: '\uD83D\uDCCB', label: 'Paste below', action: () => pasteEntries(null, entry) }
          : null,
        { separator: true },
        { icon: '\uD83D\uDDD1', label: 'Delete ' + selEntries.length + ' tasks', action: () => deleteSelectedEntries(selEntries), danger: true },
      ].filter(Boolean));
      return;
    }

    const hasChildren = S().ganttEntries.some(e => e.parent_id === entry.id);
    const siblings = getSortedSiblings(entry);
    const sibIdx = siblings.findIndex(e => e.id === entry.id);
    const canMoveUp   = sibIdx > 0;
    const canMoveDown = sibIdx < siblings.length - 1;
    const hasSameRow  = !!entry.same_row;
    const sameRowTargets = S().ganttEntries.filter(e => e.same_row === entry.id);
    U().showContextMenu(x, y, [
      { icon: '\u270F', label: 'Edit',                 action: () => showEditEntryModal(entry) },
      { icon: '+',      label: 'Add sub-task',          action: () => showAddEntryModal(entry.id) },
      { icon: '≡',      label: 'Add task in this row',   action: () => showAddEntryModal(undefined, entry.start_date, entry.end_date, entry.id) },
      hasChildren
        ? { icon: '\u25BC', label: 'Open sub-chart',   action: () => drillDown(entry) }
        : null,
      { icon: '\uD83C\uDFA8', label: 'Color',           children: buildColorSubmenu(entry) },
      { separator: true },
      canMoveUp   ? { icon: '\u2B06', label: 'Move up',   action: () => moveEntryUp(entry) }   : null,
      canMoveDown ? { icon: '\u2B07', label: 'Move down', action: () => moveEntryDown(entry) } : null,
      (canMoveUp || canMoveDown) ? { separator: true } : null,
      { icon: '\uD83D\uDCCB', label: 'Copy',            action: () => copyEntry(entry, false) },
      { icon: '\u2702',       label: 'Cut',             action: () => copyEntry(entry, true) },
      clipboardData
        ? { icon: '\uD83D\uDCCB', label: 'Paste below', action: () => pasteEntries(null, entry) }
        : null,
      { separator: true },
      hasSameRow
        ? { icon: '\u2936', label: 'Unshare row',       action: () => unshareRow(entry) }
        : { icon: '\u2194', label: 'Share row\u2026',   action: () => startShareRow(entry) },
      sameRowTargets.length > 0
        ? { icon: '\u2936', label: 'Detach all shared',  action: () => unshareAllFromRow(entry) }
        : null,
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
  // Share Row – place multiple tasks on the same visual row
  // =========================================================================
  function startShareRow(entry) {
    shareRowLink.active   = true;
    shareRowLink.sourceId = entry.id;
    document.body.classList.add('share-row-mode');
    const banner = document.getElementById('shareRowBanner');
    if (banner) banner.classList.remove('hidden');
  }

  async function finishShareRow(targetEntry) {
    if (!shareRowLink.active || shareRowLink.sourceId === targetEntry.id) return;
    const sourceId = shareRowLink.sourceId;
    cancelShareRow();

    // Resolve the target: walk the chain until we find the root row owner
    let resolvedTarget = targetEntry.id;
    const visited = new Set([sourceId]);
    let cursor = targetEntry;
    while (cursor && cursor.same_row) {
      if (visited.has(cursor.same_row)) break; // prevent infinite loop
      visited.add(cursor.same_row);
      const next = S().ganttEntries.find(e => e.id === cursor.same_row);
      if (!next) break;
      resolvedTarget = next.id;
      cursor = next;
    }

    // Prevent circular: source cannot share its own row
    if (resolvedTarget === sourceId) return;

    try {
      // If the source is a child of the resolved target, release the
      // parent-child relationship so moving one doesn't stretch the other.
      const sourceEntry = S().ganttEntries.find(e => e.id === sourceId);
      const updatePayload = { same_row: resolvedTarget };
      if (sourceEntry && sourceEntry.parent_id === resolvedTarget) {
        updatePayload.parent_id = null;
      }

      const data = await API('PUT', '/api/gantt/' + sourceId, updatePayload);
      const idx = S().ganttEntries.findIndex(e => e.id === sourceId);
      if (idx !== -1) S().ganttEntries[idx] = data.entry;

      // Also release the reverse: if the target is a child of the source
      const resolvedEntry = S().ganttEntries.find(e => e.id === resolvedTarget);
      if (resolvedEntry && resolvedEntry.parent_id === sourceId) {
        try {
          const data2 = await API('PUT', '/api/gantt/' + resolvedTarget, { parent_id: null });
          const idx2 = S().ganttEntries.findIndex(e => e.id === resolvedTarget);
          if (idx2 !== -1) S().ganttEntries[idx2] = data2.entry;
        } catch (err2) { console.error('Release child from parent failed:', err2); }
      }

      render();
    } catch (err) {
      console.error('Share row failed:', err);
    }
  }

  function cancelShareRow() {
    shareRowLink.active = false;
    shareRowLink.sourceId = null;
    document.body.classList.remove('share-row-mode');
    const banner = document.getElementById('shareRowBanner');
    if (banner) banner.classList.add('hidden');
  }

  async function unshareRow(entry) {
    try {
      const data = await API('PUT', '/api/gantt/' + entry.id, { same_row: null });
      const idx = S().ganttEntries.findIndex(e => e.id === entry.id);
      if (idx !== -1) S().ganttEntries[idx] = data.entry;
      render();
    } catch (err) {
      console.error('Unshare row failed:', err);
    }
  }

  async function unshareAllFromRow(entry) {
    const targets = S().ganttEntries.filter(e => e.same_row === entry.id);
    for (const t of targets) {
      try {
        const data = await API('PUT', '/api/gantt/' + t.id, { same_row: null });
        const idx = S().ganttEntries.findIndex(e => e.id === t.id);
        if (idx !== -1) S().ganttEntries[idx] = data.entry;
      } catch (err) {
        console.error('Unshare row failed:', err);
      }
    }
    render();
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
    // Also collect entries that share a row with any collected entry.
    // These may have a parent_id outside the subtree (e.g. created from a higher view level).
    const collectedIds = new Set(result.map(e => e.id));
    let changed = true;
    while (changed) {
      changed = false;
      S().ganttEntries.forEach(e => {
        if (e.same_row && collectedIds.has(e.same_row) && !collectedIds.has(e.id)) {
          result.push(Object.assign({}, e));
          collectedIds.add(e.id);
          changed = true;
        }
      });
    }
    return result;
  }

  function isDescendantOf(entryId, maybeAncestorId) {
    let cursor = S().ganttEntries.find(e => e.id === entryId);
    while (cursor && cursor.parent_id) {
      if (cursor.parent_id === maybeAncestorId) return true;
      cursor = S().ganttEntries.find(e => e.id === cursor.parent_id);
    }
    return false;
  }

  function copyEntry(entry, cut) {
    const entries = collectSubtree(entry.id);
    const entryIds = new Set(entries.map(e => e.id));
    const deps = (S().dependencies || []).filter(d => entryIds.has(d.source_id) && entryIds.has(d.target_id));
    clipboardData = { entries, rootIds: [entry.id], cut, deps };
  }

  /** Called from app.js keyboard handler – copies the first selected entry */
  function copySelected(cut) {
    const selected = [...S().selectedGanttIds];
    if (selected.length === 0) return;
    const dedup = new Map();
    selected.forEach(id => {
      collectSubtree(id).forEach(e => dedup.set(e.id, e));
    });
    const entries = [...dedup.values()];
    const entryIds = new Set(entries.map(e => e.id));
    const deps = (S().dependencies || []).filter(d => entryIds.has(d.source_id) && entryIds.has(d.target_id));
    clipboardData = {
      entries,
      rootIds: selected.filter(id => !selected.some(other => other !== id && isDescendantOf(id, other))),
      cut,
      deps,
    };
  }

  /** Called from app.js keyboard handler – pastes below the last selected entry (or at original dates if none) */
  function pasteAtDate() {
    if (!clipboardData) return;
    const sel = [...S().selectedGanttIds];
    if (sel.length > 0 && lastClickedId) {
      const afterEntry = S().ganttEntries.find(e => e.id === lastClickedId);
      if (afterEntry) {
        pasteEntries(null, afterEntry);
        return;
      }
    }
    pasteEntries(null);
  }

  /**
   * Paste copied/cut entries.
   * @param {string|null} pasteStartDate - ISO date string to align the first root entry's start to.
   *   Pass null to preserve the original dates of all pasted entries unchanged.
   * @param {object|null} afterEntry - If provided, pasted root entries become siblings of this
   *   entry, inserted immediately after it in the sort order.
   */
  async function pasteEntries(pasteStartDate, afterEntry = null) {
    if (!clipboardData || !S().currentProject) return;
    const { entries, rootIds, cut } = clipboardData;
    const idMap = {}; // old id → new id
    const newRootIds = []; // new IDs of pasted root entries, for reorder-after
    const sameRowUpdates = []; // { newId, oldSameRow } – applied after all entries are created

    // When pasting below a specific row, use that row's parent as the parent for root entries
    const pasteParentId = afterEntry !== null
      ? (afterEntry.parent_id !== undefined ? afterEntry.parent_id : null)
      : currentParentId;

    // Calculate a single shared dayOffset from the earliest start across ALL roots so that
    // relative temporal positions between pasted entries are preserved (e.g. same-row groups).
    let overallEarliestStart = null;
    for (const rootId of (rootIds || [])) {
      const root = entries.find(e => e.id === rootId);
      if (!root) continue;
      const tempSorted = [];
      const addTemp = (id) => {
        const e = entries.find(x => x.id === id);
        if (!e || tempSorted.includes(e)) return;
        tempSorted.push(e);
        entries.filter(x => x.parent_id === id).forEach(c => addTemp(c.id));
      };
      addTemp(rootId);
      let rootStart = parseDate(root.start_date);
      if (!rootStart) {
        const allDates = tempSorted.map(e => parseDate(e.start_date)).filter(Boolean);
        rootStart = allDates.length
          ? new Date(Math.min(...allDates.map(d => d.getTime())))
          : null;
      }
      if (rootStart && (!overallEarliestStart || rootStart < overallEarliestStart)) overallEarliestStart = rootStart;
    }

    // If pasteStartDate is null, preserve original dates (offset = 0).
    // Otherwise align the group so the earliest root starts at pasteStartDate.
    const pasteStart = pasteStartDate ? parseDate(pasteStartDate) : (overallEarliestStart || new Date());
    const sharedDayOffset = overallEarliestStart ? daysBetween(overallEarliestStart, pasteStart) : 0;

    for (const rootId of (rootIds || [])) {
      const root = entries.find(e => e.id === rootId);
      if (!root) continue;

      // Build sorted list (parent before children) for this root's subtree
      const sorted = [];
      const addSorted = (id) => {
        const e = entries.find(x => x.id === id);
        if (!e || sorted.includes(e)) return;
        sorted.push(e);
        entries.filter(x => x.parent_id === id).forEach(c => addSorted(c.id));
      };
      addSorted(rootId);
      // Also include any entries not reachable via parent_id traversal (e.g. same_row
      // entries whose parent_id is outside this subtree).
      for (const e of entries) {
        if (!sorted.includes(e)) sorted.push(e);
      }

      for (const e of sorted) {
        if (e.id in idMap) continue; // already created in a prior root's iteration
        // Determine parent: root entries go to pasteParentId; children of pasted entries
        // use their new mapped parent; same_row extras whose original parent_id wasn't in
        // the copied set become children of their row owner (idMap[e.same_row]) so they
        // remain descendants of the pasted root and are cascade-deleted with it.
        // Only fall back to pasteParentId when the row owner was also not pasted.
        const newParentId = e.id === rootId
          ? pasteParentId
          : (e.parent_id != null && e.parent_id in idMap
              ? idMap[e.parent_id]
              : (e.same_row != null && e.same_row in idMap
                  ? idMap[e.same_row]
                  : pasteParentId));
        const rawStart = parseDate(e.start_date);
        const rawEnd   = parseDate(e.end_date);
        const newStart = rawStart ? toDateStr(addDays(rawStart, sharedDayOffset)) : toDateStr(pasteStart);
        const newEnd   = rawEnd   ? toDateStr(addDays(rawEnd,   sharedDayOffset)) : toDateStr(addDays(pasteStart, 7));
        try {
          const data = await API('POST', '/api/gantt', {
            project_id:      S().currentProject.id,
            parent_id:       newParentId,
            title:           e.title,
            row_label:       e.row_label,
            row_height:      e.row_height,
            row_only:        (+e.row_only) ? 1 : 0,
            start_date:      newStart,
            end_date:        newEnd,
            hours_estimate:  e.hours_estimate,
            color_variation: e.color_variation,
            notes:           e.notes,
            folder_url:      e.folder_url,
            position:        e.position,
            suppress_undo:   1,
          });
          idMap[e.id] = data.entry.id;
          S().ganttEntries.push(data.entry);
          expandChartRange(data.entry);
          if (data.entry.parent_id && data.entry.parent_id !== currentParentId) {
            expandedIds.add(data.entry.parent_id);
          }
          if (e.id === rootId) newRootIds.push(data.entry.id);
          // Queue same_row update for second pass once all idMap entries are known
          if (e.same_row) sameRowUpdates.push({ newId: data.entry.id, oldSameRow: e.same_row });
        } catch (err) {
          console.error('Paste failed for entry "' + e.title + '":', err);
        }
      }
    }

    // Restore same_row links for pasted entries whose owner was also pasted.
    // Done as a second pass so idMap is fully populated regardless of entry ordering.
    // Group by the original owner so we can handle orphan groups gracefully.
    const sameRowGroups = {}; // oldOwnerId → [newId, ...]
    for (const { newId, oldSameRow } of sameRowUpdates) {
      if (!sameRowGroups[oldSameRow]) sameRowGroups[oldSameRow] = [];
      sameRowGroups[oldSameRow].push(newId);
    }
    for (const [oldSameRow, newIds] of Object.entries(sameRowGroups)) {
      const newOwner = idMap[oldSameRow];
      if (newOwner !== undefined) {
        // Owner was also pasted – point all dependents to its new ID.
        for (const newId of newIds) {
          try {
            const upd = await API('PUT', '/api/gantt/' + newId, { same_row: newOwner, suppress_undo: 1 });
            const idx = S().ganttEntries.findIndex(en => en.id === newId);
            if (idx !== -1) S().ganttEntries[idx].same_row = upd.entry ? upd.entry.same_row : newOwner;
          } catch (err) { console.error('Same-row restore failed for pasted entry:', err); }
        }
      } else if (newIds.length > 1) {
        // Owner was not pasted but multiple dependents share the same old owner:
        // promote the first pasted entry as the new row owner and chain the rest to it.
        const groupOwner = newIds[0]; // already created with same_row=null – it IS the owner
        for (let i = 1; i < newIds.length; i++) {
          try {
            const upd = await API('PUT', '/api/gantt/' + newIds[i], { same_row: groupOwner, suppress_undo: 1 });
            const idx = S().ganttEntries.findIndex(en => en.id === newIds[i]);
            if (idx !== -1) S().ganttEntries[idx].same_row = upd.entry ? upd.entry.same_row : groupOwner;
          } catch (err) { console.error('Same-row group failed for pasted entry:', err); }
        }
      }
      // If newIds.length === 1 and owner not pasted: single orphan, leave as standalone row
    }

    // Recreate dependencies between pasted entries (where both ends were pasted)
    const depsToRestore = clipboardData.deps || [];
    for (const dep of depsToRestore) {
      const newSourceId = idMap[dep.source_id];
      const newTargetId = idMap[dep.target_id];
      if (newSourceId !== undefined && newTargetId !== undefined) {
        try {
          const data = await API('POST', '/api/dependencies', {
            project_id: S().currentProject.id,
            source_id: newSourceId,
            target_id: newTargetId,
          });
          if (data.dep && !S().dependencies.some(d => d.id === data.dep.id)) {
            S().dependencies.push(data.dep);
          }
        } catch (err) { console.error('Restore dependency failed:', err); }
      }
    }

    // If pasting below a specific entry, reorder the new root entries to appear after it
    let pasteOldPositions = []; // old sibling positions, captured before reorder for undo
    if (afterEntry && newRootIds.length > 0) {
      const newRootIdSet = new Set(newRootIds);
      const siblings = S().ganttEntries
        .filter(e => (e.parent_id === pasteParentId || (!e.parent_id && !pasteParentId)) &&
                     !newRootIdSet.has(e.id))
        .sort((a, b) => (a.position - b.position) || (a.created_at > b.created_at ? 1 : -1));
      pasteOldPositions = siblings.map(e => ({ id: e.id, position: e.position }));
      const afterIdx = siblings.findIndex(e => e.id === afterEntry.id);
      const insertAt = afterIdx !== -1 ? afterIdx + 1 : siblings.length;
      const newEntries = newRootIds.map(id => S().ganttEntries.find(e => e.id === id)).filter(Boolean);
      const reordered = [
        ...siblings.slice(0, insertAt),
        ...newEntries,
        ...siblings.slice(insertAt),
      ];
      const positions = reordered.map((e, i) => ({ id: e.id, position: i }));
      try {
        const result = await API('POST', '/api/gantt/' + S().currentProject.id + '/reorder', { positions, suppress_undo: 1 });
        result.entries.forEach(updated => {
          const idx = S().ganttEntries.findIndex(e => e.id === updated.id);
          if (idx !== -1) S().ganttEntries[idx].position = updated.position;
        });
      } catch (err) { console.error('Reorder after paste failed:', err); }
    }

    // Record the entire paste as a single undo action
    if (!cut) {
      const allNewIds = Object.values(idMap);
      if (allNewIds.length > 0) {
        try {
          await API('POST', '/api/gantt/' + S().currentProject.id + '/record-paste', {
            entry_ids:     allNewIds,
            old_positions: pasteOldPositions,
          });
        } catch (err) { console.error('Failed to record paste undo:', err); }
      }
    }

    if (cut) {
      const uniqueSorted = [];
      entries.forEach(e => uniqueSorted.push(e));
      for (const e of [...uniqueSorted].reverse()) {
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
    const data = await API('DELETE', '/api/gantt/' + entry.id);
    const deletedIds = new Set(data.deleted_ids || [entry.id]);
    S().ganttEntries  = S().ganttEntries.filter(e => !deletedIds.has(e.id));
    S().dependencies  = S().dependencies.filter(
      d => !deletedIds.has(d.source_id) && !deletedIds.has(d.target_id)
    );
    // Clear stale same_row references pointing to any deleted entry so they
    // don't become invisible orphans that still inflate the intensity bar.
    S().ganttEntries.forEach(e => {
      if (e.same_row && deletedIds.has(e.same_row)) e.same_row = null;
    });
    deletedIds.forEach(id => S().selectedGanttIds.delete(id));
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
    return Math.round((b - a) / 86400000);
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

    // Build a set of entry IDs that share another entry's row
    const sameRowEntryIds = new Set();
    all.forEach(e => { if (e.same_row) sameRowEntryIds.add(e.id); });

    const roots  = childrenOf[currentParentId] || [];
    const result = [];

    function addWithChildren(entry, depth) {
      // Skip entries that share another entry's row (they'll be drawn as extra bars)
      if (sameRowEntryIds.has(entry.id)) return;
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

    // Include both visible entries and same-row entries in the range calculation
    const allRelevant = entries.slice();
    S().ganttEntries.forEach(e => {
      if (e.same_row && entries.some(v => v.id === e.same_row)) {
        allRelevant.push(e);
      }
    });

    allRelevant.forEach(e => {
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
