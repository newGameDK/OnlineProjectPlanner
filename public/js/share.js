'use strict';

// ==========================================================================
// OnlineProjectPlanner – Shared / Read-Only View
//
// Renders the Gantt chart for a shared project using a public token.
// No authentication required. No editing capabilities.
// ==========================================================================

// ─── Color helpers (mirrored from app.js) ────────────────────────────────
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
function generateColorVariations(hex) {
  const [r, g, b] = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  const lightnesses = [0.85, 0.75, 0.65, 0.55, 0.45, hsl[2], 0.35, 0.28, 0.22, 0.15];
  return lightnesses.map(l => hslToHex(hsl[0], hsl[1], Math.max(0.1, Math.min(0.95, l))));
}
function getUserColor(userId, variation, members) {
  const member = members.find(m => m.id === userId);
  const base   = member?.base_color || '#2196F3';
  const vars   = generateColorVariations(base);
  return vars[Math.min(variation || 0, vars.length - 1)];
}
function lightenColor(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToHex(h, s, Math.min(0.92, l + amount));
}

// ─── Date helpers ─────────────────────────────────────────────────────────
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

// ─── Application state ────────────────────────────────────────────────────
const S = {
  entries:      [],
  todos:        [],
  dependencies: [],
  members:      [],
  project:      null,
};

// Chart state
const ROW_H    = 40;
const MIN_DAYS = 1;
let scale      = 'week';
let pxPerDay   = 28;
let chartStart = null;
let chartEnd   = null;
let parentStack     = [];
let currentParentId = null;
let rowIndexMap     = {};

// DOM references
let ganttTaskList, ganttRows, ganttRuler, ganttBreadcrumb,
    ganttTimeline, intensityBarCanvas, intensityBarWrapper, ganttHoursPanel;

