'use strict';

// ==========================================================================
// OnlineProjectPlanner – Gantt Chart Module
//
// Renders a fully interactive Gantt chart:
//  • Time-scaled ruler (day / week / month zoom levels)
//  • Draggable bars  → move entire entry (shifts both start + end)
//  • Resizable bars  → drag LEFT handle to change start_date
//                    → drag RIGHT handle to change end_date
//  • Intensity bar   → shows scheduled hours vs team capacity per period
//  • Hierarchical    → entries can have children; double-click to drill in
//  • Breadcrumb nav  → click crumb to navigate back up the hierarchy
//  • Color system    → user base color + 10 variations (phase indicator)
//  • Selection       → click to select, Shift-click multi-select
//  • Sync            → saves to server on drag-end; WS broadcast propagates
// ==========================================================================

(function () {

  // ---- constants ----------------------------------------------------------

  const ROW_H = 40;            // px, must match CSS --row-h
  const MIN_BAR_DAYS = 1;      // minimum bar width in days
  const HANDLE_W = 8;          // px, width of resize handle zone

  // ---- state refs (injected from app.js globals) --------------------------

  const S = () => window.appState;
  const API = (m, u, b) => window.appAPI(m, u, b);
  const U = () => window.appUtils;

  // ---- internal module state ----------------------------------------------

  let parentStack = [];   // stack of { entry, label } for sub-gantt breadcrumb
  let currentParentId = null;  // null = root level of project

  let scale = 'week';     // 'day' | 'week' | 'month'
  let pxPerDay = 28;      // pixels per calendar day
  let chartStart = null;  // Date object – leftmost date of the visible chart
  let chartEnd = null;    // Date object – rightmost date

  // drag state
  const drag = {
    active: false,
    type: null,         // 'move' | 'resize-left' | 'resize-right'
    entryId: null,
    startX: 0,          // mousedown pageX
    origStart: null,    // original start_date string (yyyy-mm-dd)
    origEnd: null,      // original end_date string
    ghostEl: null,      // the .gantt-bar element being dragged
    rowEl: null,        // .gantt-row-bg
    snappedDays: 0,     // current delta in days (updated live)
  };

  // ---- DOM refs -----------------------------------------------------------

  let ganttContainer, intensityBarCanvas, ganttTaskList,
      ganttRows, ganttRuler, ganttBreadcrumb, ganttTimeline,
      intensityBarWrapper;

  // =========================================================================
  // Public API
  // =========================================================================

  window.ganttModule = {
    init,
    render,
    showAddEntryModal,
  };

  // =========================================================================
  // Init
  // =========================================================================

  function init() {
    ganttContainer      = document.getElementById('ganttContainer');
    intensityBarCanvas  = document.getElementById('intensityBarCanvas');
    ganttTaskList       = document.getElementById('ganttTaskList');
    ganttRows           = document.getElementById('ganttRows');
    ganttRuler          = document.getElementById('ganttRuler');
    ganttBreadcrumb     = document.getElementById('ganttBreadcrumb');
    ganttTimeline       = document.getElementById('ganttTimeline');
    intensityBarWrapper = document.getElementById('intensityBarWrapper');

    // Read scale selector
    document.getElementById('viewScale').addEventListener('change', (e) => {
      scale = e.target.value;
      applyScaleDefaults();
      render();
    });

    // Zoom buttons
    document.getElementById('zoomInBtn').addEventListener('click', () => {
      pxPerDay = Math.min(pxPerDay * 1.4, 200);
      render();
    });
    document.getElementById('zoomOutBtn').addEventListener('click', () => {
      pxPerDay = Math.max(pxPerDay / 1.4, 4);
      render();
    });

    // Chart date range inputs
    document.getElementById('chartStartDate').addEventListener('change', (e) => {
      if (e.target.value) chartStart = new Date(e.target.value + 'T00:00:00');
      render();
    });
    document.getElementById('chartEndDate').addEventListener('change', (e) => {
      if (e.target.value) chartEnd = new Date(e.target.value + 'T00:00:00');
      render();
    });

    // Sync scrolling between ruler and intensity bar
    ganttTimeline.addEventListener('scroll', syncScroll);

    // Global mouse events for drag
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Reset sub-gantt state when changing project
    parentStack = [];
    currentParentId = null;

    applyScaleDefaults();
    render();
  }

  function applyScaleDefaults() {
    if (scale === 'day')   pxPerDay = Math.max(pxPerDay, 40);
    if (scale === 'week')  pxPerDay = 28;
    if (scale === 'month') pxPerDay = 10;
  }

  // =========================================================================
  // Render
  // =========================================================================

  function render() {
    if (!S().currentProject) return;

    const entries = visibleEntries();

    // Determine chart date range
    autoSetChartRange(entries);

    const totalDays = Math.max(1, daysBetween(chartStart, chartEnd));
    const timelineW = totalDays * pxPerDay;

    // Set date inputs
    document.getElementById('chartStartDate').value = toDateStr(chartStart);
    document.getElementById('chartEndDate').value   = toDateStr(chartEnd);

    // Render task list (left column)
    renderTaskList(entries);

    // Render ruler
    renderRuler(timelineW, totalDays);

    // Render rows + bars
    renderRowsAndBars(entries, timelineW);

    // Render intensity bar
    renderIntensityBar(timelineW, totalDays);

    // Render breadcrumb
    renderBreadcrumb();
  }

  // -------------------------------------------------------------------------
  // Task list (left column)
  // -------------------------------------------------------------------------

  function renderTaskList(entries) {
    ganttTaskList.innerHTML = '';
    entries.forEach((entry, idx) => {
      const depth = getDepth(entry);
      const hasChildren = S().ganttEntries.some(e => e.parent_id === entry.id);
      const color = U().getUserColor(entry.user_id, entry.color_variation);

      const row = document.createElement('div');
      row.className = 'gantt-task-row' + (S().selectedGanttIds.has(entry.id) ? ' selected' : '');
      row.dataset.id = entry.id;
      row.style.cssText = `height:${ROW_H}px`;

      // Indent
      const indent = document.createElement('span');
      indent.className = 'gantt-task-indent';
      indent.style.width = (depth * 16) + 'px';
      row.appendChild(indent);

      // Expand/collapse button (only for entries with children)
      const expandBtn = document.createElement('span');
      if (hasChildren) {
        expandBtn.className = 'gantt-task-expand';
        expandBtn.textContent = '▶';
        expandBtn.title = 'Drill into sub-chart (double-click bar)';
      } else {
        expandBtn.style.width = '16px';
        expandBtn.style.display = 'inline-block';
        expandBtn.style.flexShrink = '0';
      }
      row.appendChild(expandBtn);

      // Color dot
      const dot = document.createElement('span');
      dot.className = 'gantt-task-color-dot';
      dot.style.background = color;
      row.appendChild(dot);

      // Name
      const name = document.createElement('span');
      name.className = 'gantt-task-name';
      name.textContent = entry.title;
      name.title = entry.title;
      row.appendChild(name);

      // Hours estimate
      const hours = document.createElement('span');
      hours.className = 'gantt-task-hours';
      hours.textContent = entry.hours_estimate ? `${entry.hours_estimate}h` : '';
      row.appendChild(hours);

      // Action buttons (shown on hover)
      const actions = document.createElement('div');
      actions.className = 'gantt-task-actions';

      const editBtn = makeActionBtn('✏', 'Edit', () => showEditEntryModal(entry));
      const todoBtn = makeActionBtn('☑', 'Add to Todo', () => addToTodo(entry));
      const delBtn  = makeActionBtn('🗑', 'Delete', () => deleteEntry(entry));
      actions.appendChild(editBtn);
      actions.appendChild(todoBtn);
      actions.appendChild(delBtn);
      row.appendChild(actions);

      // Sub-task add button
      const subBtn = makeActionBtn('+', 'Add sub-task', () => showAddEntryModal(entry.id));
      actions.appendChild(subBtn);

      // Selection
      row.addEventListener('click', (e) => {
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

      // Right-click context menu
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showEntryContextMenu(e.pageX, e.pageY, entry);
      });

      ganttTaskList.appendChild(row);
    });
  }

  function makeActionBtn(icon, title, fn) {
    const b = document.createElement('button');
    b.className = 'gantt-task-action-btn';
    b.textContent = icon;
    b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  // -------------------------------------------------------------------------
  // Ruler
  // -------------------------------------------------------------------------

  function renderRuler(timelineW, totalDays) {
    ganttRuler.style.width = timelineW + 'px';
    ganttRuler.style.position = 'relative';
    ganttRuler.innerHTML = '';

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Draw tick marks
    if (scale === 'day') {
      forEachDay(chartStart, chartEnd, (d, i) => {
        const isMonday = d.getDay() === 1;
        const cell = makeRulerCell(i * pxPerDay, pxPerDay, formatDay(d), isMonday ? 'major' : '');
        ganttRuler.appendChild(cell);
      });
    } else if (scale === 'week') {
      // Month labels on top half, week columns below
      forEachDay(chartStart, chartEnd, (d, i) => {
        const isMonday = d.getDay() === 1 || i === 0;
        if (isMonday) {
          const cell = makeRulerCell(i * pxPerDay, 7 * pxPerDay,
            `W${getWeekNumber(d)} – ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
            'major');
          ganttRuler.appendChild(cell);
        }
      });
    } else { // month
      let cur = new Date(chartStart);
      while (cur <= chartEnd) {
        const offsetDays = daysBetween(chartStart, cur);
        const daysInMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
        const cell = makeRulerCell(
          offsetDays * pxPerDay,
          daysInMonth * pxPerDay,
          cur.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
          'major'
        );
        ganttRuler.appendChild(cell);
        cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      }
    }

    // Today line
    if (today >= chartStart && today <= chartEnd) {
      const todayOffset = daysBetween(chartStart, today) * pxPerDay;
      const todayLine = document.createElement('div');
      todayLine.className = 'gantt-ruler-today';
      todayLine.style.left = todayOffset + 'px';
      ganttRuler.appendChild(todayLine);
    }
  }

  function makeRulerCell(left, width, label, extraClass) {
    const div = document.createElement('div');
    div.className = 'gantt-ruler-cell ' + (extraClass || '');
    div.style.cssText = `left:${left}px; width:${width}px; min-width:${width}px;`;
    div.textContent = label;
    return div;
  }

  // -------------------------------------------------------------------------
  // Rows and bars
  // -------------------------------------------------------------------------

  function renderRowsAndBars(entries, timelineW) {
    ganttRows.style.width = timelineW + 'px';
    ganttRows.innerHTML = '';

    entries.forEach((entry) => {
      const rowBg = document.createElement('div');
      rowBg.className = 'gantt-row-bg';
      rowBg.style.height = ROW_H + 'px';
      rowBg.dataset.id = entry.id;

      // Drop zone for new sub-entries
      rowBg.addEventListener('dblclick', () => drillDown(entry));

      // Bar
      const bar = buildBar(entry);
      if (bar) rowBg.appendChild(bar);

      ganttRows.appendChild(rowBg);
    });
  }

  function buildBar(entry) {
    const start = parseDate(entry.start_date);
    const end   = parseDate(entry.end_date);
    if (!start || !end || start > chartEnd || end < chartStart) return null;

    const clampedStart = start < chartStart ? chartStart : start;
    const leftDays  = daysBetween(chartStart, clampedStart);
    const widthDays = Math.max(MIN_BAR_DAYS, daysBetween(start, end));
    const left  = leftDays * pxPerDay;
    const width = widthDays * pxPerDay;

    const color  = U().getUserColor(entry.user_id, entry.color_variation);
    const hasChildren = S().ganttEntries.some(e => e.parent_id === entry.id);
    const isSelected  = S().selectedGanttIds.has(entry.id);

    const container = document.createElement('div');
    container.className = 'gantt-bar-container';
    container.style.cssText = `left:${left}px; width:${width}px;`;
    container.dataset.id = entry.id;

    const bar = document.createElement('div');
    bar.className = 'gantt-bar' + (isSelected ? ' selected' : '');
    bar.style.background = color;
    bar.style.width = '100%';
    bar.title = `${entry.title}\n${entry.start_date} → ${entry.end_date}` +
                (entry.hours_estimate ? `\n${entry.hours_estimate}h estimated` : '');

    // Label
    const label = document.createElement('span');
    label.className = 'gantt-bar-label';
    label.textContent = entry.title;
    bar.appendChild(label);

    // Sub-chart indicator
    if (hasChildren) {
      const ind = document.createElement('span');
      ind.className = 'has-children-indicator';
      ind.textContent = '▼';
      ind.title = 'Double-click to open sub-chart';
      bar.appendChild(ind);
    }

    // ── Left resize handle ──────────────────────────────────────────────────
    const handleLeft = document.createElement('div');
    handleLeft.className = 'gantt-bar-handle left';
    handleLeft.title = 'Drag to change start date';
    handleLeft.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startDrag(e, 'resize-left', entry, bar, container);
    });
    bar.appendChild(handleLeft);

    // ── Right resize handle ─────────────────────────────────────────────────
    const handleRight = document.createElement('div');
    handleRight.className = 'gantt-bar-handle right';
    handleRight.title = 'Drag to change end date';
    handleRight.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startDrag(e, 'resize-right', entry, bar, container);
    });
    bar.appendChild(handleRight);

    // ── Bar body drag (move) ────────────────────────────────────────────────
    bar.addEventListener('mousedown', (e) => {
      // Only initiate move-drag if not clicking a handle
      if (e.target === handleLeft || e.target === handleRight) return;
      e.preventDefault();
      startDrag(e, 'move', entry, bar, container);
    });

    // Double-click → drill down into sub-chart
    bar.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      drillDown(entry);
    });

    // Right-click → context menu
    bar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showEntryContextMenu(e.pageX, e.pageY, entry);
    });

    container.appendChild(bar);
    return container;
  }

  // =========================================================================
  // Drag – Resize & Move
  // =========================================================================

  function startDrag(e, type, entry, barEl, containerEl) {
    drag.active    = true;
    drag.type      = type;
    drag.entryId   = entry.id;
    drag.startX    = e.pageX;
    drag.origStart = entry.start_date;
    drag.origEnd   = entry.end_date;
    drag.ghostEl   = barEl;
    drag.containerEl = containerEl;
    drag.snappedDays = 0;

    barEl.style.opacity = '0.75';
    barEl.style.cursor  = type === 'move' ? 'grabbing' : 'col-resize';
    document.body.style.cursor = type === 'move' ? 'grabbing' : 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function onMouseMove(e) {
    if (!drag.active) return;

    const deltaX    = e.pageX - drag.startX;
    const deltaDays = Math.round(deltaX / pxPerDay);

    if (deltaDays === drag.snappedDays) return;   // no change
    drag.snappedDays = deltaDays;

    const origStartDate = parseDate(drag.origStart);
    const origEndDate   = parseDate(drag.origEnd);

    let newStart = drag.origStart;
    let newEnd   = drag.origEnd;

    if (drag.type === 'move') {
      // Shift both dates by the same amount
      newStart = toDateStr(addDays(origStartDate, deltaDays));
      newEnd   = toDateStr(addDays(origEndDate,   deltaDays));
    } else if (drag.type === 'resize-left') {
      // Only move the start date; ensure start stays before end
      const proposed = addDays(origStartDate, deltaDays);
      if (daysBetween(proposed, origEndDate) >= MIN_BAR_DAYS) {
        newStart = toDateStr(proposed);
      } else {
        newStart = toDateStr(addDays(origEndDate, -(MIN_BAR_DAYS)));
      }
    } else if (drag.type === 'resize-right') {
      // Only move the end date; ensure end stays after start
      const proposed = addDays(origEndDate, deltaDays);
      if (daysBetween(origStartDate, proposed) >= MIN_BAR_DAYS) {
        newEnd = toDateStr(proposed);
      } else {
        newEnd = toDateStr(addDays(origStartDate, MIN_BAR_DAYS));
      }
    }

    // Live visual update of the bar width / position
    updateBarVisual(drag.containerEl, newStart, newEnd);

    // Update tooltip
    if (drag.ghostEl) {
      drag.ghostEl.title = `${newStart} → ${newEnd}`;
    }
  }

  function updateBarVisual(containerEl, newStart, newEnd) {
    if (!containerEl) return;
    const start = parseDate(newStart);
    const end   = parseDate(newEnd);
    const leftDays  = Math.max(0, daysBetween(chartStart, start));
    const widthDays = Math.max(MIN_BAR_DAYS, daysBetween(start, end));
    containerEl.style.left  = (leftDays  * pxPerDay) + 'px';
    containerEl.style.width = (widthDays * pxPerDay) + 'px';
  }

  async function onMouseUp(e) {
    if (!drag.active) return;

    const deltaX    = e.pageX - drag.startX;
    const deltaDays = Math.round(deltaX / pxPerDay);

    // Restore cursor
    document.body.style.cursor    = '';
    document.body.style.userSelect = '';
    if (drag.ghostEl) {
      drag.ghostEl.style.opacity = '';
      drag.ghostEl.style.cursor  = '';
    }

    if (deltaDays !== 0) {
      // Compute final dates
      const origStartDate = parseDate(drag.origStart);
      const origEndDate   = parseDate(drag.origEnd);
      let newStart = drag.origStart;
      let newEnd   = drag.origEnd;

      if (drag.type === 'move') {
        newStart = toDateStr(addDays(origStartDate, deltaDays));
        newEnd   = toDateStr(addDays(origEndDate,   deltaDays));
      } else if (drag.type === 'resize-left') {
        const proposed = addDays(origStartDate, deltaDays);
        newStart = toDateStr(daysBetween(proposed, origEndDate) >= MIN_BAR_DAYS
          ? proposed : addDays(origEndDate, -(MIN_BAR_DAYS)));
      } else if (drag.type === 'resize-right') {
        const proposed = addDays(origEndDate, deltaDays);
        newEnd = toDateStr(daysBetween(origStartDate, proposed) >= MIN_BAR_DAYS
          ? proposed : addDays(origStartDate, MIN_BAR_DAYS));
      }

      // Persist to server
      try {
        const updated = await API('PUT', `/api/gantt/${drag.entryId}`, {
          start_date: newStart,
          end_date: newEnd,
        });
        const idx = S().ganttEntries.findIndex(e => e.id === drag.entryId);
        if (idx !== -1) S().ganttEntries[idx] = updated.entry;
      } catch (err) {
        console.error('Failed to save drag result:', err);
        // Revert visual
        updateBarVisual(drag.containerEl, drag.origStart, drag.origEnd);
      }

      render();    // full re-render to update intensity bar etc.
    }

    drag.active      = false;
    drag.type        = null;
    drag.entryId     = null;
    drag.ghostEl     = null;
    drag.containerEl = null;
  }

  // =========================================================================
  // Intensity Bar
  // =========================================================================

  function renderIntensityBar(timelineW, totalDays) {
    const canvas = intensityBarCanvas;
    const wrapper = intensityBarWrapper;
    const H = 32;
    const capacity = S().currentTeam?.capacity_hours_month || 160;

    canvas.width  = timelineW;
    canvas.height = H;
    wrapper.style.position = 'relative';

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, timelineW, H);

    // Determine period granularity based on scale
    const periodDays = scale === 'day' ? 1 : scale === 'week' ? 7 : 30;
    const hoursPerPeriod = capacity * (periodDays / 30);

    // Sum hours per day bucket
    const hoursPerDay = new Float64Array(totalDays + 1);
    const allEntries = S().ganttEntries;

    allEntries.forEach(entry => {
      if (!entry.hours_estimate) return;
      const s = parseDate(entry.start_date);
      const en = parseDate(entry.end_date);
      if (!s || !en) return;
      const span = Math.max(1, daysBetween(s, en));
      const dailyH = entry.hours_estimate / span;
      for (let d = 0; d < totalDays; d++) {
        const dayDate = addDays(chartStart, d);
        if (dayDate >= s && dayDate < en) {
          hoursPerDay[d] += dailyH;
        }
      }
    });

    // Aggregate into periods and draw
    let periodStart = 0;
    while (periodStart < totalDays) {
      const periodEnd = Math.min(periodStart + periodDays, totalDays);
      let hours = 0;
      for (let d = periodStart; d < periodEnd; d++) hours += hoursPerDay[d];

      const ratio = Math.min(hours / Math.max(hoursPerPeriod, 0.1), 2);
      const r = Math.round(Math.min(255, ratio * 255));
      const g = Math.round(Math.max(0, 255 - ratio * 255));
      const alpha = 0.15 + Math.min(ratio, 1) * 0.7;

      ctx.fillStyle = `rgba(${r},${g},0,${alpha})`;
      ctx.fillRect(periodStart * pxPerDay, 0, (periodEnd - periodStart) * pxPerDay, H - 4);

      // Percentage label
      if (hours > 0 && (periodEnd - periodStart) * pxPerDay > 30) {
        ctx.fillStyle = ratio > 0.8 ? '#b71c1c' : '#2e7d32';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        const midX = (periodStart + (periodEnd - periodStart) / 2) * pxPerDay;
        ctx.fillText(Math.round(ratio * 100) + '%', midX, H - 6);
      }

      periodStart += periodDays;
    }

    // Legend bar
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, H - 4, timelineW, 4);
  }

  // =========================================================================
  // Breadcrumb
  // =========================================================================

  function renderBreadcrumb() {
    ganttBreadcrumb.innerHTML = '';
    if (!parentStack.length) return;

    // Root link
    const root = document.createElement('span');
    root.className = 'gantt-bc-item';
    root.textContent = S().currentProject?.name || 'Project';
    root.addEventListener('click', () => {
      parentStack = [];
      currentParentId = null;
      render();
    });
    ganttBreadcrumb.appendChild(root);

    parentStack.forEach((crumb, i) => {
      const sep = document.createElement('span');
      sep.className = 'gantt-bc-sep';
      sep.textContent = ' › ';
      ganttBreadcrumb.appendChild(sep);

      if (i < parentStack.length - 1) {
        const item = document.createElement('span');
        item.className = 'gantt-bc-item';
        item.textContent = crumb.label;
        item.addEventListener('click', () => {
          parentStack = parentStack.slice(0, i + 1);
          currentParentId = crumb.entry.id;
          render();
        });
        ganttBreadcrumb.appendChild(item);
      } else {
        const cur = document.createElement('span');
        cur.className = 'gantt-bc-current';
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
  // Helpers – Date Math
  // =========================================================================

  function parseDate(str) {
    if (!str) return null;
    const d = new Date(str + 'T00:00:00');
    return isNaN(d) ? null : d;
  }

  function toDateStr(d) {
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  /** Returns floor(end - start) in whole days. */
  function daysBetween(a, b) {
    return Math.floor((b - a) / 86400000);
  }

  function forEachDay(start, end, fn) {
    let cur = new Date(start);
    let i = 0;
    while (cur <= end) {
      fn(new Date(cur), i);
      cur.setDate(cur.getDate() + 1);
      i++;
    }
  }

  function getWeekNumber(d) {
    const jan1 = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  }

  function formatDay(d) {
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // =========================================================================
  // Helpers – Visible entries
  // =========================================================================

  function visibleEntries() {
    return S().ganttEntries.filter(e => e.parent_id === currentParentId);
  }

  function getDepth(entry) {
    // Depth within the current sub-chart view is always 0 at root of view
    return 0;
  }

  function autoSetChartRange(entries) {
    // If user has set explicit range, respect it
    const inputStart = document.getElementById('chartStartDate').value;
    const inputEnd   = document.getElementById('chartEndDate').value;

    if (!chartStart || !inputStart) {
      // Auto-detect from entries
      const today = new Date(); today.setHours(0,0,0,0);
      let earliest = today, latest = new Date(today);
      latest.setDate(latest.getDate() + 90);

      entries.forEach(e => {
        const s = parseDate(e.start_date);
        const en = parseDate(e.end_date);
        if (s && s < earliest) earliest = s;
        if (en && en > latest)  latest  = en;
      });
      earliest.setDate(earliest.getDate() - 7);  // 1 week padding before
      latest.setDate(latest.getDate() + 14);      // 2 weeks padding after
      chartStart = earliest;
      chartEnd   = latest;
    }
  }

  function syncScroll() {
    // Keep intensity bar aligned with timeline horizontal scroll
    if (intensityBarWrapper) {
      intensityBarWrapper.style.marginLeft = '-' + ganttTimeline.scrollLeft + 'px';
    }
  }

  // =========================================================================
  // Entry Modals
  // =========================================================================

  function showAddEntryModal(parentId) {
    const today = toDateStr(new Date());
    const nextWeek = toDateStr(addDays(new Date(), 7));

    U().openModal('Add Gantt Entry', buildEntryFormHtml({
      title: '',
      start_date: today,
      end_date: nextWeek,
      hours_estimate: '',
      color_variation: 0,
      notes: '',
    }), async () => {
      const vals = readEntryForm();
      if (!vals.title) return alert('Title is required');
      const data = await API('POST', '/api/gantt', {
        project_id: S().currentProject.id,
        parent_id: parentId || currentParentId,
        ...vals,
      });
      S().ganttEntries.push(data.entry);
      render();
      U().closeModal();
    });
  }

  function showEditEntryModal(entry) {
    U().openModal('Edit Entry', buildEntryFormHtml(entry), async () => {
      const vals = readEntryForm();
      if (!vals.title) return alert('Title is required');
      const data = await API('PUT', `/api/gantt/${entry.id}`, vals);
      const idx = S().ganttEntries.findIndex(e => e.id === entry.id);
      if (idx !== -1) S().ganttEntries[idx] = data.entry;
      render();
      U().closeModal();
    });
  }

  function buildEntryFormHtml(entry) {
    const vars = U().generateColorVariations(S().user?.base_color || '#2196F3');
    const swatches = vars.map((c, i) =>
      `<div class="color-var-swatch${entry.color_variation === i ? ' selected' : ''}" 
            data-idx="${i}" style="background:${c}" title="Variation ${i+1}"></div>`
    ).join('');

    return `
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="feTitle" value="${U().escHtml(entry.title || '')}" placeholder="Task name">
      </div>
      <div style="display:flex;gap:12px">
        <div class="form-group" style="flex:1">
          <label>Start Date</label>
          <input type="date" id="feStart" value="${entry.start_date || ''}">
        </div>
        <div class="form-group" style="flex:1">
          <label>End Date</label>
          <input type="date" id="feEnd" value="${entry.end_date || ''}">
        </div>
      </div>
      <div class="form-group">
        <label>Hours Estimate</label>
        <input type="number" id="feHours" value="${entry.hours_estimate || ''}" min="0" step="0.5" placeholder="0">
      </div>
      <div class="form-group">
        <label>Phase / Color Variation</label>
        <div class="color-variation-picker" id="colorVarPicker">${swatches}</div>
        <input type="hidden" id="feColorVar" value="${entry.color_variation || 0}">
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea id="feNotes" placeholder="Optional notes">${U().escHtml(entry.notes || '')}</textarea>
      </div>
    `;
  }

  // Attach color variation picker after modal opens
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('color-var-swatch')) {
      document.querySelectorAll('.color-var-swatch').forEach(s => s.classList.remove('selected'));
      e.target.classList.add('selected');
      const input = document.getElementById('feColorVar');
      if (input) input.value = e.target.dataset.idx;
    }
  });

  function readEntryForm() {
    return {
      title: document.getElementById('feTitle')?.value.trim() || '',
      start_date: document.getElementById('feStart')?.value || '',
      end_date:   document.getElementById('feEnd')?.value   || '',
      hours_estimate: parseFloat(document.getElementById('feHours')?.value) || 0,
      color_variation: parseInt(document.getElementById('feColorVar')?.value) || 0,
      notes: document.getElementById('feNotes')?.value || '',
    };
  }

  // =========================================================================
  // Context Menu for entries
  // =========================================================================

  function showEntryContextMenu(x, y, entry) {
    const hasChildren = S().ganttEntries.some(e => e.parent_id === entry.id);
    U().showContextMenu(x, y, [
      { icon: '✏', label: 'Edit',             action: () => showEditEntryModal(entry) },
      { icon: '+', label: 'Add sub-task',      action: () => showAddEntryModal(entry.id) },
      hasChildren
        ? { icon: '▼', label: 'Open sub-chart', action: () => drillDown(entry) }
        : null,
      { icon: '☑', label: 'Add to Todo',      action: () => addToTodo(entry) },
      { separator: true },
      { icon: '🗑', label: 'Delete',           action: () => deleteEntry(entry), danger: true },
    ].filter(Boolean));
  }

  // =========================================================================
  // Delete entry
  // =========================================================================

  async function deleteEntry(entry) {
    if (!confirm(`Delete "${entry.title}"?`)) return;
    await API('DELETE', `/api/gantt/${entry.id}`);
    S().ganttEntries = S().ganttEntries.filter(e => e.id !== entry.id);
    S().selectedGanttIds.delete(entry.id);
    U().updateDeleteBtn();
    render();
  }

  // =========================================================================
  // Add to Todo
  // =========================================================================

  async function addToTodo(entry) {
    const todo = await API('POST', '/api/todos', {
      project_id: entry.project_id,
      gantt_entry_id: entry.id,
      title: entry.title,
      due_date: entry.end_date,
    });
    S().todos.push(todo.todo);
    window.todoModule?.render();
    // Flash feedback
    const btn = document.querySelector(`.gantt-task-row[data-id="${entry.id}"] .gantt-task-action-btn[title="Add to Todo"]`);
    if (btn) { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '☑'; }, 1500); }
  }

})();
