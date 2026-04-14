'use strict';

// ==========================================================================
// OnlineProjectPlanner – Export (Excel / PDF)
// Depends on: lib/exceljs.min.js, config.js, color-utils.js (isColorDark),
//             app.js (window.appState, window.appUtils)
// Loaded after app.js.
// ==========================================================================

(function () {

const S = () => window.appState;
const U = () => window.appUtils;

// ==========================================================================
// Export: Excel (XLSX) with visual Gantt chart
// ==========================================================================

async function exportCSV() {
  if (!S().currentProject) return alert('Open a project first.');
  if (typeof ExcelJS === 'undefined') return alert('ExcelJS library not loaded. Check your internet connection.');

  const members = Object.values(S().members).flat();
  const titleById = {};
  S().ganttEntries.forEach(e => { titleById[e.id] = e.title; });

  // Use only currently visible (expanded) entries so collapsed / drilled-past
  // tasks are not exported as "dead" rows.
  const visEntries = window.ganttModule.getExportableEntries();
  if (!visEntries.length) return alert('No entries to export.');
  const flatRows = visEntries.map(e => ({ entry: e, depth: e._depth || 0 }));

  // Determine chart date range
  let earliest = null, latest = null;
  flatRows.forEach(({ entry }) => {
    const s = new Date(entry.start_date + 'T00:00:00');
    const e = new Date(entry.end_date   + 'T00:00:00');
    if (!earliest || s < earliest) earliest = s;
    if (!latest   || e > latest)   latest   = e;
  });
  // Add one-day padding on each side
  earliest.setDate(earliest.getDate() - 1);
  latest.setDate(latest.getDate() + 1);

  const totalDays = Math.round((latest - earliest) / 86400000);

  // Choose time-column granularity based on total span so bars are wide enough
  // to show their title text: day (<= 90 d), week (<= 365 d), month (> 365 d).
  const granularity = totalDays > 365 ? 'month' : (totalDays > 90 ? 'week' : 'day');

  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Build time-column descriptors  { date: Date (period start), label: string }
  const timeCols = [];
  if (granularity === 'day') {
    const cur = new Date(earliest);
    while (cur <= latest) {
      timeCols.push({
        date:  new Date(cur),
        label: String(cur.getDate()).padStart(2, '0') + '/' + String(cur.getMonth() + 1).padStart(2, '0'),
      });
      cur.setDate(cur.getDate() + 1);
    }
  } else if (granularity === 'week') {
    // Snap back to the Monday on or before earliest
    const cur = new Date(earliest);
    const dow = cur.getDay(); // 0=Sun
    cur.setDate(cur.getDate() - (dow === 0 ? 6 : dow - 1));
    while (cur <= latest) {
      timeCols.push({
        date:  new Date(cur),
        label: String(cur.getDate()).padStart(2, '0') + ' ' + MONTH_NAMES[cur.getMonth()],
      });
      cur.setDate(cur.getDate() + 7);
    }
  } else { // month
    const cur = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
    while (cur <= latest) {
      timeCols.push({
        date:  new Date(cur),
        label: MONTH_NAMES[cur.getMonth()] + ' \'' + String(cur.getFullYear()).slice(2),
      });
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  // Build dependency index: targetId → [sourceTitle, ...]
  const deps = S().dependencies || [];
  const depsOfEntry = {};
  deps.forEach(d => {
    if (!depsOfEntry[d.target_id]) depsOfEntry[d.target_id] = [];
    depsOfEntry[d.target_id].push(d.source_id);
  });

  // Find which time-column index contains a given date
  function timeColOf(dateObj) {
    if (granularity === 'day') {
      for (let i = 0; i < timeCols.length; i++) {
        if (timeCols[i].date.toDateString() === dateObj.toDateString()) return i;
      }
    } else if (granularity === 'week') {
      for (let i = 0; i < timeCols.length; i++) {
        const wEnd = new Date(timeCols[i].date);
        wEnd.setDate(wEnd.getDate() + 6);
        if (dateObj >= timeCols[i].date && dateObj <= wEnd) return i;
      }
    } else { // month
      for (let i = 0; i < timeCols.length; i++) {
        if (timeCols[i].date.getFullYear() === dateObj.getFullYear() &&
            timeCols[i].date.getMonth()    === dateObj.getMonth()) return i;
      }
    }
    return -1;
  }

  const DATA_COLS       = 7; // Title, Parent, Start, End, Hours, Assignee, Depends On
  const CHART_START_COL = DATA_COLS + 1; // 1-indexed
  // Bar-column widths by granularity – narrow enough to show many columns but
  // wide enough that merged bar cells can display title text.
  const DAY_COL_WIDTH   = 3.5;
  const WEEK_COL_WIDTH  = 8;
  const MONTH_COL_WIDTH = 13;

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Gantt Chart');

  // ── Header row ─────────────────────────────────────────────────────────────
  const headerRow = ['Title', 'Parent', 'Start Date', 'End Date', 'Hours', 'Assignee', 'Depends On'];
  timeCols.forEach(tc => headerRow.push(tc.label));
  ws.addRow(headerRow);

  const hRow = ws.getRow(1);
  hRow.font      = { bold: true, size: 10 };
  hRow.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  hRow.height    = 28;
  for (let c = 1; c <= headerRow.length; c++) {
    const cell = hRow.getCell(c);
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } };
    cell.font   = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
  }

  // ── Column widths ───────────────────────────────────────────────────────────
  ws.getColumn(1).width = 30; // Title
  ws.getColumn(2).width = 18; // Parent
  ws.getColumn(3).width = 12; // Start
  ws.getColumn(4).width = 12; // End
  ws.getColumn(5).width =  8; // Hours
  ws.getColumn(6).width = 14; // Assignee
  ws.getColumn(7).width = 22; // Depends On
  const barColWidth = granularity === 'day' ? DAY_COL_WIDTH : (granularity === 'week' ? WEEK_COL_WIDTH : MONTH_COL_WIDTH);
  for (let i = 0; i < timeCols.length; i++) {
    ws.getColumn(CHART_START_COL + i).width = barColWidth;
  }

  // ── Data rows ───────────────────────────────────────────────────────────────
  flatRows.forEach(({ entry, depth }) => {
    const member      = members.find(m => m.id === entry.user_id);
    const parentTitle = entry.parent_id ? (titleById[entry.parent_id] || '') : '';
    const indent      = depth > 0 ? '  '.repeat(depth) : '';
    const dependsOn   = (depsOfEntry[entry.id] || [])
                          .map(sid => titleById[sid] || sid)
                          .join(', ');

    const rowData = [
      indent + entry.title,
      parentTitle,
      entry.start_date,
      entry.end_date,
      entry.hours_estimate || 0,
      member ? member.username : '',
      dependsOn,
    ];
    timeCols.forEach(() => rowData.push(''));

    ws.addRow(rowData);
    const rowNum  = ws.rowCount;
    const excelRow = ws.getRow(rowNum);
    excelRow.height = 22;

    // Title-cell font
    excelRow.getCell(1).font = depth === 0
      ? { bold: true, size: 10 }
      : { size: 10, italic: depth > 1 };

    // Wrap long "Depends On" text so multiple dependency names are fully visible
    excelRow.getCell(7).alignment = { wrapText: true, vertical: 'middle' };

    // ── Gantt bar ─────────────────────────────────────────────────────────────
    const startDate   = new Date(entry.start_date + 'T00:00:00');
    const endDate     = new Date(entry.end_date   + 'T00:00:00');
    const startColIdx = timeColOf(startDate);
    const endColIdx   = timeColOf(endDate);

    if (startColIdx >= 0 && endColIdx >= 0) {
      const color     = U().getUserColor(entry.user_id, entry.color_variation);
      const argbColor = 'FF' + color.replace('#', '');
      const fontColor = isColorDark(color) ? 'FFFFFFFF' : 'FF000000';

      const colA = CHART_START_COL + startColIdx;
      const colB = CHART_START_COL + endColIdx;

      // Merge the bar cells so the title can span the full bar width
      if (colB > colA) {
        ws.mergeCells(rowNum, colA, rowNum, colB);
      }

      const barCell = ws.getRow(rowNum).getCell(colA);
      barCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: argbColor } };
      barCell.value     = entry.title;
      barCell.font      = { size: 9, bold: depth === 0, color: { argb: fontColor } };
      barCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
    }

    // Notes as Excel cell comment
    if (entry.notes) {
      excelRow.getCell(1).note = entry.notes;
    }

    // Alternating row background for the data columns
    if (rowNum % 2 === 0) {
      for (let c = 1; c <= DATA_COLS; c++) {
        const cell = excelRow.getCell(c);
        if (!cell.fill || cell.fill.pattern === 'none') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
        }
      }
    }
  });

  // ── Borders on data columns ─────────────────────────────────────────────────
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= DATA_COLS; c++) {
      row.getCell(c).border = {
        right:  c === DATA_COLS
          ? { style: 'medium', color: { argb: 'FF000000' } }
          : { style: 'thin',   color: { argb: 'FFE0E0E0' } },
        bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
      };
    }
  }

  // Freeze panes: header row + data columns
  ws.views = [{ state: 'frozen', xSplit: DATA_COLS, ySplit: 1 }];

  // ── Generate and download ──────────────────────────────────────────────────
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (S().currentProject.name || 'project').replace(/[^a-z0-9_\-]/gi, '_') + '.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ==========================================================================
// Export: PDF via browser print (A4, multi-page)
// ==========================================================================