// ─── Bootstrap ────────────────────────────────────────────────────────────
async function init() {
  const params = new URLSearchParams(location.search);
  const token  = params.get('token');

  if (!token) {
    showError('No share token', 'A share token is required in the URL (?token=…).');
    return;
  }

  try {
    const res  = await fetch(apiUrl('/api/share/' + encodeURIComponent(token)), { credentials: 'include' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showError('Link not found', err.error || 'This share link is invalid or has been revoked.');
      return;
    }
    const data = await res.json();
    S.project      = data.project;
    S.entries      = data.entries      || [];
    S.todos        = data.todos        || [];
    S.dependencies = data.dependencies || [];
    S.members      = data.members      || [];

    document.title = S.project.name + ' – ProjectPlanner (View Only)';
    document.getElementById('shareProjectName').textContent = S.project.name;

  } catch (e) {
    showError('Could not load plan', 'Network error: ' + e.message);
    return;
  }

  // Show UI
  document.getElementById('shareLoading').style.display  = 'none';
  document.getElementById('shareToolbar').style.display  = '';
  document.getElementById('shareGanttPanel').style.display = '';

  // Bind DOM
  ganttTaskList       = document.getElementById('ganttTaskList');
  ganttRows           = document.getElementById('ganttRows');
  ganttRuler          = document.getElementById('ganttRuler');
  ganttBreadcrumb     = document.getElementById('ganttBreadcrumb');
  ganttTimeline       = document.getElementById('ganttTimeline');
  intensityBarCanvas  = document.getElementById('intensityBarCanvas');
  intensityBarWrapper = document.getElementById('intensityBarWrapper');
  ganttHoursPanel     = document.getElementById('ganttHoursPanel');

  // Controls
  document.getElementById('shareViewScale').addEventListener('change', (e) => {
    scale = e.target.value;
    applyScaleDefaults();
    render();
  });
  document.getElementById('shareZoomIn').addEventListener('click', () => {
    pxPerDay = Math.min(pxPerDay * 1.4, 200); render();
  });
  document.getElementById('shareZoomOut').addEventListener('click', () => {
    pxPerDay = Math.max(pxPerDay / 1.4, 4); render();
  });
  document.getElementById('shareStartDate').addEventListener('change', (e) => {
    if (e.target.value) chartStart = new Date(e.target.value + 'T00:00:00');
    render();
  });
  document.getElementById('shareEndDate').addEventListener('change', (e) => {
    if (e.target.value) chartEnd = new Date(e.target.value + 'T00:00:00');
    render();
  });

  // Sync vertical scroll between task list and hours panel
  ganttTaskList.addEventListener('scroll', () => { ganttHoursPanel.scrollTop = ganttTaskList.scrollTop; });
  ganttHoursPanel.addEventListener('scroll', () => { ganttTaskList.scrollTop = ganttHoursPanel.scrollTop; });
  ganttTimeline.addEventListener('scroll', syncIntensityScroll);

  applyScaleDefaults();
  render();
}

function showError(title, msg) {
  document.getElementById('shareLoading').style.display = 'none';
  document.getElementById('shareError').style.display   = '';
  document.getElementById('shareErrorTitle').textContent = title;
  document.getElementById('shareErrorMsg').textContent   = msg;
}

function applyScaleDefaults() {
  if (scale === 'day')   pxPerDay = Math.max(pxPerDay, 40);
  if (scale === 'week')  pxPerDay = 28;
  if (scale === 'month') pxPerDay = 10;
}

// ─── Main render ──────────────────────────────────────────────────────────
function render() {
  const entries   = visibleEntries();
  autoSetChartRange(entries);

  const totalDays = Math.max(1, daysBetween(chartStart, chartEnd));
  const timelineW = totalDays * pxPerDay;

  document.getElementById('shareStartDate').value = toDateStr(chartStart);
  document.getElementById('shareEndDate').value   = toDateStr(chartEnd);

  rowIndexMap = {};
  entries.forEach((e, i) => { rowIndexMap[e.id] = i; });

  // Map same-row entries to their target's row index
  S.entries.forEach(e => {
    if (e.same_row && rowIndexMap[e.same_row] !== undefined) {
      rowIndexMap[e.id] = rowIndexMap[e.same_row];
    }
  });

  renderTaskList(entries);
  renderRuler(timelineW, totalDays);
  renderRowsAndBars(entries, timelineW);
  renderDependencyArrows(entries);
  renderIntensityBar(timelineW, totalDays);
  renderHoursPanel(entries);
  renderBreadcrumb();
}

// ─── Task list (left column) ──────────────────────────────────────────────
function renderTaskList(entries) {
  ganttTaskList.innerHTML = '';
  entries.forEach(entry => {
    const hasChildren = S.entries.some(e => e.parent_id === entry.id);
    const baseColor = getUserColor(entry.user_id, entry.color_variation, S.members);
    const depth = entry._depth || 0;
    const color = depth > 0 ? lightenColor(baseColor, depth * 0.15) : baseColor;

    const row = document.createElement('div');
    row.className  = 'gantt-task-row';
    row.dataset.id = entry.id;

    // Expand indicator
    const exp = document.createElement('span');
    if (hasChildren) {
      exp.className   = 'gantt-task-expand';
      exp.textContent = '\u25B6';
      exp.title       = 'Double-click bar to open sub-chart';
    } else {
      exp.style.cssText = 'width:16px;display:inline-block;flex-shrink:0';
    }
    row.appendChild(exp);

    // Color dot
    const dot = document.createElement('span');
    dot.className        = 'gantt-task-color-dot';
    dot.style.background = color;
    row.appendChild(dot);

    // Name
    const name = document.createElement('span');
    name.className   = 'gantt-task-name';
    name.textContent = entry.title;
    name.title       = entry.title;
    row.appendChild(name);

    // Folder link (read-only)
    if (entry.folder_url) {
      const fl = document.createElement('a');
      fl.className   = 'gantt-folder-link';
      fl.href        = entry.folder_url;
      fl.target      = '_blank';
      fl.rel         = 'noopener noreferrer';
      fl.title       = 'Open folder';
      fl.textContent = '\uD83D\uDCC2';
      fl.addEventListener('click', e => e.stopPropagation());
      row.appendChild(fl);
    }

    ganttTaskList.appendChild(row);
  });
}

// ─── Ruler ────────────────────────────────────────────────────────────────
function renderRuler(timelineW, totalDays) {
  ganttRuler.style.width    = timelineW + 'px';
  ganttRuler.style.position = 'relative';
  ganttRuler.innerHTML      = '';

  const today = new Date(); today.setHours(0, 0, 0, 0);

  if (scale === 'day') {
    forEachDay(chartStart, chartEnd, (d, i) => {
      ganttRuler.appendChild(makeRulerCell(
        i * pxPerDay, pxPerDay,
        d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
        d.getDay() === 1 ? 'major' : ''
      ));
    });
  } else if (scale === 'week') {
    forEachDay(chartStart, chartEnd, (d, i) => {
      if (d.getDay() === 1 || i === 0) {
        ganttRuler.appendChild(makeRulerCell(
          i * pxPerDay, 7 * pxPerDay,
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
      ganttRuler.appendChild(makeRulerCell(
        offset * pxPerDay, dim * pxPerDay,
        cur.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        'major'
      ));
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
  }

  // Today marker
  if (today >= chartStart && today <= chartEnd) {
    const line = document.createElement('div');
    line.className  = 'gantt-ruler-today';
    line.style.left = (daysBetween(chartStart, today) * pxPerDay) + 'px';
    ganttRuler.appendChild(line);
  }
}

function makeRulerCell(left, width, label, cls) {
  const d = document.createElement('div');
  d.className    = 'gantt-ruler-cell ' + (cls || '');
  d.style.cssText = 'left:' + left + 'px;width:' + width + 'px;min-width:' + width + 'px;';
  d.textContent  = label;
  return d;
}

// ─── Rows & bars ──────────────────────────────────────────────────────────
function renderRowsAndBars(entries, timelineW) {
  ganttRows.style.width = timelineW + 'px';
  ganttRows.innerHTML   = '';

  entries.forEach(entry => {
    const rowBg = document.createElement('div');
    rowBg.className    = 'gantt-row-bg';
    rowBg.style.height = ROW_H + 'px';
    rowBg.dataset.id   = entry.id;
    rowBg.addEventListener('dblclick', () => drillDown(entry));

    const bar = buildBar(entry);
    if (bar) rowBg.appendChild(bar);

    // Also render bars for entries that share this row (same_row === entry.id)
    const sameRowEntries = S.entries.filter(e => e.same_row === entry.id);
    sameRowEntries.forEach(srEntry => {
      const srBar = buildBar(srEntry);
      if (srBar) rowBg.appendChild(srBar);
    });

    ganttRows.appendChild(rowBg);
  });
}

function buildBar(entry) {
  const start = parseDate(entry.start_date);
  const end   = parseDate(entry.end_date);
  if (!start || !end || start > chartEnd || end < chartStart) return null;

  const leftDays  = Math.max(0, daysBetween(chartStart, start));
  const widthDays = Math.max(MIN_DAYS, daysBetween(start, end));
  const left      = leftDays  * pxPerDay;
  const width     = widthDays * pxPerDay;

  const baseColor   = getUserColor(entry.user_id, entry.color_variation, S.members);
  const depth       = entry._depth || 0;
  const color       = depth > 0 ? lightenColor(baseColor, depth * 0.15) : baseColor;
  const hasChildren = S.entries.some(e => e.parent_id === entry.id);

  const container = document.createElement('div');
  container.className     = 'gantt-bar-container';
  container.style.cssText = 'left:' + left + 'px;width:' + width + 'px;';

  const bar = document.createElement('div');
  bar.className        = 'gantt-bar';
  bar.style.background = color;
  bar.style.width      = '100%';
  bar.title = entry.title + '\n' + entry.start_date + ' \u2192 ' + entry.end_date +
              (entry.hours_estimate ? '\n' + entry.hours_estimate + 'h estimated' : '');

  const label = document.createElement('span');
  label.className   = 'gantt-bar-label';
  label.textContent = entry.title;
  bar.appendChild(label);

  if (entry.folder_url) {
    const fl = document.createElement('a');
    fl.className   = 'gantt-bar-folder-btn';
    fl.href        = entry.folder_url;
    fl.target      = '_blank';
    fl.rel         = 'noopener noreferrer';
    fl.title       = 'Open folder';
    fl.textContent = '\uD83D\uDCC2';
    fl.addEventListener('click',     e => e.stopPropagation());
    fl.addEventListener('mousedown', e => e.stopPropagation());
    bar.appendChild(fl);
  }

  if (hasChildren) {
    const ind = document.createElement('span');
    ind.className   = 'has-children-indicator';
    ind.textContent = '\u25BC';
    bar.appendChild(ind);
  }

  bar.addEventListener('dblclick', (e) => { e.stopPropagation(); drillDown(entry); });

  container.appendChild(bar);
  return container;
}

// ─── Dependency arrows (read-only, no delete) ─────────────────────────────
function ensureDepSvg() {
  let svg = document.getElementById('depArrowsSvg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'depArrowsSvg';
    svg.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;z-index:8;pointer-events:none';
    ganttRows.style.position = 'relative';
    ganttRows.appendChild(svg);
  }
  return svg;
}

function renderDependencyArrows(entries) {
  const svg = ensureDepSvg();
  Array.from(svg.querySelectorAll('.dep-arrow, defs')).forEach(el => el.remove());

  const defs   = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
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

  (S.dependencies || []).forEach(dep => {
    const srcIdx = rowIndexMap[dep.source_id];
    const tgtIdx = rowIndexMap[dep.target_id];
    if (srcIdx === undefined || tgtIdx === undefined) return;

    // Look up the actual entry by ID (entries[idx] would be the row owner
    // for same-row entries, giving wrong dates / positions).
    const srcEntry = S.entries.find(e => e.id === dep.source_id) || entries[srcIdx];
    const tgtEntry = S.entries.find(e => e.id === dep.target_id) || entries[tgtIdx];
    if (!srcEntry || !tgtEntry) return;

    const x1 = Math.max(0, daysBetween(chartStart, parseDate(srcEntry.end_date)))   * pxPerDay;
    const x2 = Math.max(0, daysBetween(chartStart, parseDate(tgtEntry.start_date))) * pxPerDay;
    const y1  = srcIdx * ROW_H + ROW_H / 2;
    const y2  = tgtIdx * ROW_H + ROW_H / 2;

    const dx  = Math.abs(x2 - x1);
    const cpx = Math.max(dx * 0.5, 30);
    const d   = 'M ' + x1 + ' ' + y1 +
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
    path.title = srcEntry.title + ' \u2192 ' + tgtEntry.title;
    svg.appendChild(path);
  });
}

// ─── Hours panel ──────────────────────────────────────────────────────────
function renderHoursPanel(entries) {
  if (!ganttHoursPanel) return;
  ganttHoursPanel.innerHTML = '';

  entries.forEach(entry => {
    const total = calcTotalHours(entry.id);
    const row   = document.createElement('div');
    row.className = 'gantt-hours-row' + (total > 0 ? ' has-hours' : '');
    row.textContent = total > 0 ? fmtH(total) : '\u2014';
    row.title = total > 0 ? fmtH(total) + ' total (incl. sub-tasks)' : 'No hours estimated';
    ganttHoursPanel.appendChild(row);
  });

  const header = document.getElementById('ganttHoursHeader');
  if (header) {
    const t = entries.reduce((sum, e) => sum + calcViewTotal(e.id), 0);
    header.textContent = t > 0 ? fmtH(t) : 'Total h';
  }
}

function calcTotalHours(entryId) {
  const entry = S.entries.find(e => e.id === entryId);
  if (!entry) return 0;
  const children = S.entries.filter(e => e.parent_id === entryId);
  if (children.length === 0) return entry.hours_estimate || 0;
  let childSum = 0;
  children.forEach(c => { childSum += calcTotalHours(c.id); });
  const own = entry.hours_estimate || 0;
  if (own > 0) return Math.max(0, own - childSum);
  return childSum;
}

/**
 * Total hours for an entire tree (parent budget or child sum, whichever is
 * larger). Used for the header total so the number reflects the full project
 * scope instead of only the remaining budget.  When a parent has no budget
 * (hours_estimate is 0 or null) the child sum is returned.
 */
function calcTreeTotal(entryId) {
  const entry = S.entries.find(e => e.id === entryId);
  if (!entry) return 0;
  const children = S.entries.filter(e => e.parent_id === entryId);
  if (children.length === 0) return entry.hours_estimate || 0;
  let childSum = 0;
  children.forEach(c => { childSum += calcTreeTotal(c.id); });
  return Math.max(entry.hours_estimate || 0, childSum);
}

/**
 * Like calcTreeTotal but also includes orphaned same-row entries.
 * When a subtask is shared onto its parent's row, parent_id is cleared.
 * This re-attributes those entries through the same_row link so the header
 * total correctly reflects all hours.
 */
function calcViewTotal(entryId) {
  const entry = S.entries.find(e => e.id === entryId);
  if (!entry) return 0;
  const children = S.entries.filter(e => e.parent_id === entryId);
  const sameRowOrphans = S.entries.filter(e =>
    e.same_row === entryId && e.parent_id !== entryId &&
    (!e.parent_id || e.parent_id === currentParentId)
  );
  const allChildren = children.concat(sameRowOrphans);
  if (allChildren.length === 0) return entry.hours_estimate || 0;
  let childSum = 0;
  allChildren.forEach(c => { childSum += calcViewTotal(c.id); });
  return Math.max(entry.hours_estimate || 0, childSum);
}

function fmtH(h) { return Number.isInteger(h) ? h + 'h' : h.toFixed(1) + 'h'; }

// ─── Intensity bar ────────────────────────────────────────────────────────
function renderIntensityBar(timelineW, totalDays) {
  const canvas   = intensityBarCanvas;
  const H        = 32;
  canvas.width   = timelineW;
  canvas.height  = H;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, timelineW, H);

  const periodDays     = scale === 'day' ? 1 : scale === 'week' ? 7 : 30;
  const capacity       = 160; // default capacity (no team info in share view)
  const hoursPerPeriod = capacity * (periodDays / 30);

  const hoursPerDay = new Float64Array(totalDays + 1);
  const parentIdsSet = new Set();
  S.entries.forEach(e => { if (e.parent_id) parentIdsSet.add(e.parent_id); });

  S.entries.forEach(entry => {
    if (!entry.hours_estimate) return;
    const isParent = parentIdsSet.has(entry.id);
    let h;
    if (isParent) {
      h = calcTotalHours(entry.id);
      if (h <= 0) return;
    } else {
      h = entry.hours_estimate;
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

    if (hours <= 0) { ps += periodDays; continue; }

    const ratio = Math.min(hours / Math.max(hoursPerPeriod, 0.1), 2);
    const r     = Math.round(Math.min(255, ratio * 255));
    const g     = Math.round(Math.max(0, 255 - ratio * 255));
    const a     = 0.15 + Math.min(ratio, 1) * 0.7;

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
  if (intensityBarCanvas) {
    intensityBarCanvas.style.marginLeft = '-' + ganttTimeline.scrollLeft + 'px';
  }
}

// ─── Breadcrumb ───────────────────────────────────────────────────────────
function renderBreadcrumb() {
  ganttBreadcrumb.innerHTML = '';
  if (!parentStack.length) return;

  const root = document.createElement('span');
  root.className   = 'gantt-bc-item';
  root.textContent = S.project?.name || 'Project';
  root.addEventListener('click', () => { parentStack = []; currentParentId = null; render(); });
  ganttBreadcrumb.appendChild(root);

  parentStack.forEach((crumb, i) => {
    const sep = document.createElement('span');
    sep.className   = 'gantt-bc-sep';
    sep.textContent = ' \u203A ';
    ganttBreadcrumb.appendChild(sep);

    if (i < parentStack.length - 1) {
      const item = document.createElement('span');
      item.className   = 'gantt-bc-item';
      item.textContent = crumb.label;
      item.addEventListener('click', () => {
        parentStack     = parentStack.slice(0, i + 1);
        currentParentId = crumb.entry.id;
        render();
      });
      ganttBreadcrumb.appendChild(item);
    } else {
      const cur = document.createElement('span');
      cur.className   = 'gantt-bc-current';
      cur.textContent = crumb.label;
      ganttBreadcrumb.appendChild(cur);
    }
  });
}

// ─── Sub-chart drill-down ─────────────────────────────────────────────────
function drillDown(entry) {
  parentStack.push({ entry, label: entry.title });
  currentParentId = entry.id;
  render();
}

// ─── Visible entries & auto chart range ──────────────────────────────────
function visibleEntries() {
  return S.entries.filter(e => e.parent_id === currentParentId && !e.same_row);
}

function autoSetChartRange(entries) {
  const inputStart = document.getElementById('shareStartDate').value;
  if (chartStart && inputStart) return;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let earliest = new Date(today), latest = new Date(today);
  latest.setDate(latest.getDate() + 90);

  entries.forEach(e => {
    const s  = parseDate(e.start_date);
    const en = parseDate(e.end_date);
    if (s  && s  < earliest) earliest = s;
    if (en && en > latest)   latest   = en;
  });
  earliest.setDate(earliest.getDate() - 7);
  latest.setDate(latest.getDate() + 14);
  chartStart = earliest;
  chartEnd   = latest;
}

// ─── Start ────────────────────────────────────────────────────────────────
init();
