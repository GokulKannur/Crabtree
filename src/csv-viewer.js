// ============================================
// CRAB TREE — CSV Viewer (Virtualized Rows)
// Investigation-grade: stats, sort, filter.
// ============================================

function parseCsvLine(line, delimiter) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function detectDelimiter(lines) {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestScore = -1;

  const probe = lines.slice(0, 20);
  for (const d of candidates) {
    let score = 0;
    for (const line of probe) {
      const cols = parseCsvLine(line, d).length;
      score += cols;
    }
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export function parseCsvContent(content, maxRows = 50000) {
  const allLines = String(content || '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  if (allLines.length === 0) {
    return {
      delimiter: ',',
      header: [],
      rows: [],
      rowCount: 0,
      colCount: 0,
      truncated: false,
    };
  }

  const delimiter = detectDelimiter(allLines);
  const header = parseCsvLine(allLines[0], delimiter);
  const rows = [];
  const cap = Math.min(maxRows, Math.max(0, allLines.length - 1));
  for (let i = 1; i <= cap; i++) {
    const row = parseCsvLine(allLines[i], delimiter);
    rows.push(row);
  }

  let colCount = header.length;
  for (const row of rows) {
    if (row.length > colCount) colCount = row.length;
  }
  if (colCount === 0) colCount = 1;

  // Normalize lengths so row rendering is consistent.
  if (header.length < colCount) {
    for (let c = header.length; c < colCount; c++) header.push(`col_${c + 1}`);
  }
  for (const row of rows) {
    if (row.length < colCount) row.length = colCount;
  }

  return {
    delimiter,
    header,
    rows,
    rowCount: allLines.length - 1,
    colCount,
    truncated: allLines.length - 1 > maxRows,
  };
}

// ─── Column Statistics ───
export function computeColumnStats(header, rows, colCount) {
  const stats = [];
  for (let c = 0; c < colCount; c++) {
    const stat = {
      name: header[c] || `col_${c + 1}`,
      totalRows: rows.length,
      nullCount: 0,
      uniqueValues: new Set(),
      numericCount: 0,
      min: null,
      max: null,
      minNum: Infinity,
      maxNum: -Infinity,
    };

    for (let r = 0; r < rows.length; r++) {
      const raw = rows[r][c];
      const val = raw === undefined || raw === null ? '' : String(raw).trim();

      if (val === '' || val.toLowerCase() === 'null' || val.toLowerCase() === 'na' || val === '-') {
        stat.nullCount++;
        continue;
      }

      stat.uniqueValues.add(val);

      const num = Number(val);
      if (val !== '' && !isNaN(num) && isFinite(num)) {
        stat.numericCount++;
        if (num < stat.minNum) stat.minNum = num;
        if (num > stat.maxNum) stat.maxNum = num;
      }

      // Track lexicographic min/max for all values
      if (stat.min === null || val < stat.min) stat.min = val;
      if (stat.max === null || val > stat.max) stat.max = val;
    }

    const nonNull = stat.totalRows - stat.nullCount;
    stat.nullPct = stat.totalRows > 0 ? ((stat.nullCount / stat.totalRows) * 100).toFixed(1) : '0.0';
    stat.cardinality = stat.uniqueValues.size;
    stat.isNumeric = stat.numericCount > nonNull * 0.5 && stat.numericCount > 0;

    // Clean up for serialization
    stat.uniqueValues = undefined;
    if (!stat.isNumeric) {
      stat.minNum = undefined;
      stat.maxNum = undefined;
    } else if (stat.minNum === Infinity) {
      stat.minNum = undefined;
      stat.maxNum = undefined;
    }

    stats.push(stat);
  }
  return stats;
}

export class CsvViewer {
  constructor(container, options = {}) {
    this.container = container;
    this.rowHeight = options.rowHeight || 28;
    this.overscan = options.overscan || 8;
    this.maxCols = options.maxCols || 40;
    this.data = null;
    this.viewport = null;
    this.rowsLayer = null;
    this.spacer = null;
    this.colCountShown = 0;
    this.totalWidth = 0;
    this.boundRender = () => this._scheduleRender();
    this._renderFrame = null;

    // Sort state
    this.sortCol = -1;      // column index, -1 = unsorted
    this.sortAsc = true;
    this.sortedIndices = null;

    // Filter state
    this.columnFilters = []; // per-column filter string
    this.filteredIndices = null;  // after filter, before sort

    // Stats
    this.columnStats = null;
    this.statsVisible = false;
  }

  render(content) {
    this.data = parseCsvContent(content);
    const shownCols = Math.min(this.data.colCount, this.maxCols);
    this.colCountShown = shownCols;
    this.totalWidth = Math.max(320, shownCols * 180);
    const gridCols = `repeat(${shownCols}, 180px)`;
    this.columnFilters = new Array(shownCols).fill('');
    this.sortCol = -1;
    this.sortAsc = true;
    this.sortedIndices = null;
    this.filteredIndices = null;

    // Compute stats eagerly (fast for 50k rows)
    this.columnStats = computeColumnStats(this.data.header, this.data.rows, shownCols);

    const displayedRows = this.data.rows.length;

    this.container.innerHTML = `
      <div class="csv-viewer">
        <div class="csv-toolbar">
          <div class="csv-toolbar-left">
            <span class="csv-pill">${this.data.rowCount} rows</span>
            <span class="csv-pill">${this.data.colCount} columns</span>
            <span class="csv-pill">delimiter: ${this.data.delimiter === '\t' ? '\\t' : this.data.delimiter}</span>
            ${this.data.truncated ? `<span class="csv-toolbar-note">previewing first ${displayedRows} rows</span>` : ''}
            ${this.data.colCount > shownCols ? `<span class="csv-toolbar-note">showing first ${shownCols} columns</span>` : ''}
          </div>
          <div class="csv-toolbar-right">
            <span class="csv-filter-count" id="csv-filter-count"></span>
            <button class="csv-toolbar-btn" id="csv-stats-toggle" title="Toggle column statistics">📊 Stats</button>
            <button class="csv-toolbar-btn" id="csv-reset-btn" title="Reset sort & filters">↺ Reset</button>
          </div>
        </div>
        <div class="csv-stats-panel hidden" id="csv-stats-panel"></div>
        <div class="csv-scroll-shell">
          <div class="csv-table" style="width:${this.totalWidth}px">
            <div class="csv-header" id="csv-header" style="grid-template-columns:${gridCols}"></div>
            <div class="csv-filter-row" id="csv-filter-row" style="grid-template-columns:${gridCols}"></div>
            <div class="csv-viewport" id="csv-viewport">
              <div class="csv-spacer" id="csv-spacer"></div>
              <div class="csv-rows-layer" id="csv-rows-layer"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Header cells with sort
    const headerEl = this.container.querySelector('#csv-header');
    for (let c = 0; c < shownCols; c++) {
      const cell = document.createElement('div');
      cell.className = 'csv-header-cell csv-sortable';
      const name = this.data.header[c] && String(this.data.header[c]).trim().length > 0
        ? this.data.header[c]
        : `col_${c + 1}`;

      const label = document.createElement('span');
      label.className = 'csv-header-label';
      label.textContent = name;
      label.title = name;

      const arrow = document.createElement('span');
      arrow.className = 'csv-sort-arrow';
      arrow.dataset.col = c;

      cell.appendChild(label);
      cell.appendChild(arrow);
      cell.addEventListener('click', () => this._onSortClick(c));
      headerEl.appendChild(cell);
    }

    // Filter row
    const filterRow = this.container.querySelector('#csv-filter-row');
    for (let c = 0; c < shownCols; c++) {
      const input = document.createElement('input');
      input.className = 'csv-filter-input';
      input.type = 'text';
      input.placeholder = 'filter…';
      input.dataset.col = c;
      input.addEventListener('input', (e) => this._onFilterInput(c, e.target.value));
      filterRow.appendChild(input);
    }

    // Stats toggle
    this.container.querySelector('#csv-stats-toggle').addEventListener('click', () => this._toggleStats());
    this.container.querySelector('#csv-reset-btn').addEventListener('click', () => this._resetAll());

    this.viewport = this.container.querySelector('#csv-viewport');
    this.rowsLayer = this.container.querySelector('#csv-rows-layer');
    this.spacer = this.container.querySelector('#csv-spacer');

    this._rebuildViewIndices();

    this.viewport.removeEventListener('scroll', this.boundRender);
    this.viewport.addEventListener('scroll', this.boundRender, { passive: true });
    this.renderRows();
  }

  // ─── Sort ───
  _onSortClick(col) {
    if (this.sortCol === col) {
      if (this.sortAsc) {
        this.sortAsc = false;
      } else {
        // Third click: clear sort
        this.sortCol = -1;
        this.sortAsc = true;
      }
    } else {
      this.sortCol = col;
      this.sortAsc = true;
    }
    this._rebuildViewIndices();
    this._updateSortArrows();
    this.renderRows();
  }

  _updateSortArrows() {
    const arrows = this.container.querySelectorAll('.csv-sort-arrow');
    arrows.forEach(a => {
      const c = parseInt(a.dataset.col);
      if (c === this.sortCol) {
        a.textContent = this.sortAsc ? ' ▲' : ' ▼';
        a.classList.add('active');
      } else {
        a.textContent = '';
        a.classList.remove('active');
      }
    });
  }

  // ─── Filter ───
  _onFilterInput(col, value) {
    this.columnFilters[col] = value.trim().toLowerCase();
    this._rebuildViewIndices();
    this._updateFilterCount();
    this.renderRows();
  }

  _updateFilterCount() {
    const el = this.container.querySelector('#csv-filter-count');
    if (!el) return;
    const total = this.data.rows.length;
    const shown = this._getViewRows().length;
    if (shown < total) {
      el.textContent = `${shown} / ${total} rows`;
    } else {
      el.textContent = '';
    }
  }

  // ─── Index building (filter → sort) ───
  _rebuildViewIndices() {
    const rows = this.data.rows;
    const total = rows.length;

    // 1. Filter
    const hasFilter = this.columnFilters.some(f => f.length > 0);
    if (hasFilter) {
      this.filteredIndices = [];
      for (let r = 0; r < total; r++) {
        let match = true;
        for (let c = 0; c < this.colCountShown; c++) {
          const filter = this.columnFilters[c];
          if (!filter) continue;
          const val = String(rows[r][c] ?? '').toLowerCase();
          if (!val.includes(filter)) {
            match = false;
            break;
          }
        }
        if (match) this.filteredIndices.push(r);
      }
    } else {
      this.filteredIndices = null;
    }

    // 2. Sort
    const base = this.filteredIndices || Array.from({ length: total }, (_, i) => i);
    if (this.sortCol >= 0) {
      const col = this.sortCol;
      const asc = this.sortAsc;
      this.sortedIndices = [...base].sort((a, b) => {
        const va = String(rows[a][col] ?? '');
        const vb = String(rows[b][col] ?? '');
        // Try numeric comparison
        const na = Number(va);
        const nb = Number(vb);
        if (!isNaN(na) && !isNaN(nb) && va !== '' && vb !== '') {
          return asc ? na - nb : nb - na;
        }
        // Lexicographic
        const cmp = va.localeCompare(vb, undefined, { sensitivity: 'base' });
        return asc ? cmp : -cmp;
      });
    } else {
      this.sortedIndices = base.length < total || this.filteredIndices ? base : null;
    }

    // Update spacer height
    const viewCount = this._getViewRows().length;
    if (this.spacer) this.spacer.style.height = `${viewCount * this.rowHeight}px`;
  }

  _getViewRows() {
    if (this.sortedIndices) return this.sortedIndices;
    if (this.filteredIndices) return this.filteredIndices;
    return this.data.rows;
  }

  _getViewRowCount() {
    if (this.sortedIndices) return this.sortedIndices.length;
    if (this.filteredIndices) return this.filteredIndices.length;
    return this.data.rows.length;
  }

  // ─── Stats panel ───
  _toggleStats() {
    this.statsVisible = !this.statsVisible;
    const panel = this.container.querySelector('#csv-stats-panel');
    if (!panel) return;

    if (this.statsVisible) {
      panel.classList.remove('hidden');
      this._renderStats(panel);
    } else {
      panel.classList.add('hidden');
    }
  }

  _renderStats(panel) {
    if (!this.columnStats || this.columnStats.length === 0) {
      panel.innerHTML = '<div class="csv-stats-empty">No columns to analyze.</div>';
      return;
    }

    const cards = this.columnStats.map((s, idx) => {
      const minMax = s.isNumeric
        ? `<span class="csv-stat-val">${s.minNum} – ${s.maxNum}</span>`
        : (s.min !== null ? `<span class="csv-stat-val" title="${esc(s.min)} – ${esc(s.max)}">${trunc(s.min)} – ${trunc(s.max)}</span>` : '<span class="csv-stat-val">—</span>');

      return `<div class="csv-stat-card" data-col="${idx}">
        <div class="csv-stat-name" title="${esc(s.name)}">${esc(s.name)}</div>
        <div class="csv-stat-row"><span class="csv-stat-label">Null %</span><span class="csv-stat-val">${s.nullPct}%</span></div>
        <div class="csv-stat-row"><span class="csv-stat-label">Unique</span><span class="csv-stat-val">${s.cardinality}</span></div>
        <div class="csv-stat-row"><span class="csv-stat-label">Type</span><span class="csv-stat-val">${s.isNumeric ? 'numeric' : 'text'}</span></div>
        <div class="csv-stat-row"><span class="csv-stat-label">Range</span>${minMax}</div>
      </div>`;
    }).join('');

    panel.innerHTML = `<div class="csv-stats-grid">${cards}</div>`;
  }

  _resetAll() {
    this.sortCol = -1;
    this.sortAsc = true;
    this.columnFilters = new Array(this.colCountShown).fill('');
    this.filteredIndices = null;
    this.sortedIndices = null;

    // Clear UI filter inputs
    const inputs = this.container.querySelectorAll('.csv-filter-input');
    inputs.forEach(i => { i.value = ''; });

    this._updateSortArrows();
    this._rebuildViewIndices();
    this._updateFilterCount();
    this.renderRows();
  }

  // ─── Render ───
  _scheduleRender() {
    if (this._renderFrame) return;
    this._renderFrame = requestAnimationFrame(() => {
      this._renderFrame = null;
      this.renderRows();
    });
  }

  renderRows() {
    if (!this.viewport || !this.data || !this.rowsLayer) return;

    const viewCount = this._getViewRowCount();
    const isIndexed = Boolean(this.sortedIndices || this.filteredIndices);
    const viewHeight = this.viewport.clientHeight || 1;
    const scrollTop = this.viewport.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.overscan);
    const count = Math.ceil(viewHeight / this.rowHeight) + this.overscan * 2;
    const end = Math.min(viewCount, start + count);
    const gridCols = `repeat(${this.colCountShown}, 180px)`;

    this.rowsLayer.innerHTML = '';
    const frag = document.createDocumentFragment();
    const rows = this.data.rows;
    const indices = this.sortedIndices || this.filteredIndices;

    for (let v = start; v < end; v++) {
      const r = isIndexed ? indices[v] : v;
      const rowEl = document.createElement('div');
      rowEl.className = 'csv-row';
      rowEl.style.top = `${v * this.rowHeight}px`;
      rowEl.style.height = `${this.rowHeight}px`;
      rowEl.style.gridTemplateColumns = gridCols;

      const row = rows[r];
      for (let c = 0; c < this.colCountShown; c++) {
        const cell = document.createElement('div');
        cell.className = 'csv-cell';
        const raw = row[c] ?? '';
        const value = String(raw);
        cell.textContent = value;
        cell.title = value;
        rowEl.appendChild(cell);
      }

      frag.appendChild(rowEl);
    }

    this.rowsLayer.appendChild(frag);
  }
}

// Helpers
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function trunc(s, max = 20) {
  const str = String(s || '');
  return str.length > max ? str.slice(0, max) + '…' : str;
}

