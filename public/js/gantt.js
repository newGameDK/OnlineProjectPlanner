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

  // ─── state refs (injected from app.js) ───────────────────────────────────
  const S   = () => window.appState;
  const API = (m, u, b) => window.appAPI(m, u, b);
  const U   = () => window.appUtils;

  // ─── module state ─────────────────────────────────────────────────────────
  let parentStack     = [];   // breadcrumb: [{entry, label}, …]
  let currentParentId = null;
  let expandedIds     = new Set(); // inline-expanded entries (show children)

  let scale    = 'week';
  let pxPerDay = 28;
  let chartStart = null;
  let chartEnd   = null;

  // rowIndexMap: entryId -> rowIndex (rebuilt on each render)
  let rowIndexMap = {};

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
  };

  // ── connecting state ──────────────────────────────────────────────────────
  const conn = {
    active: false,
    sourceId: null,
    tempLine: null,     // SVG <line> for rubber-band
  };

  // ── reparent drag state ────────────────────────────────────────────────────
  const reparentDrag = {
    active: false,
    entryId: null,
    startY: 0,
    dragEl: null,       // floating ghost element
  };

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  let ganttTaskList, ganttRows, ganttRuler, ganttBreadcrumb,
      ganttTimeline, intensityBarCanvas, intensityBarWrapper, ganttHoursPanel;

  // =========================================================================
  // Public API
  // =========================================================================
  window.ganttModule = { init, render, showAddEntryModal };

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

    document.getElementById('viewScale').addEventListener('change', (e) => {
      scale = e.target.value;
      applyScaleDefaults();
      render();
    });
    document.getElementById('zoomInBtn').addEventListener('click', () => {
      pxPerDay = Math.min(pxPerDay * 1.4, 200); render();
    });
    document.getElementById('zoomOutBtn').addEventListener('click', () => {
      pxPerDay = Math.max(pxPerDay / 1.4, 4); render();
    });
    document.getElementById('chartStartDate').addEventListener('change', (e) => {
      if (e.target.value) chartStart = new Date(e.target.value + 'T00:00:00');
      render();
    });
    document.getElementById('chartEndDate').addEventListener('change', (e) => {
      if (e.target.value) chartEnd = new Date(e.target.value + 'T00:00:00');
      render();
    });

    // Sync task-list and hours-panel vertical scroll together
    ganttTaskList.addEventListener('scroll', () => {
      ganttHoursPanel.scrollTop = ganttTaskList.scrollTop;
    });
    ganttHoursPanel.addEventListener('scroll', () => {
      ganttTaskList.scrollTop = ganttHoursPanel.scrollTop;
    });

    ganttTimeline.addEventListener('scroll', syncIntensityScroll);

    // Scroll-wheel zoom on the ruler / timeline / intensity bar
    const wheelZoom = (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        pxPerDay = Math.min(pxPerDay * 1.4, 200);
      } else {
        pxPerDay = Math.max(pxPerDay / 1.4, 4);
      }
      render();
    };
    ganttTimeline.addEventListener('wheel', wheelZoom, { passive: false });
    if (ganttRuler) ganttRuler.addEventListener('wheel', wheelZoom, { passive: false });
    if (intensityBarWrapper) intensityBarWrapper.addEventListener('wheel', wheelZoom, { passive: false });

    // Global mouse/key events
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && conn.active) cancelConnecting();
    });

    const cancelBtn = document.getElementById('cancelConnecting');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelConnecting);

    // ── Help mode toggle ───────────────────────────────────────────────────
    const helpBtn = document.getElementById('helpModeBtn');
    if (helpBtn) {
      helpBtn.addEventListener('click', () => {
        document.body.classList.toggle('help-mode');
        helpBtn.classList.toggle('active');
      });
    }

    parentStack     = [];
    currentParentId = null;
    chartStart      = null;
    chartEnd        = null;

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
      const color = U().getUserColor(entry.user_id, entry.color_variation);

      const row = document.createElement('div');
      row.className = 'gantt-task-row' + (S().selectedGanttIds.has(entry.id) ? ' selected' : '');
      row.dataset.id = entry.id;

      // Drag handle for reparenting
      const grip = document.createElement('span');
      grip.className = 'gantt-task-grip';
      grip.textContent = '\u2261';  // ≡
      grip.title = 'Drag to move under another task';
      grip.setAttribute('aria-label', 'Drag to move under another task');
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startReparentDrag(e, entry, row);
      });
      row.appendChild(grip);

      // Indent placeholder
      const depth = entry._depth || 0;
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
        folderLink.href      = entry.folder_url;
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
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
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

  // ─── reparent drag-and-drop ────────────────────────────────────────────────
  function startReparentDrag(e, entry, rowEl) {
    reparentDrag.active  = true;
    reparentDrag.entryId = entry.id;
    reparentDrag.startY  = e.clientY;

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

  function onReparentMove(e) {
    if (!reparentDrag.active) return;

    // Move ghost
    reparentDrag.dragEl.style.top = (e.clientY - ROW_H / 2) + 'px';

    // Highlight drop target
    const rows = ganttTaskList.querySelectorAll('.gantt-task-row');
    rows.forEach(r => r.classList.remove('reparent-target', 'reparent-root-target'));
    ganttTaskList.classList.remove('reparent-root-target');

    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target) return;
    const targetRow = target.closest('.gantt-task-row');
    if (targetRow && targetRow.dataset.id !== reparentDrag.entryId) {
      targetRow.classList.add('reparent-target');
    } else if (ganttTaskList.contains(target) && !targetRow) {
      // Hovering over task list but not on a row — show root drop indicator
      ganttTaskList.classList.add('reparent-root-target');
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

    const rows = ganttTaskList.querySelectorAll('.gantt-task-row');
    rows.forEach(r => r.classList.remove('reparent-target', 'reparent-root-target'));
    ganttTaskList.classList.remove('reparent-root-target');

    const entryId = reparentDrag.entryId;
    reparentDrag.active  = false;
    reparentDrag.entryId = null;

    // Determine drop target
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target) return;
    const targetRow = target.closest('.gantt-task-row');

    let newParentId;
    if (targetRow && targetRow.dataset.id !== entryId) {
      newParentId = targetRow.dataset.id;
    } else if (ganttTaskList.contains(target) && !targetRow) {
      // Dropped in blank area of task list — make root-level (under currentParentId)
      newParentId = currentParentId || null;
    } else {
      return; // dropped on self or outside
    }

    // Check we're actually changing the parent
    const entry = S().ganttEntries.find(x => x.id === entryId);
    if (!entry) return;
    if (entry.parent_id === newParentId) return;

    // Prevent dropping onto own descendant (circular) – build child map once
    if (newParentId) {
      const childrenOf = {};
      S().ganttEntries.forEach(e => {
        const pid = e.parent_id || '__root__';
        if (!childrenOf[pid]) childrenOf[pid] = [];
        childrenOf[pid].push(e);
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
    }

    try {
      const updated = await API('PUT', '/api/gantt/' + entryId, {
        parent_id: newParentId,
      });
      const idx = S().ganttEntries.findIndex(x => x.id === entryId);
      if (idx !== -1) S().ganttEntries[idx] = updated.entry;

      // Auto-expand the new parent so the moved entry is visible
      if (newParentId && newParentId !== currentParentId) {
        expandedIds.add(newParentId);
      }
    } catch (err) {
      console.error('Reparent failed:', err);
    }
    render();
  }

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

      const bar = buildBar(entry);
      if (bar) rowBg.appendChild(bar);
      ganttRows.appendChild(rowBg);
    });
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

    const color       = U().getUserColor(entry.user_id, entry.color_variation);
    const hasChildren = S().ganttEntries.some(e => e.parent_id === entry.id);
    const isSelected  = S().selectedGanttIds.has(entry.id);
    const deps        = S().dependencies || [];
    const hasDepsIn   = deps.some(d => d.target_id === entry.id);
    const hasDepsOut  = deps.some(d => d.source_id === entry.id);

    const container = document.createElement('div');
    container.className     = 'gantt-bar-container';
    container.style.cssText = 'left:' + left + 'px;width:' + width + 'px;';
    container.dataset.id    = entry.id;

    const bar = document.createElement('div');
    bar.className        = 'gantt-bar' + (isSelected ? ' selected' : '');
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

    // Folder link icon on the bar (only when URL is set)
    if (entry.folder_url) {
      const folderBtn = document.createElement('a');
      folderBtn.className = 'gantt-bar-folder-btn';
      folderBtn.href      = entry.folder_url;
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
      if (e.target === hLeft || e.target === hRight ||
          e.target === inputNode || e.target === outputNode ||
          e.target === barIndicator) return;
      e.preventDefault();
      startDrag(e, 'move', entry, bar, container);
    });

    bar.addEventListener('dblclick', (e) => { e.stopPropagation(); drillDown(entry); });
    bar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showEntryContextMenu(e.pageX, e.pageY, entry);
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

    barEl.style.opacity    = '0.75';
    barEl.style.cursor     = type === 'move' ? 'grabbing' : 'col-resize';
    document.body.style.cursor    = type === 'move' ? 'grabbing' : 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function onMouseMove(e) {
    // ── drag live preview ──────────────────────────────────────────────────
    if (drag.active) {
      const deltaX    = e.pageX - drag.startX;
      const deltaDays = Math.round(deltaX / pxPerDay);
      if (deltaDays !== drag.snappedDays) {
        drag.snappedDays = deltaDays;
        const { newStart, newEnd } = calcDragDates(deltaDays);
        updateBarVisual(drag.containerEl, newStart, newEnd);
        if (drag.ghostEl) drag.ghostEl.title = newStart + ' \u2192 ' + newEnd;
      }
    }

    // ── rubber-band connecting line ────────────────────────────────────────
    if (conn.active && conn.tempLine) {
      const svgEl = document.getElementById('depArrowsSvg');
      if (!svgEl) return;
      const rect       = ganttRows.getBoundingClientRect();
      const scrollLeft = ganttTimeline.scrollLeft;
      const scrollTop  = ganttTimeline.scrollTop;
      const mx = e.clientX - rect.left  + scrollLeft;
      const my = e.clientY - rect.top   + scrollTop;
      conn.tempLine.setAttribute('x2', mx);
      conn.tempLine.setAttribute('y2', my);
    }
  }

  async function onMouseUp(e) {
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

    if (deltaDays !== 0) {
      try {
        const updated = await API('PUT', '/api/gantt/' + entryId, {
          start_date: newStart, end_date: newEnd,
        });
        const idx = S().ganttEntries.findIndex(x => x.id === entryId);
        if (idx !== -1) {
          S().ganttEntries[idx] = updated.entry;
          await expandParentDates(updated.entry);
        }
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

    // Source point: right edge of bar at row vertical centre
    const rowIdx = rowIndexMap[entry.id] !== undefined ? rowIndexMap[entry.id] : 0;
    const endDate = parseDate(entry.end_date);
    const sx = Math.max(0, daysBetween(chartStart, endDate)) * pxPerDay;
    const sy = rowIdx * ROW_H + ROW_H / 2;

    // Create SVG rubber-band line
    const svgEl = ensureDepSvg();
    const line  = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', sx); line.setAttribute('y1', sy);
    line.setAttribute('x2', sx); line.setAttribute('y2', sy);
    line.setAttribute('stroke', 'rgba(46,125,50,0.85)');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-dasharray', '6 3');
    line.setAttribute('marker-end', 'url(#depArrow)');
    svgEl.appendChild(line);
    conn.tempLine = line;

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

      // Bezier curve between output and input
      const dx   = Math.abs(x2 - x1);
      const cpx  = Math.max(dx * 0.5, 30);
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
      hitArea.title = srcEntry.title + ' \u2192 ' + tgtEntry.title + '\nClick to delete dependency';

      const onArrowClick = (e) => {
        e.stopPropagation();
        if (confirm('Remove dependency: "' + srcEntry.title + '" \u2192 "' + tgtEntry.title + '"?')) {
          deleteDependency(dep.id);
        }
      };
      hitArea.addEventListener('click', onArrowClick);
      path.addEventListener('click', onArrowClick);

      // Hover: highlight visible arrow when hit-area is hovered
      hitArea.addEventListener('mouseenter', () => path.classList.add('dep-arrow-hover'));
      hitArea.addEventListener('mouseleave', () => path.classList.remove('dep-arrow-hover'));

      svg.appendChild(hitArea);
      svg.appendChild(path);
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
      viewTotal += entry.hours_estimate || 0; // project total = own hours only at top level

      const row = document.createElement('div');
      row.className = 'gantt-hours-row' + (total > 0 ? ' has-hours' : '');
      if (total > capacity) row.classList.add('overloaded');
      row.textContent = total > 0 ? fmtH(total) : '\u2014';
      row.title = total > 0
        ? fmtH(total) + ' total (incl. sub-tasks)'
        : 'No hours estimated';
      ganttHoursPanel.appendChild(row);
    });

    // Update panel header with view total
    const header = document.getElementById('ganttHoursHeader');
    if (header) {
      const t = entries.reduce((sum, e) => sum + calcTotalHours(e.id), 0);
      header.textContent = t > 0 ? fmtH(t) : 'Total h';
      header.title       = t > 0 ? fmtH(t) + ' total hours in this view' : 'Total hours';
    }
  }

  /**
   * Recursively sum hours for an entry and all its descendants
   * (regardless of what sub-chart level is currently visible).
   */
  function calcTotalHours(entryId) {
    const entry = S().ganttEntries.find(e => e.id === entryId);
    if (!entry) return 0;
    let total = entry.hours_estimate || 0;
    const children = S().ganttEntries.filter(e => e.parent_id === entryId);
    let childSum = 0;
    children.forEach(child => { childSum += calcTotalHours(child.id); });
    if (entry.subtract_hours && childSum > 0) {
      total = Math.max(0, total - childSum);
    } else {
      total += childSum;
    }
    return total;
  }

  function fmtH(h) {
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
    S().ganttEntries.forEach(entry => {
      if (!entry.hours_estimate) return;
      const s  = parseDate(entry.start_date);
      const en = parseDate(entry.end_date);
      if (!s || !en) return;
      const span   = Math.max(1, daysBetween(s, en));
      const dailyH = entry.hours_estimate / span;
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

    // Subtract hours checkbox – only shown when drilled into a parent
    const parentEntry = S().ganttEntries.find(e => e.id === currentParentId);
    if (parentEntry) {
      const lbl = document.createElement('label');
      lbl.className = 'gantt-bc-subtract';
      lbl.title = 'Subtract sub-task hours from the parent task\'s hours estimate';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!parentEntry.subtract_hours;
      cb.addEventListener('change', async () => {
        try {
          const data = await API('PUT', '/api/gantt/' + parentEntry.id, { subtract_hours: cb.checked });
          const idx = S().ganttEntries.findIndex(e => e.id === parentEntry.id);
          if (idx !== -1) S().ganttEntries[idx] = data.entry;
          // Update the breadcrumb stack entry too
          const crumb = parentStack.find(c => c.entry.id === parentEntry.id);
          if (crumb) crumb.entry = data.entry;
          render();
        } catch (_) { cb.checked = !cb.checked; }
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' Subtract hours from parent'));
      ganttBreadcrumb.appendChild(lbl);
    }
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
  function showAddEntryModal(parentId) {
    const today    = toDateStr(new Date());
    const nextWeek = toDateStr(addDays(new Date(), 7));

    U().openModal('Add Gantt Entry', buildEntryFormHtml({
      title: '', start_date: today, end_date: nextWeek,
      hours_estimate: '', color_variation: 0, notes: '', folder_url: '',
    }), async () => {
      const vals = readEntryForm();
      if (!vals.title) return alert('Title is required');
      const data = await API('POST', '/api/gantt', {
        project_id: S().currentProject.id,
        parent_id: parentId !== undefined ? parentId : currentParentId,
        ...vals,
      });
      S().ganttEntries.push(data.entry);
      await expandParentDates(data.entry);
      // Auto-expand the parent so the new child is visible inline
      if (data.entry.parent_id && data.entry.parent_id !== currentParentId) {
        expandedIds.add(data.entry.parent_id);
      }
      render();
      U().closeModal();

      // If this is a subtask and the parent does not already subtract hours,
      // ask the user whether they want to enable subtraction.
      if (data.entry.parent_id) {
        const parent = S().ganttEntries.find(e => e.id === data.entry.parent_id);
        if (parent && !parent.subtract_hours && (parent.hours_estimate || 0) > 0) {
          if (confirm('Subtract this sub-task\'s hours from the parent task\'s hours?')) {
            try {
              const upd = await API('PUT', '/api/gantt/' + parent.id, { subtract_hours: true });
              const pi = S().ganttEntries.findIndex(e => e.id === parent.id);
              if (pi !== -1) S().ganttEntries[pi] = upd.entry;
              const crumb = parentStack.find(c => c.entry.id === parent.id);
              if (crumb) crumb.entry = upd.entry;
              render();
            } catch (_) { /* ignore – not critical */ }
          }
        }
      }

      // Ask if the new entry should also be added to the todo list
      if (confirm('Add "' + data.entry.title + '" to the Todo list as well?')) {
        addToTodo(data.entry);
      }
    });
  }

  function showEditEntryModal(entry) {
    U().openModal('Edit Entry', buildEntryFormHtml(entry), async () => {
      const vals = readEntryForm();
      if (!vals.title) return alert('Title is required');
      const data = await API('PUT', '/api/gantt/' + entry.id, vals);
      const idx = S().ganttEntries.findIndex(e => e.id === entry.id);
      if (idx !== -1) {
        S().ganttEntries[idx] = data.entry;
        await expandParentDates(data.entry);
      }
      render();
      U().closeModal();
    });
  }

  function buildEntryFormHtml(entry) {
    const vars = U().generateColorVariations((S().user && S().user.base_color) || '#2196F3');
    const swatches = vars.map((c, i) =>
      '<div class="color-var-swatch' + (entry.color_variation === i ? ' selected' : '') +
      '" data-idx="' + i + '" style="background:' + c + '" title="Phase ' + (i + 1) + '"></div>'
    ).join('');

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
      '</div>' +
      '<div class="form-group"><label>Phase / Colour Variation</label>' +
        '<div class="color-variation-picker" id="colorVarPicker">' + swatches + '</div>' +
        '<input type="hidden" id="feColorVar" value="' + (entry.color_variation || 0) + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Folder Link (optional)</label>' +
        '<div style="display:flex;gap:6px;align-items:center">' +
          '<input type="url" id="feFolderUrl" value="' + U().escHtml(entry.folder_url || '') + '" ' +
            'placeholder="https://…sharepoint.com/…  or any URL" style="flex:1">' +
          (entry.folder_url
            ? '<a href="' + U().escHtml(entry.folder_url) + '" target="_blank" rel="noopener" ' +
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
    return {
      title:           (document.getElementById('feTitle') && document.getElementById('feTitle').value.trim()) || '',
      start_date:      (document.getElementById('feStart') && document.getElementById('feStart').value) || '',
      end_date:        (document.getElementById('feEnd')   && document.getElementById('feEnd').value)   || '',
      hours_estimate:  parseFloat((document.getElementById('feHours') && document.getElementById('feHours').value)) || 0,
      color_variation: parseInt((document.getElementById('feColorVar') && document.getElementById('feColorVar').value)) || 0,
      notes:           (document.getElementById('feNotes') && document.getElementById('feNotes').value) || '',
      folder_url:      (document.getElementById('feFolderUrl') && document.getElementById('feFolderUrl').value.trim()) || '',
    };
  }

  // =========================================================================
  // Context Menu
  // =========================================================================
  function showEntryContextMenu(x, y, entry) {
    const hasChildren = S().ganttEntries.some(e => e.parent_id === entry.id);
    U().showContextMenu(x, y, [
      { icon: '\u270F', label: 'Edit',                 action: () => showEditEntryModal(entry) },
      { icon: '+',      label: 'Add sub-task',          action: () => showAddEntryModal(entry.id) },
      hasChildren
        ? { icon: '\u25BC', label: 'Open sub-chart',   action: () => drillDown(entry) }
        : null,
      entry.folder_url
        ? { icon: '\uD83D\uDCC2', label: 'Open folder', action: () => window.open(entry.folder_url, '_blank', 'noopener') }
        : null,
      { icon: '\uD83D\uDD17', label: 'Connect dependency', action: () => startConnecting(entry) },
      { icon: '\u2611', label: 'Add to Todo',           action: () => addToTodo(entry) },
      { separator: true },
      { icon: '\uD83D\uDDD1', label: 'Delete',          action: () => deleteEntry(entry), danger: true },
    ].filter(Boolean));
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