/**
 * Expand row heights and add callout annotations for narrow bars to improve
 * print readability. Wide bars (>= CALLOUT_W px) get text-wrapping enabled;
 * narrow bars get a labelled callout with a dashed connecting line.
 * Expanded heights are synced to taskListEl and hoursPanelEl if provided.
 *
 * Returns a cleanup function (call it after print when working on the live DOM).
 * When working on clones the return value can be ignored.
 *
 * @param {Element}      timelineEl  – .gantt-timeline element
 * @param {Element|null} taskListEl  – .gantt-tasks element (optional)
 * @param {Element|null} hoursPanelEl – .gantt-hours-panel element (optional)
 */
function injectPrintAnnotations(timelineEl, taskListEl, hoursPanelEl) {
  const DEFAULT_H   = 40;          // default row height (ROW_H in gantt.js)
  const MAX_H       = DEFAULT_H * 3; // cap at 3× default for readability
  const CALLOUT_W   = 50;          // bars narrower than this get a callout
  const CHAR_W      = 7;           // approx px per character at 11 px font
  const LINE_H      = 14;          // approx line-height inside a bar
  const BAR_PAD_V   = 8;           // top + bottom padding inside the bar
  const CALLOUT_H   = 18;          // height of each callout label row
  const CALLOUT_GAP = 4;           // gap between bar bottom and first callout

  // Saved state for live-DOM cleanup
  const savedRowH  = []; // { el, v }
  const savedTaskH = []; // { el, mh, h }
  const savedHrH   = []; // { el, h }
  const savedBarH  = []; // { el, h }
  const addedTalls = []; // .gantt-bar elements that got gantt-bar-tall for print

  const rowBgs   = Array.from(timelineEl.querySelectorAll('.gantt-row-bg'));
  const taskRows = taskListEl  ? Array.from(taskListEl.querySelectorAll('.gantt-task-row'))   : [];
  const hrRows   = hoursPanelEl ? Array.from(hoursPanelEl.querySelectorAll('.gantt-hours-row')) : [];

  rowBgs.forEach((rowBg, rowIdx) => {
    const bars = Array.from(rowBg.querySelectorAll('.gantt-bar-container'));
    if (!bars.length) return;

    const origRowH = parseFloat(rowBg.style.height) || DEFAULT_H;
    let newRowH = origRowH;

    // ── Wide bars: expand bar to show wrapped text ─────────────────────────
    bars.forEach(bc => {
      const bw = parseFloat(bc.style.width) || 0;
      if (bw < CALLOUT_W) return;

      const bar = bc.querySelector('.gantt-bar');
      const lbl = bc.querySelector('.gantt-bar-label');
      if (!bar || !lbl) return;

      const title = lbl.textContent.trim();
      if (!title) return;

      const charsPerLine = Math.max(1, Math.floor((bw - 12) / CHAR_W));
      const linesNeeded  = Math.ceil(title.length / charsPerLine);
      const neededBarH   = Math.max(20, linesNeeded * LINE_H + BAR_PAD_V);
      const barTopPx     = parseFloat(bc.style.top) || 4;
      const neededRowH   = Math.min(MAX_H, neededBarH + barTopPx * 2);

      if (neededRowH > newRowH) newRowH = neededRowH;

      const origBarH = parseFloat(bc.style.height) || (origRowH - barTopPx * 2);
      if (neededBarH > origBarH) {
        savedBarH.push({ el: bc, h: bc.style.height });
        bc.style.height = neededBarH + 'px';

        if (!bar.classList.contains('gantt-bar-tall')) {
          bar.classList.add('gantt-bar-tall');
          bar.dataset.printTall = '1';
          addedTalls.push(bar);
        }
        bar.classList.remove('gantt-bar-hide-label');
        lbl.style.whiteSpace   = 'normal';
        lbl.style.wordBreak    = 'break-word';
        lbl.style.overflow     = 'visible';
        lbl.style.textOverflow = 'clip';
      }
    });

    // ── Narrow bars: callout labels with dashed connecting lines ───────────
    const narrowBars = bars.filter(bc => (parseFloat(bc.style.width) || 0) < CALLOUT_W);
    if (narrowBars.length) {
      const calloutStart = origRowH + CALLOUT_GAP;
      const extraNeeded  = narrowBars.length * (CALLOUT_H + 2);
      newRowH = Math.min(MAX_H, Math.max(newRowH, calloutStart + extraNeeded));

      // SVG overlay for the connecting lines
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'print-callout-svg');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText =
        'position:absolute;left:0;top:0;width:100%;pointer-events:none;z-index:8;overflow:visible;';
      svg.style.height = newRowH + 'px';
      rowBg.appendChild(svg);

      let cy = calloutStart;
      narrowBars.forEach(bc => {
        if (cy + CALLOUT_H > newRowH) return; // no room left

        const barLeft = parseFloat(bc.style.left) || 0;
        const barW    = parseFloat(bc.style.width) || 4;
        const barTopV = parseFloat(bc.style.top)   || 4;
        const barH    = parseFloat(bc.style.height) || (origRowH - 8);
        const barMidX = barLeft + barW / 2;
        const barBotY = barTopV + barH;

        const lbl   = bc.querySelector('.gantt-bar-label');
        const title = lbl ? lbl.textContent.trim() : '';
        if (!title) { cy += CALLOUT_H + 2; return; }

        // Callout label
        const callout = document.createElement('div');
        callout.className = 'print-bar-callout';
        callout.textContent = title;
        callout.style.cssText =
          `position:absolute;left:${barMidX}px;top:${cy}px;height:${CALLOUT_H}px;`;
        rowBg.appendChild(callout);

        // Dashed connecting line from bar bottom to callout
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', barMidX);
        line.setAttribute('y1', barBotY);
        line.setAttribute('x2', barMidX);
        line.setAttribute('y2', cy);
        line.setAttribute('stroke', '#666');
        line.setAttribute('stroke-width', '1');
        line.setAttribute('stroke-dasharray', '3,2');
        svg.appendChild(line);

        cy += CALLOUT_H + 2;
      });
    }

    // Apply expanded row height and sync sibling panels
    if (newRowH !== origRowH) {
      savedRowH.push({ el: rowBg, v: rowBg.style.height });
      rowBg.style.height = newRowH + 'px';

      const taskRow = taskRows[rowIdx];
      if (taskRow) {
        savedTaskH.push({ el: taskRow, mh: taskRow.style.minHeight, h: taskRow.style.height });
        taskRow.style.minHeight = newRowH + 'px';
        taskRow.style.height    = newRowH + 'px';
      }

      const hrRow = hrRows[rowIdx];
      if (hrRow) {
        savedHrH.push({ el: hrRow, h: hrRow.style.height });
        hrRow.style.height = newRowH + 'px';
      }
    }
  });

  // Return cleanup function (used when working on the live DOM)
  return function cleanupPrintAnnotations() {
    timelineEl.querySelectorAll('.print-bar-callout, .print-callout-svg')
      .forEach(el => el.remove());
    savedBarH.forEach(({ el, h })       => { el.style.height = h; });
    savedRowH.forEach(({ el, v })       => { el.style.height = v; });
    savedTaskH.forEach(({ el, mh, h }) => { el.style.minHeight = mh; el.style.height = h; });
    savedHrH.forEach(({ el, h })        => { el.style.height = h; });
    addedTalls.forEach(bar => {
      bar.classList.remove('gantt-bar-tall');
      delete bar.dataset.printTall;
      const lbl = bar.querySelector('.gantt-bar-label');
      if (lbl) {
        lbl.style.whiteSpace   = '';
        lbl.style.wordBreak    = '';
        lbl.style.overflow     = '';
        lbl.style.textOverflow = '';
      }
    });
  };
}

