'use strict';

// ==========================================================================
// OnlineProjectPlanner – Export (Excel / PDF)
// Depends on: lib/exceljs.min.js, config.js, color-utils.js (isColorDark),
//             app.js (window.appState, window.appUtils)
// Loaded after app.js.
// ==========================================================================

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

  // Build a flat list with hierarchy: parents first, then children indented below
  const flatRows = [];
  function collectEntries(parentId, depth) {
    const children = S().ganttEntries.filter(e => (e.parent_id || null) === parentId);
    children.forEach(e => {
      flatRows.push({ entry: e, depth });
      collectEntries(e.id, depth + 1);
    });
  }
  collectEntries(null, 0);

  if (!flatRows.length) return alert('No entries to export.');

  // Determine chart date range
  let earliest = null, latest = null;
  flatRows.forEach(({ entry }) => {
    const s = new Date(entry.start_date + 'T00:00:00');
    const e = new Date(entry.end_date + 'T00:00:00');
    if (!earliest || s < earliest) earliest = s;
    if (!latest || e > latest) latest = e;
  });
  // Add padding
  earliest.setDate(earliest.getDate() - 1);
  latest.setDate(latest.getDate() + 1);

  // Generate date columns
  const dateCols = [];
  const cur = new Date(earliest);
  while (cur <= latest) {
    dateCols.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }

  const DATA_COLS = 6; // Title, Parent, Start, End, Hours, Assignee
  const CHART_START_COL = DATA_COLS + 1; // 1-indexed

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Gantt Chart');

  // --- Header Row ---
  const headerRow = ['Title', 'Parent', 'Start Date', 'End Date', 'Hours', 'Assignee'];
  dateCols.forEach(d => {
    const dayStr = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
    headerRow.push(dayStr);
  });
  ws.addRow(headerRow);

  // Style header
  const hRow = ws.getRow(1);
  hRow.font = { bold: true, size: 10 };
  hRow.alignment = { horizontal: 'center', vertical: 'middle' };
  hRow.height = 22;
  for (let c = 1; c <= headerRow.length; c++) {
    const cell = hRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } };
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
  }

  // Set column widths
  ws.getColumn(1).width = 30; // Title
  ws.getColumn(2).width = 18; // Parent
  ws.getColumn(3).width = 12; // Start
  ws.getColumn(4).width = 12; // End
  ws.getColumn(5).width = 8;  // Hours
  ws.getColumn(6).width = 14; // Assignee
  for (let i = 0; i < dateCols.length; i++) {
    ws.getColumn(CHART_START_COL + i).width = 3.5;
  }

  // --- Data Rows with Gantt bars ---
  flatRows.forEach(({ entry, depth }) => {
    const member = members.find(m => m.id === entry.user_id);
    const parentTitle = entry.parent_id ? (titleById[entry.parent_id] || '') : '';
    const indent = depth > 0 ? '  '.repeat(depth) : '';

    const rowData = [
      indent + entry.title,
      parentTitle,
      entry.start_date,
      entry.end_date,
      entry.hours_estimate || 0,
      member ? member.username : '',
    ];

    // Fill date columns with empty strings
    dateCols.forEach(() => rowData.push(''));

    ws.addRow(rowData);
    const excelRow = ws.getRow(ws.rowCount);
    excelRow.height = 20;

    // Get bar color
    const color = U().getUserColor(entry.user_id, entry.color_variation);
    const argbColor = 'FF' + color.replace('#', '');
    const fontColor = isColorDark(color) ? 'FFFFFFFF' : 'FF000000';

    // Style depth with indentation and font
    if (depth > 0) {
      excelRow.getCell(1).font = { size: 10, italic: depth > 1 };
    } else {
      excelRow.getCell(1).font = { bold: true, size: 10 };
    }

    // Color the Gantt bar cells
    const startDate = new Date(entry.start_date + 'T00:00:00');
    const endDate = new Date(entry.end_date + 'T00:00:00');

    dateCols.forEach((d, i) => {
      const colIdx = CHART_START_COL + i;
      const cell = excelRow.getCell(colIdx);

      if (d >= startDate && d <= endDate) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argbColor } };
        // Show title on the first day of the bar
        if (d.getTime() === startDate.getTime()) {
          cell.value = entry.title;
          cell.font = { size: 8, color: { argb: fontColor } };
        }
      }
    });

    // Add notes as comment on title cell if present
    if (entry.notes) {
      excelRow.getCell(1).note = entry.notes;
    }

    // Light alternating row background for data columns
    if (ws.rowCount % 2 === 0) {
      for (let c = 1; c <= DATA_COLS; c++) {
        const cell = excelRow.getCell(c);
        if (!cell.fill || !cell.fill.fgColor) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
        }
      }
    }
  });

  // Add borders to data section
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= DATA_COLS; c++) {
      row.getCell(c).border = {
        right: c === DATA_COLS ? { style: 'medium', color: { argb: 'FF000000' } } : { style: 'thin', color: { argb: 'FFE0E0E0' } },
        bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
      };
    }
  }

  // Freeze panes: freeze header row and data columns
  ws.views = [{ state: 'frozen', xSplit: DATA_COLS, ySplit: 1 }];

  // --- Generate and download ---
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
