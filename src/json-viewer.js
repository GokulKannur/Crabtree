// ============================================
// CRAB TREE — Enhanced JSON Tree Viewer
// Investigation-grade: search, filter, copy,
// depth control, stats, type badges,
// virtualization, animations.
// ============================================

const VIRTUAL_PAGE_SIZE = 50;

export class JsonViewer {
    constructor(container) {
        this.container = container;
        this.data = null;
        this.searchTerm = '';
        this.matchCount = 0;
        this.matchIndex = -1;
        this.matchElements = [];
        this._contextMenu = null;
        this._searchDebounce = null;
    }

    render(data) {
        this.data = data;
        this.container.innerHTML = '';
        this.container.classList.add('jv-root');

        // ── Stats Bar ──
        const stats = this._computeStats(data);
        const statsBar = this._el('div', 'jv-stats-bar');
        statsBar.innerHTML = `
            <span class="jv-stat-chip"><span class="jv-stat-icon">🔑</span>${stats.keys} keys</span>
            <span class="jv-stat-chip"><span class="jv-stat-icon">📐</span>Depth ${stats.depth}</span>
            <span class="jv-stat-chip"><span class="jv-stat-icon">📦</span>${stats.arrays} arrays</span>
            <span class="jv-stat-chip"><span class="jv-stat-icon">📄</span>${stats.objects} objects</span>
            <span class="jv-stat-chip jv-stat-types">
                <span class="jv-type-dot jv-type-string" title="Strings: ${stats.strings}"></span>${stats.strings}
                <span class="jv-type-dot jv-type-number" title="Numbers: ${stats.numbers}"></span>${stats.numbers}
                <span class="jv-type-dot jv-type-boolean" title="Booleans: ${stats.booleans}"></span>${stats.booleans}
                <span class="jv-type-dot jv-type-null" title="Nulls: ${stats.nulls}"></span>${stats.nulls}
            </span>
        `;
        this.container.appendChild(statsBar);

        // ── Toolbar ──
        const toolbar = this._el('div', 'jv-toolbar');

        // Collapse / Expand
        const collapseBtn = this._btn('▶ Collapse All', () => this.collapseAll());
        const expandBtn = this._btn('▼ Expand All', () => this.expandAll());
        toolbar.appendChild(collapseBtn);
        toolbar.appendChild(expandBtn);

        // Depth Controls
        const depthGroup = this._el('div', 'jv-depth-group');
        const depthLabel = this._el('span', 'jv-depth-label');
        depthLabel.textContent = 'Depth:';
        depthGroup.appendChild(depthLabel);
        [1, 2, 3, 4, 5].forEach(d => {
            const btn = this._btn(String(d), () => this.collapseToDepth(d));
            btn.className = 'jv-depth-btn';
            btn.title = `Expand to depth ${d}`;
            depthGroup.appendChild(btn);
        });
        toolbar.appendChild(depthGroup);

        // Search
        const searchBox = this._el('div', 'jv-search-box');
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'jv-search-input';
        searchInput.placeholder = 'Search keys & values…';
        searchInput.autocomplete = 'off';
        searchInput.addEventListener('input', () => {
            clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => this._onSearch(searchInput.value), 150);
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) this._searchPrev();
                else this._searchNext();
            }
            if (e.key === 'Escape') {
                searchInput.value = '';
                this._onSearch('');
            }
        });

        this._searchMeta = this._el('span', 'jv-search-meta');

        const prevBtn = this._btn('▲', () => this._searchPrev());
        prevBtn.className = 'jv-search-nav';
        prevBtn.title = 'Previous match (Shift+Enter)';
        const nextBtn = this._btn('▼', () => this._searchNext());
        nextBtn.className = 'jv-search-nav';
        nextBtn.title = 'Next match (Enter)';

        searchBox.appendChild(searchInput);
        searchBox.appendChild(this._searchMeta);
        searchBox.appendChild(prevBtn);
        searchBox.appendChild(nextBtn);
        toolbar.appendChild(searchBox);

        // Breadcrumb
        const breadcrumb = this._el('span', 'jv-breadcrumb');
        breadcrumb.id = 'jv-breadcrumb';
        breadcrumb.textContent = '$';
        toolbar.appendChild(breadcrumb);

        this.container.appendChild(toolbar);

        // ── Tree ──
        const treeContainer = this._el('div', 'jv-tree');
        const tree = this.createNode(null, data, true, [], 0);
        treeContainer.appendChild(tree);
        this.container.appendChild(treeContainer);

        // dismiss context menu on click outside
        document.addEventListener('click', () => this._hideContextMenu());
    }

    // ═══════════════════════════════════════════
    //  Stats Computation
    // ═══════════════════════════════════════════

    _computeStats(data) {
        const s = { keys: 0, depth: 0, arrays: 0, objects: 0, strings: 0, numbers: 0, booleans: 0, nulls: 0 };
        const walk = (val, d) => {
            if (d > s.depth) s.depth = d;
            if (val === null) { s.nulls++; return; }
            if (Array.isArray(val)) {
                s.arrays++;
                val.forEach(v => walk(v, d + 1));
            } else if (typeof val === 'object') {
                s.objects++;
                const keys = Object.keys(val);
                s.keys += keys.length;
                keys.forEach(k => walk(val[k], d + 1));
            } else if (typeof val === 'string') { s.strings++; }
            else if (typeof val === 'number') { s.numbers++; }
            else if (typeof val === 'boolean') { s.booleans++; }
        };
        walk(data, 0);
        return s;
    }

    // ═══════════════════════════════════════════
    //  Collapse / Expand Logic
    // ═══════════════════════════════════════════

    collapseAll() {
        this.container.querySelectorAll('.jv-children').forEach(ch => ch.classList.add('jv-collapsed'));
        this.container.querySelectorAll('.jv-arrow').forEach(a => { a.classList.remove('expanded'); a.textContent = '▶'; });
        this.container.querySelectorAll('.jv-size').forEach(s => s.classList.add('visible'));
        this.container.querySelectorAll('.jv-close-inline').forEach(c => c.classList.remove('jv-hidden'));
    }

    expandAll() {
        this.container.querySelectorAll('.jv-children').forEach(ch => ch.classList.remove('jv-collapsed'));
        this.container.querySelectorAll('.jv-arrow').forEach(a => { a.classList.add('expanded'); a.textContent = '▼'; });
        this.container.querySelectorAll('.jv-size').forEach(s => s.classList.remove('visible'));
        this.container.querySelectorAll('.jv-close-inline').forEach(c => c.classList.add('jv-hidden'));
        // Ensure "show more" pagination buttons are visible after expand all
    }

    collapseToDepth(maxDepth) {
        this.container.querySelectorAll('.jv-node').forEach(node => {
            const depth = parseInt(node.dataset.depth || '0');
            const children = node.querySelector(':scope > .jv-children');
            const arrow = node.querySelector(':scope > .jv-line > .jv-arrow');
            const size = node.querySelector(':scope > .jv-line > .jv-size');
            const closeInline = node.querySelector(':scope > .jv-line > .jv-close-inline');

            if (!children || !arrow) return;

            if (depth < maxDepth) {
                children.classList.remove('jv-collapsed');
                arrow.classList.add('expanded');
                arrow.textContent = '▼';
                if (size) size.classList.remove('visible');
                if (closeInline) closeInline.classList.add('jv-hidden');
            } else {
                children.classList.add('jv-collapsed');
                arrow.classList.remove('expanded');
                arrow.textContent = '▶';
                if (size) size.classList.add('visible');
                if (closeInline) closeInline.classList.remove('jv-hidden');
            }
        });
    }

    // ═══════════════════════════════════════════
    //  Search
    // ═══════════════════════════════════════════

    _onSearch(term) {
        this.searchTerm = term.toLowerCase().trim();
        // Clear previous highlights
        this.container.querySelectorAll('.jv-highlight').forEach(el => el.classList.remove('jv-highlight'));
        this.container.querySelectorAll('.jv-highlight-active').forEach(el => el.classList.remove('jv-highlight-active'));
        this.matchElements = [];
        this.matchIndex = -1;

        if (!this.searchTerm) {
            this._searchMeta.textContent = '';
            return;
        }

        // Find all key and value elements that match
        const allTextEls = this.container.querySelectorAll('.jv-key, .jv-value');
        allTextEls.forEach(el => {
            const text = el.textContent.toLowerCase();
            if (text.includes(this.searchTerm)) {
                el.classList.add('jv-highlight');
                this.matchElements.push(el);
                // Auto-expand parent nodes so the match is visible
                this._expandParents(el);
            }
        });

        this.matchCount = this.matchElements.length;
        if (this.matchCount > 0) {
            this.matchIndex = 0;
            this._scrollToMatch();
        }
        this._updateSearchMeta();
    }

    _searchNext() {
        if (this.matchCount === 0) return;
        this.matchIndex = (this.matchIndex + 1) % this.matchCount;
        this._scrollToMatch();
    }

    _searchPrev() {
        if (this.matchCount === 0) return;
        this.matchIndex = (this.matchIndex - 1 + this.matchCount) % this.matchCount;
        this._scrollToMatch();
    }

    _scrollToMatch() {
        this.container.querySelectorAll('.jv-highlight-active').forEach(el => el.classList.remove('jv-highlight-active'));
        const el = this.matchElements[this.matchIndex];
        if (!el) return;
        el.classList.add('jv-highlight-active');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this._updateSearchMeta();
    }

    _updateSearchMeta() {
        if (this.matchCount === 0 && this.searchTerm) {
            this._searchMeta.textContent = 'No matches';
            this._searchMeta.className = 'jv-search-meta jv-search-no-match';
        } else if (this.matchCount > 0) {
            this._searchMeta.textContent = `${this.matchIndex + 1} / ${this.matchCount}`;
            this._searchMeta.className = 'jv-search-meta';
        } else {
            this._searchMeta.textContent = '';
            this._searchMeta.className = 'jv-search-meta';
        }
    }

    _expandParents(el) {
        let current = el.parentElement;
        while (current && !current.classList.contains('jv-tree')) {
            if (current.classList.contains('jv-children') && current.classList.contains('jv-collapsed')) {
                current.classList.remove('jv-collapsed');
                // Update the arrow in the parent node's line
                const parentNode = current.parentElement;
                if (parentNode) {
                    const arrow = parentNode.querySelector(':scope > .jv-line > .jv-arrow');
                    const size = parentNode.querySelector(':scope > .jv-line > .jv-size');
                    const closeInline = parentNode.querySelector(':scope > .jv-line > .jv-close-inline');
                    if (arrow) { arrow.classList.add('expanded'); arrow.textContent = '▼'; }
                    if (size) size.classList.remove('visible');
                    if (closeInline) closeInline.classList.add('jv-hidden');
                }
            }
            current = current.parentElement;
        }
    }

    // ═══════════════════════════════════════════
    //  Context Menu (Copy Path / Copy Value)
    // ═══════════════════════════════════════════

    _showContextMenu(e, path, value) {
        e.preventDefault();
        e.stopPropagation();
        this._hideContextMenu();

        const menu = this._el('div', 'jv-context-menu');
        const pathStr = '$' + path.map(p => /^\d+$/.test(p) ? `[${p}]` : `.${p}`).join('');

        const copyPath = this._el('div', 'jv-ctx-item');
        copyPath.textContent = `📋 Copy Path`;
        copyPath.title = pathStr;
        copyPath.addEventListener('click', (ev) => {
            ev.stopPropagation();
            navigator.clipboard.writeText(pathStr).catch(() => { });
            this._hideContextMenu();
            this._showToast('Path copied!');
        });

        const copyValue = this._el('div', 'jv-ctx-item');
        const valStr = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
        copyValue.textContent = `📄 Copy Value`;
        copyValue.addEventListener('click', (ev) => {
            ev.stopPropagation();
            navigator.clipboard.writeText(valStr).catch(() => { });
            this._hideContextMenu();
            this._showToast('Value copied!');
        });

        const copyKey = this._el('div', 'jv-ctx-item');
        const lastKey = path.length > 0 ? path[path.length - 1] : '$';
        copyKey.textContent = `🔑 Copy Key`;
        copyKey.addEventListener('click', (ev) => {
            ev.stopPropagation();
            navigator.clipboard.writeText(lastKey).catch(() => { });
            this._hideContextMenu();
            this._showToast('Key copied!');
        });

        menu.appendChild(copyPath);
        menu.appendChild(copyValue);
        menu.appendChild(copyKey);

        // Position
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        document.body.appendChild(menu);
        this._contextMenu = menu;

        // Keep within viewport
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
            if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
        });
    }

    _hideContextMenu() {
        if (this._contextMenu) {
            this._contextMenu.remove();
            this._contextMenu = null;
        }
    }

    _showToast(msg) {
        const toast = this._el('div', 'jv-toast');
        toast.textContent = msg;
        this.container.appendChild(toast);
        setTimeout(() => toast.classList.add('jv-toast-visible'), 10);
        setTimeout(() => {
            toast.classList.remove('jv-toast-visible');
            setTimeout(() => toast.remove(), 200);
        }, 1500);
    }

    // ═══════════════════════════════════════════
    //  Tree Node Creation
    // ═══════════════════════════════════════════

    createNode(key, value, isLast = false, parentPath = [], depth = 0) {
        const type = this._getType(value);
        const isObject = type === 'object' || type === 'array';
        const isEmpty = isObject && Object.keys(value).length === 0;
        const currentPath = key === null ? parentPath : [...parentPath, String(key)];

        const node = this._el('div', 'jv-node');
        node.dataset.depth = depth;
        node.dataset.path = currentPath.map(encodeURIComponent).join('/');

        // Context menu
        node.addEventListener('contextmenu', (e) => {
            this._showContextMenu(e, currentPath, value);
        });

        // Breadcrumb on hover
        node.addEventListener('mouseenter', (e) => {
            e.stopPropagation();
            const bc = document.getElementById('jv-breadcrumb');
            if (bc) {
                bc.textContent = currentPath.length === 0
                    ? '$'
                    : '$' + currentPath.map(p => /^\d+$/.test(p) ? `[${p}]` : `.${p}`).join('');
            }
        });

        // ── Line ──
        const line = this._el('div', 'jv-line');

        // Arrow
        if (isObject && !isEmpty) {
            const arrow = this._el('span', 'jv-arrow expanded');
            arrow.textContent = '▼';
            arrow.onclick = (e) => { e.stopPropagation(); this._toggleNode(node, arrow); };
            line.appendChild(arrow);
            line.style.cursor = 'pointer';
            line.onclick = (e) => { e.stopPropagation(); this._toggleNode(node, arrow); };
        } else {
            line.appendChild(this._el('span', 'jv-spacer'));
        }

        // Key
        if (key !== null) {
            const keySpan = this._el('span', 'jv-key');
            keySpan.textContent = `"${key}"`;
            line.appendChild(keySpan);

            const colon = this._el('span', 'jv-colon');
            colon.textContent = ': ';
            line.appendChild(colon);
        }

        // Value
        if (isObject) {
            const openChar = type === 'array' ? '[' : '{';
            const closeChar = type === 'array' ? ']' : '}';
            const count = Object.keys(value).length;

            const bracket = this._el('span', 'jv-bracket');

            if (isEmpty) {
                bracket.textContent = `${openChar}${closeChar}`;
                line.appendChild(bracket);
            } else {
                bracket.textContent = openChar;
                line.appendChild(bracket);

                const sizeSpan = this._el('span', 'jv-size');
                sizeSpan.textContent = ` ${count} ${type === 'array' ? 'items' : 'props'} `;
                line.appendChild(sizeSpan);

                const closeInline = this._el('span', 'jv-bracket jv-close-inline jv-hidden');
                closeInline.textContent = closeChar;
                line.appendChild(closeInline);
            }
        } else {
            // Type badge
            const badge = this._el('span', `jv-badge jv-badge-${type}`);
            badge.textContent = type === 'null' ? 'null' : type.charAt(0).toUpperCase();
            line.appendChild(badge);

            const valSpan = this._el('span', `jv-value jv-val-${type}`);
            valSpan.textContent = this._formatValue(value, type);
            valSpan.title = `${type}: ${this._formatValue(value, type)}`;

            // Click to show inline info tooltip
            valSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                this._showValueTooltip(valSpan, value, type);
            });

            line.appendChild(valSpan);
        }

        // Comma
        if (!isLast) {
            const comma = this._el('span', 'jv-comma');
            comma.textContent = ',';
            line.appendChild(comma);
        }

        node.appendChild(line);

        // ── Children ──
        if (isObject && !isEmpty) {
            const childrenDiv = this._el('div', 'jv-children');
            const keys = Object.keys(value);
            const isLargeArray = type === 'array' && keys.length > VIRTUAL_PAGE_SIZE;

            if (isLargeArray) {
                // Virtualized: render first page, add "show more"
                this._renderPage(childrenDiv, value, keys, 0, VIRTUAL_PAGE_SIZE, currentPath, depth);
                if (keys.length > VIRTUAL_PAGE_SIZE) {
                    this._addShowMore(childrenDiv, value, keys, VIRTUAL_PAGE_SIZE, currentPath, depth);
                }
            } else {
                keys.forEach((k, index) => {
                    childrenDiv.appendChild(this.createNode(k, value[k], index === keys.length - 1, currentPath, depth + 1));
                });
            }

            // Closing bracket
            const closingDiv = this._el('div', 'jv-line');
            closingDiv.appendChild(this._el('span', 'jv-spacer'));
            const closeBracket = this._el('span', 'jv-bracket');
            closeBracket.textContent = type === 'array' ? ']' : '}';
            if (!isLast) {
                const comma = this._el('span', 'jv-comma');
                comma.textContent = ',';
                closeBracket.appendChild(comma);
            }
            closingDiv.appendChild(closeBracket);
            childrenDiv.appendChild(closingDiv);
            node.appendChild(childrenDiv);
        }

        return node;
    }

    // ═══════════════════════════════════════════
    //  Large Array Virtualization
    // ═══════════════════════════════════════════

    _renderPage(container, value, keys, start, count, parentPath, depth) {
        const end = Math.min(start + count, keys.length);
        for (let i = start; i < end; i++) {
            const k = keys[i];
            container.appendChild(this.createNode(k, value[k], i === keys.length - 1, parentPath, depth + 1));
        }
    }

    _addShowMore(container, value, keys, loadedCount, parentPath, depth) {
        const remaining = keys.length - loadedCount;
        const btn = this._el('div', 'jv-show-more');
        btn.textContent = `▾ Show ${Math.min(VIRTUAL_PAGE_SIZE, remaining)} more… (${remaining} remaining)`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.remove();
            // Remove closing bracket temporarily (it's the last child)
            const closingBracket = container.lastElementChild;
            if (closingBracket) closingBracket.remove();

            const nextEnd = Math.min(loadedCount + VIRTUAL_PAGE_SIZE, keys.length);
            this._renderPage(container, value, keys, loadedCount, VIRTUAL_PAGE_SIZE, parentPath, depth);

            // Re-add closing bracket
            if (closingBracket) container.appendChild(closingBracket);

            // Add another "show more" if there are still more
            if (nextEnd < keys.length) {
                // Insert before closing bracket
                container.insertBefore(
                    this._createShowMoreBtn(container, value, keys, nextEnd, parentPath, depth),
                    container.lastElementChild
                );
            }
        });
        // Insert before closing bracket
        container.insertBefore(btn, container.lastElementChild);
    }

    _createShowMoreBtn(container, value, keys, loadedCount, parentPath, depth) {
        const remaining = keys.length - loadedCount;
        const btn = this._el('div', 'jv-show-more');
        btn.textContent = `▾ Show ${Math.min(VIRTUAL_PAGE_SIZE, remaining)} more… (${remaining} remaining)`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.remove();
            const closingBracket = container.lastElementChild;
            if (closingBracket) closingBracket.remove();

            const nextEnd = Math.min(loadedCount + VIRTUAL_PAGE_SIZE, keys.length);
            this._renderPage(container, value, keys, loadedCount, VIRTUAL_PAGE_SIZE, parentPath, depth);

            if (closingBracket) container.appendChild(closingBracket);

            if (nextEnd < keys.length) {
                container.insertBefore(
                    this._createShowMoreBtn(container, value, keys, nextEnd, parentPath, depth),
                    container.lastElementChild
                );
            }
        });
        return btn;
    }

    // ═══════════════════════════════════════════
    //  Value Tooltip
    // ═══════════════════════════════════════════

    _showValueTooltip(anchor, value, type) {
        // Remove existing tooltip
        this.container.querySelectorAll('.jv-tooltip').forEach(t => t.remove());

        const tip = this._el('div', 'jv-tooltip');
        const strVal = type === 'string' ? value : String(value);
        const byteSize = new Blob([strVal]).size;

        tip.innerHTML = `
            <div class="jv-tip-row"><span class="jv-tip-label">Type</span><span class="jv-tip-val jv-val-${type}">${type}</span></div>
            <div class="jv-tip-row"><span class="jv-tip-label">Value</span><span class="jv-tip-val">${this._escHtml(String(value))}</span></div>
            <div class="jv-tip-row"><span class="jv-tip-label">Size</span><span class="jv-tip-val">${byteSize} bytes</span></div>
            ${type === 'string' ? `<div class="jv-tip-row"><span class="jv-tip-label">Length</span><span class="jv-tip-val">${value.length} chars</span></div>` : ''}
        `;

        const copyBtn = this._el('button', 'jv-tip-copy');
        copyBtn.textContent = '📋 Copy';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(String(value)).catch(() => { });
            tip.remove();
            this._showToast('Value copied!');
        });
        tip.appendChild(copyBtn);

        // Position relative to anchor
        anchor.style.position = 'relative';
        anchor.appendChild(tip);

        // Dismiss on click outside
        const dismiss = (e) => {
            if (!tip.contains(e.target)) {
                tip.remove();
                document.removeEventListener('click', dismiss);
            }
        };
        setTimeout(() => document.addEventListener('click', dismiss), 0);
    }

    // ═══════════════════════════════════════════
    //  Toggle Node
    // ═══════════════════════════════════════════

    _toggleNode(node, arrow) {
        const children = node.querySelector(':scope > .jv-children');
        const size = node.querySelector(':scope > .jv-line > .jv-size');
        const closeInline = node.querySelector(':scope > .jv-line > .jv-close-inline');

        if (!children) return;

        if (children.classList.contains('jv-collapsed')) {
            children.classList.remove('jv-collapsed');
            arrow.classList.add('expanded');
            arrow.textContent = '▼';
            if (size) size.classList.remove('visible');
            if (closeInline) closeInline.classList.add('jv-hidden');
        } else {
            children.classList.add('jv-collapsed');
            arrow.classList.remove('expanded');
            arrow.textContent = '▶';
            if (size) size.classList.add('visible');
            if (closeInline) closeInline.classList.remove('jv-hidden');
        }
    }

    // ═══════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════

    _getType(value) {
        if (value === null) return 'null';
        if (Array.isArray(value)) return 'array';
        return typeof value;
    }

    _formatValue(value, type) {
        if (type === 'string') return `"${value}"`;
        return String(value);
    }

    _el(tag, className) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        return el;
    }

    _btn(text, onclick) {
        const btn = document.createElement('button');
        btn.className = 'jv-toolbar-btn';
        btn.textContent = text;
        btn.addEventListener('click', onclick);
        return btn;
    }

    _escHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}