/**
 * Recompute dependency arrow geometry for print/export DOMs after row heights
 * are changed (for wrapped labels/callouts). Returns a cleanup function that
 * restores original attributes/styles when called.
 *
 * @param {Element} timelineEl – .gantt-timeline element
 */
function realignDependencyArrowsForPrint(timelineEl) {
  const svg = timelineEl ? timelineEl.querySelector('#depArrowsSvg') : null;
  if (!svg) return function noop() {};

  const deps = S().dependencies || [];
  if (!deps.length) return function noop() {};

  const depPaths = Array.from(svg.querySelectorAll('path.dep-arrow'));
  const hitPaths = Array.from(svg.querySelectorAll('path.dep-arrow-hit'));
  const delBtns  = Array.from(svg.querySelectorAll('.dep-delete-btn'));

  const saved = [];
  const saveAttr = (el, attr) => saved.push({ t: 'a', el, attr, v: el.getAttribute(attr) });
  const saveStyle = (el, prop) => saved.push({ t: 's', el, prop, v: el.style[prop] });

  // Hide interactive dependency helpers in print output.
  hitPaths.forEach(el => {
    saveStyle(el, 'display');
    el.style.display = 'none';
  });
  delBtns.forEach(el => {
    saveStyle(el, 'display');
    el.style.display = 'none';
  });

  const rowsEl = timelineEl.querySelector('.gantt-timeline-rows');
  if (rowsEl) {
    saveStyle(svg, 'width');
    saveStyle(svg, 'height');
    svg.style.width = rowsEl.scrollWidth + 'px';
    svg.style.height = rowsEl.scrollHeight + 'px';
  }

  const MIN_BEZIER_CP = 24;
  const barById = new Map();
  const getBar = (id) => {
    if (barById.has(id)) return barById.get(id);
    const bar = timelineEl.querySelector('.gantt-bar-container[data-id="' + String(id) + '"]');
    barById.set(id, bar || null);
    return bar || null;
  };

  let depPathIndex = 0;
  deps.forEach(dep => {
    const srcBar = getBar(dep.source_id);
    const tgtBar = getBar(dep.target_id);
    if (!srcBar || !tgtBar) return;

    const srcRow = srcBar.closest('.gantt-row-bg');
    const tgtRow = tgtBar.closest('.gantt-row-bg');
    if (!srcRow || !tgtRow) return;

    const srcLeft = parseFloat(srcBar.style.left) || 0;
    const srcW    = parseFloat(srcBar.style.width) || srcBar.offsetWidth || 0;
    const srcTop  = parseFloat(srcBar.style.top) || 0;
    const srcH    = parseFloat(srcBar.style.height) || srcBar.offsetHeight || 0;

    const tgtLeft = parseFloat(tgtBar.style.left) || 0;
    const tgtTop  = parseFloat(tgtBar.style.top) || 0;
    const tgtH    = parseFloat(tgtBar.style.height) || tgtBar.offsetHeight || 0;

    const x1 = srcLeft + srcW;
    const x2 = tgtLeft;
    const y1 = srcRow.offsetTop + srcTop + (srcH / 2);
    const y2 = tgtRow.offsetTop + tgtTop + (tgtH / 2);

    const dx = Math.abs(x2 - x1);
    const cpx = Math.max(dx * 0.25, MIN_BEZIER_CP);
    const d = 'M ' + x1 + ' ' + y1 +
              ' C ' + (x1 + cpx) + ' ' + y1 + ',' +
              (x2 - cpx) + ' ' + y2 + ',' +
              x2 + ' ' + y2;

    const depPath = depPaths[depPathIndex];
    const hitPath = hitPaths[depPathIndex];
    const delBtn  = delBtns[depPathIndex];

    if (depPath) {
      saveAttr(depPath, 'd');
      depPath.setAttribute('d', d);
    }
    if (hitPath) {
      saveAttr(hitPath, 'd');
      hitPath.setAttribute('d', d);
    }
    if (delBtn) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      saveAttr(delBtn, 'transform');
      delBtn.setAttribute('transform', 'translate(' + mx + ',' + my + ')');
    }
    depPathIndex++;
  });

  return function cleanupDepPrintRealign() {
    for (let i = saved.length - 1; i >= 0; i--) {
      const s = saved[i];
      if (s.t === 'a') {
        if (s.v === null) s.el.removeAttribute(s.attr);
        else s.el.setAttribute(s.attr, s.v);
      } else {
        s.el.style[s.prop] = s.v;
      }
    }
  };
}

