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

function exportPDF() {
  if (!S().currentProject) return alert('Open a project first.');

  const ganttContainer  = document.getElementById('ganttContainer');
  const ganttTimeline   = document.getElementById('ganttTimeline');
  const ganttTaskList   = document.getElementById('ganttTaskList');
  const ganttHoursPanel = document.getElementById('ganttHoursPanel');
  const ganttBody       = document.getElementById('ganttBody');
  const intensityBar    = document.getElementById('intensityBarContainer');

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

  document.body.classList.add('print-gantt');

  // --- Measure content dimensions ---
  const timelineTotalW = ganttTimeline.scrollWidth;
  const taskListW      = ganttTaskList.offsetWidth;
  const hoursW         = ganttHoursPanel ? ganttHoursPanel.offsetWidth : 0;

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
    if (wrapper) {
      wrapper.remove();
      ganttContainer.style.display = '';
    }
  };

  if (numPages <= 1) {
    // Single page – just print as before
    const afterPrint = () => { cleanup(); window.removeEventListener('afterprint', afterPrint); };
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

    // Page label
    const label = document.createElement('div');
    label.className = 'print-page-label';
    label.textContent = 'Page ' + (p + 1) + ' / ' + numPages;
    page.appendChild(label);

    // --- Intensity bar clone ---
    if (intensityBar) {
      const iClone = intensityBar.cloneNode(true);
      iClone.removeAttribute('id');
      // Replace cloned canvas with image snapshot
      if (canvasDataUrl) {
        const clonedCanvas = iClone.querySelector('canvas');
        if (clonedCanvas) {
          const img = document.createElement('img');
          img.src = canvasDataUrl;
          img.style.display = 'block';
          img.style.marginLeft = (-offset) + 'px';
          clonedCanvas.parentNode.replaceChild(img, clonedCanvas);
        }
      }
      const tlHeader = iClone.querySelector('.gantt-timeline-header');
      if (tlHeader) {
        tlHeader.style.overflow = 'hidden';
        tlHeader.style.width = timelinePerPage + 'px';
        tlHeader.style.flex = 'none';
      }
      page.appendChild(iClone);
    }

    // --- Gantt body row ---
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.overflow = 'hidden';

    // Task list
    const taskC = ganttTaskList.cloneNode(true);
    taskC.removeAttribute('id');
    row.appendChild(taskC);

    // Timeline viewport (clips to one page-width)
    const vp = document.createElement('div');
    vp.style.width = timelinePerPage + 'px';
    vp.style.overflow = 'hidden';
    vp.style.flexShrink = '0';
    vp.style.position = 'relative';

    const tlC = ganttTimeline.cloneNode(true);
    tlC.removeAttribute('id');
    tlC.style.overflow = 'visible';
    tlC.style.marginLeft = (-offset) + 'px';
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
    if (ganttHoursPanel) {
      const hpC = ganttHoursPanel.cloneNode(true);
      hpC.removeAttribute('id');
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