function exportPDF() {
  if (!S().currentProject) return alert('Open a project first.');

  const ganttContainer  = document.getElementById('ganttContainer');
  const ganttTimeline   = document.getElementById('ganttTimeline');
  const ganttRulerRow   = ganttContainer ? ganttContainer.querySelector('.gantt-ruler-row') : null;
  const ganttTaskList   = document.getElementById('ganttTaskList');
  const ganttHoursPanel = document.getElementById('ganttHoursPanel');
  const ganttBody       = document.getElementById('ganttBody');
  const intensityBar    = document.getElementById('intensityBarContainer');
  const depsWereHidden  = ganttTimeline ? ganttTimeline.classList.contains('deps-hidden') : false;

  const removeIdAttribute = (root) => {
    if (!root) return;
    if (root.removeAttribute) root.removeAttribute('id');
  };

  // Temporarily remove overflow restrictions so we can measure full dimensions
  const ids = ['ganttTimeline', 'ganttTaskList', 'ganttHoursPanel'];
  const saved = ids.map(id => {
    const el = document.getElementById(id);
    if (!el) return null;
    const s = { el, overflow: el.style.overflow, height: el.style.height, maxHeight: el.style.maxHeight };
    el.style.overflow  = 'visible';
    el.style.height    = 'auto';
    el.style.maxHeight = 'none';
    return s;
  }).filter(Boolean);

  const savedBodyOverflow = ganttBody ? ganttBody.style.overflow : '';
  if (ganttBody) ganttBody.style.overflow = 'visible';
  if (ganttTimeline && depsWereHidden) ganttTimeline.classList.remove('deps-hidden');

  document.body.classList.add('print-gantt');

  // --- Measure content dimensions ---
  const timelineTotalW = ganttTimeline.scrollWidth;
  const taskListW      = Math.round(ganttTaskList.offsetWidth);
  const hoursW         = ganttHoursPanel ? Math.round(ganttHoursPanel.offsetWidth) : 0;

  // A4 landscape usable width: 297mm − 2×8mm margins = 281mm
  // Convert mm → px: mm × 96 (CSS reference DPI) / 25.4 (mm per inch)
  const PAGE_W = Math.round(281 * 96 / 25.4);
  const timelinePerPage = PAGE_W - taskListW - hoursW;
  const OVERLAP_PX = Math.round(10 * 96 / 25.4); // 1 cm
  const step = Math.max(1, timelinePerPage - OVERLAP_PX);

  const numPages = timelineTotalW > timelinePerPage
    ? Math.max(1, Math.ceil((timelineTotalW - OVERLAP_PX) / step))
    : 1;

  // --- Shared cleanup helper ---
  let wrapper = null;
  const cleanup = () => {
    document.body.classList.remove('print-gantt');
    saved.forEach(s => {
      s.el.style.overflow  = s.overflow;
      s.el.style.height    = s.height;
      s.el.style.maxHeight = s.maxHeight;
    });
    if (ganttBody) ganttBody.style.overflow = savedBodyOverflow;
    if (ganttTimeline && depsWereHidden) ganttTimeline.classList.add('deps-hidden');
    if (wrapper) {
      wrapper.remove();
      ganttContainer.style.display = '';
    }
  };

  if (numPages <= 1) {
    // Single page – inject print annotations then print
    const restoreAnnotations = injectPrintAnnotations(ganttTimeline, ganttTaskList, ganttHoursPanel);
    const restoreDepArrows   = realignDependencyArrowsForPrint(ganttTimeline);
    const afterPrint = () => {
      restoreDepArrows();
      restoreAnnotations();
      cleanup();
      window.removeEventListener('afterprint', afterPrint);
    };
    window.addEventListener('afterprint', afterPrint);
    window.print();
    return;
  }

  // --- Multi-page: build horizontally-tiled print pages ---
  wrapper = document.createElement('div');
  wrapper.className = 'print-multi-wrapper';

  // Snapshot the intensity bar canvas to an image (cloneNode does not copy canvas pixels)
  let canvasDataUrl = null;
  const origCanvas = intensityBar ? intensityBar.querySelector('canvas') : null;
  if (origCanvas) {
    try { canvasDataUrl = origCanvas.toDataURL(); } catch (_) { /* tainted canvas, skip */ }
  }

  for (let p = 0; p < numPages; p++) {
    const offset = p * step;

    const page = document.createElement('div');
    page.className = 'print-page-section';
    page.style.width = PAGE_W + 'px';
    page.style.maxWidth = PAGE_W + 'px';

    // Page label
    const label = document.createElement('div');
    label.className = 'print-page-label';
    label.textContent = 'Page ' + (p + 1) + ' / ' + numPages;
    page.appendChild(label);

    // --- Intensity bar clone ---
    if (intensityBar) {
      const iClone = intensityBar.cloneNode(true);
      removeIdAttribute(iClone);
      iClone.style.width = PAGE_W + 'px';
      // Replace cloned canvas with image snapshot
      if (canvasDataUrl) {
        const clonedCanvas = iClone.querySelector('canvas');
        if (clonedCanvas) {
          const img = document.createElement('img');
          img.src = canvasDataUrl;
          img.style.display = 'block';
          img.style.maxWidth = 'none';
          img.style.marginLeft = (-offset) + 'px';
          clonedCanvas.parentNode.replaceChild(img, clonedCanvas);
        }
      }
      const taskHeader = iClone.querySelector('.gantt-tasks-header');
      if (taskHeader) {
        taskHeader.style.width = taskListW + 'px';
        taskHeader.style.minWidth = taskListW + 'px';
        taskHeader.style.flex = 'none';
      }
      const tlHeader = iClone.querySelector('.gantt-timeline-header');
      if (tlHeader) {
        tlHeader.style.overflow = 'hidden';
        tlHeader.style.width = timelinePerPage + 'px';
        tlHeader.style.minWidth = timelinePerPage + 'px';
        tlHeader.style.flex = 'none';
      }
      const hoursHeader = iClone.querySelector('#ganttHoursHeader, .gantt-hours-header');
      if (hoursHeader) {
        hoursHeader.style.width = hoursW + 'px';
        hoursHeader.style.minWidth = hoursW + 'px';
        hoursHeader.style.flex = 'none';
      }
      page.appendChild(iClone);
    }

    // --- Ruler row clone ---
    if (ganttRulerRow) {
      const rulerC = ganttRulerRow.cloneNode(true);
      removeIdAttribute(rulerC);
      rulerC.style.width = PAGE_W + 'px';

      const taskSpacer = rulerC.querySelector('.gantt-ruler-task-spacer');
      if (taskSpacer) {
        taskSpacer.style.width = taskListW + 'px';
        taskSpacer.style.minWidth = taskListW + 'px';
        taskSpacer.style.flex = 'none';
      }

      const rulerClip = rulerC.querySelector('.gantt-ruler-clip');
      if (rulerClip) {
        rulerClip.style.width = timelinePerPage + 'px';
        rulerClip.style.minWidth = timelinePerPage + 'px';
        rulerClip.style.flex = 'none';
        rulerClip.style.overflow = 'hidden';
      }

      const ruler = rulerC.querySelector('.gantt-timeline-ruler');
      if (ruler) {
        ruler.style.width = timelineTotalW + 'px';
        ruler.style.minWidth = timelineTotalW + 'px';
        ruler.style.marginLeft = (-offset) + 'px';
      }

      const hoursSpacer = rulerC.querySelector('.gantt-ruler-hours-spacer');
      if (hoursSpacer) {
        hoursSpacer.style.width = hoursW + 'px';
        hoursSpacer.style.minWidth = hoursW + 'px';
        hoursSpacer.style.flex = 'none';
      }

      page.appendChild(rulerC);
    }

    // --- Gantt body row ---
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.overflow = 'hidden';
    row.style.width = PAGE_W + 'px';

    // Create all three panel clones before injecting annotations so heights
    // can be synchronised across panels in one pass.
    const taskC = ganttTaskList.cloneNode(true);
    removeIdAttribute(taskC);
    taskC.style.width = taskListW + 'px';
    taskC.style.minWidth = taskListW + 'px';
    taskC.style.flex = 'none';
    taskC.style.overflow = 'visible';

    const tlC = ganttTimeline.cloneNode(true);
    removeIdAttribute(tlC);
    tlC.style.overflow = 'visible';
    tlC.style.width = timelineTotalW + 'px';
    tlC.style.minWidth = timelineTotalW + 'px';
    tlC.style.flex = 'none';
    tlC.style.marginLeft = (-offset) + 'px';
    if (depsWereHidden) tlC.classList.remove('deps-hidden');

    let hpC = null;
    if (ganttHoursPanel) {
      hpC = ganttHoursPanel.cloneNode(true);
      removeIdAttribute(hpC);
      hpC.style.width = hoursW + 'px';
      hpC.style.minWidth = hoursW + 'px';
      hpC.style.flex = 'none';
      hpC.style.overflow = 'visible';
    }

    // Inject print annotations (expands rows, adds callouts) on the clones.
    // No cleanup needed – clones are discarded after printing.
    injectPrintAnnotations(tlC, taskC, hpC);
    realignDependencyArrowsForPrint(tlC);

    row.appendChild(taskC);

    // Timeline viewport (clips to one page-width)
    const vp = document.createElement('div');
    vp.style.width = timelinePerPage + 'px';
    vp.style.overflow = 'hidden';
    vp.style.flexShrink = '0';
    vp.style.position = 'relative';

    vp.appendChild(tlC);

    // Overlap alignment marks (dashed lines)
    if (p > 0) {
      const mark = document.createElement('div');
      mark.className = 'print-overlap-mark';
      mark.style.left = OVERLAP_PX + 'px';
      const scissors = document.createElement('span');
      scissors.textContent = '✂';
      mark.appendChild(scissors);
      vp.appendChild(mark);
    }
    if (p < numPages - 1) {
      const mark = document.createElement('div');
      mark.className = 'print-overlap-mark';
      mark.style.right = OVERLAP_PX + 'px';
      mark.style.left = 'auto';
      const scissors = document.createElement('span');
      scissors.textContent = '✂';
      mark.appendChild(scissors);
      vp.appendChild(mark);
    }

    row.appendChild(vp);

    // Hours panel
    if (hpC) {
      row.appendChild(hpC);
    }

    page.appendChild(row);
    wrapper.appendChild(page);
  }

  // Hide original gantt, insert print pages
  ganttContainer.style.display = 'none';
  ganttContainer.parentNode.insertBefore(wrapper, ganttContainer);

  const afterPrint = () => { cleanup(); window.removeEventListener('afterprint', afterPrint); };
  window.addEventListener('afterprint', afterPrint);
  window.print();
}

// Expose public API so app.js can call these functions directly.
window.exportCSV = exportCSV;
window.exportPDF = exportPDF;

})();
