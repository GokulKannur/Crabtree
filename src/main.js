// ============================================
// CRAB TREE — Main Application Module
// ============================================

import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { EditorView, keymap, lineNumbers as lineNumbersExt, gutter, GutterMarker } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json as jsonLang } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { xml } from '@codemirror/lang-xml';
import { sql } from '@codemirror/lang-sql';
import { php } from '@codemirror/lang-php';
import { oneDark } from '@codemirror/theme-one-dark';
import { indentWithTab } from '@codemirror/commands';
import { search } from '@codemirror/search';
import { linter, lintGutter } from '@codemirror/lint';

import './styles.css';
import { CommandPalette } from './command-palette.js';
import { logLanguage } from './lang-log.js';
import { JsonViewer } from './json-viewer.js';
import { CsvViewer } from './csv-viewer.js';
import { DataAnalyzer } from './data-analyzer.js';
import { parseJsonPathTokens, resolveJsonPathValue } from './query-core.js';
import { WorkerBridge } from './worker-bridge.js';

function loadSavedLogFilters() {
  try {
    const parsed = JSON.parse(localStorage.getItem('crabtree-saved-log-filters') || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0)
      .slice(0, 20);
  } catch {
    return [];
  }
}

// ─── Application State ───
const state = {
  tabs: [],
  activeTabId: null,
  theme: localStorage.getItem('crabtree-theme') || 'dark',
  sidebarOpen: true,
  folderPath: null,
  folderEntries: null,
  untitledCounter: 0,
  wordWrap: localStorage.getItem('crabtree-wordwrap') === 'true',
  fontSize: parseInt(localStorage.getItem('crabtree-fontsize')) || 14,
  lineNumbers: localStorage.getItem('crabtree-linenumbers') !== 'false',
  autoSave: localStorage.getItem('crabtree-autosave') === 'true',
  autoSaveDelay: 3000,
  recentFiles: JSON.parse(localStorage.getItem('crabtree-recent') || '[]'),
  savedLogFilters: loadSavedLogFilters(),
  largeFileWarnThreshold: 25 * 1024 * 1024,
  largeFileStrictThreshold: 100 * 1024 * 1024,
  largeFileChunkChars: 1_000_000,
};

// Worker bridge — heavy queries run off the main thread
const workerBridge = new WorkerBridge();

// ─── Session Persistence ───
const SESSION_KEY = 'crabtree-session';
const SESSION_SAVE_DELAY = 800;
let sessionSaveTimer = null;

function scheduleSessionSave() {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSession, SESSION_SAVE_DELAY);
}

function saveSession() {
  try {
    const tabSnapshots = state.tabs
      .filter(t => t.path) // only persist file-backed tabs
      .map(t => {
        let cursorPos = 0;
        if (t.editorView) {
          cursorPos = t.editorView.state.selection.main.head;
        } else if (t._savedCursorPos !== undefined) {
          cursorPos = t._savedCursorPos;
        }
        const q = t.query || {};
        return {
          path: t.path,
          name: t.name,
          pinned: t.pinned,
          viewMode: t.viewMode,
          cursorPos,
          queryText: q.text || '',
        };
      });

    const session = {
      version: 1,
      activeTabPath: null,
      folderPath: state.folderPath,
      tabs: tabSnapshots,
    };

    // Record active tab by path
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    if (activeTab?.path) session.activeTabPath = activeTab.path;

    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (e) {
    console.warn('Session save failed:', e);
  }
}

async function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const session = JSON.parse(raw);
    if (!session || session.version !== 1 || !Array.isArray(session.tabs) || session.tabs.length === 0) return false;

    // Restore folder sidebar first
    if (session.folderPath) {
      try {
        state.folderPath = session.folderPath;
        const entries = await invoke('list_directory', { path: session.folderPath });
        renderFileTree(entries);
      } catch { /* folder may no longer exist */ }
    }

    let activeRestoreId = null;

    for (const snap of session.tabs) {
      if (!snap.path) continue;
      try {
        const fileData = await invoke('read_file', { path: snap.path });
        const tab = createTab(fileData);
        // Apply persisted state
        if (snap.pinned) { tab.pinned = true; }
        if (snap.viewMode) tab.viewMode = snap.viewMode;
        if (snap.cursorPos) tab._savedCursorPos = snap.cursorPos;
        if (snap.queryText) {
          const q = ensureQueryState(tab);
          q.text = snap.queryText;
        }
        if (snap.path === session.activeTabPath) activeRestoreId = tab.id;
      } catch {
        // File may no longer exist — skip silently
      }
    }

    // Re-render tab bar with pin state applied
    reRenderAllTabs();

    // Switch to the previously-active tab
    if (activeRestoreId) {
      switchToTab(activeRestoreId);
    }

    // Apply deferred query + cursor for all restored tabs
    for (const tab of state.tabs) {
      const q = ensureQueryState(tab);
      if (q.text && isQueryableTab(tab)) {
        applyQueryToTab(tab, q.text);
      }
      // Cursor will be applied when the tab is shown via _savedCursorPos
    }

    return state.tabs.length > 0;
  } catch (e) {
    console.warn('Session restore failed:', e);
    return false;
  }
}

// Compartments for dynamic reconfiguration
const wrapCompartment = new Compartment();
const lineNumCompartment = new Compartment();

// ─── Language map ───
function getLanguageExtension(lang) {
  const map = {
    javascript: javascript,
    typescript: () => javascript({ typescript: true }),
    jsx: () => javascript({ jsx: true }),
    tsx: () => javascript({ jsx: true, typescript: true }),
    python: python,
    html: html,
    css: css,
    json: jsonLang,
    markdown: markdown,
    rust: rust,
    cpp: cpp,
    c: cpp,
    java: java,
    xml: xml,
    sql: sql,
    php: php,
    log: () => logLanguage,
  };
  const ext = map[lang];
  if (ext) {
    try { return [ext()]; } catch { return []; }
  }
  return [];
}

// ─── JSON Linter ───
function jsonLinter() {
  return linter((view) => {
    const diagnostics = [];
    const doc = view.state.doc.toString();
    if (!doc.trim()) return diagnostics;
    try {
      JSON.parse(doc);
    } catch (e) {
      const match = e.message.match(/position (\d+)/);
      const pos = match ? parseInt(match[1]) : 0;
      const safePos = Math.min(pos, doc.length);
      diagnostics.push({
        from: safePos,
        to: Math.min(safePos + 1, doc.length),
        severity: 'error',
        message: e.message,
      });
    }
    return diagnostics;
  });
}

function getLinter(lang) {
  if (lang === 'json') return [jsonLinter(), lintGutter()];
  return [];
}

// ─── Theme ───
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-icon').textContent = theme === 'dark' ? '🌙' : '☀️';
  localStorage.setItem('crabtree-theme', theme);
}

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  state.tabs.forEach(tab => {
    if (tab.editorView) {
      syncTabContentFromEditor(tab);
      tab.editorView.destroy();
      tab.editorView = null;
    }
  });
  if (state.activeTabId) showEditor(state.activeTabId);
}

// ─── Font Size ───
function setFontSize(size) {
  state.fontSize = Math.min(30, Math.max(8, size));
  localStorage.setItem('crabtree-fontsize', state.fontSize);
  document.documentElement.style.setProperty('--editor-font-size', state.fontSize + 'px');
  document.getElementById('status-fontsize').textContent = state.fontSize + 'px';
}

// ─── Word Wrap ───
function toggleWordWrap() {
  state.wordWrap = !state.wordWrap;
  localStorage.setItem('crabtree-wordwrap', state.wordWrap);
  updateWrapUI();
  // Reconfigure active editor
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (tab && tab.editorView) {
    tab.editorView.dispatch({
      effects: wrapCompartment.reconfigure(state.wordWrap ? EditorView.lineWrapping : [])
    });
  }
}

function updateWrapUI() {
  const el = document.getElementById('status-wrap');
  if (el) el.textContent = state.wordWrap ? 'Wrap: On' : 'Wrap: Off';
}

// ─── Line Numbers ───
function toggleLineNumbers() {
  state.lineNumbers = !state.lineNumbers;
  localStorage.setItem('crabtree-linenumbers', state.lineNumbers);
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (tab && tab.editorView) {
    tab.editorView.dispatch({
      effects: lineNumCompartment.reconfigure(state.lineNumbers ? lineNumbersExt() : [])
    });
  }
}

// ─── Auto-Save ───
let autoSaveTimers = {};

function toggleAutoSave() {
  state.autoSave = !state.autoSave;
  localStorage.setItem('crabtree-autosave', state.autoSave);
  const el = document.getElementById('status-autosave');
  if (el) el.textContent = state.autoSave ? '💾 Auto' : '💾 Manual';
}

function scheduleAutoSave(tabId) {
  if (!state.autoSave) return;
  if (autoSaveTimers[tabId]) clearTimeout(autoSaveTimers[tabId]);
  autoSaveTimers[tabId] = setTimeout(async () => {
    const tab = state.tabs.find(t => t.id === tabId);
    if (tab && tab.modified && tab.path) {
      syncTabContentFromEditor(tab);
      try {
        await invoke('save_file', { path: tab.path, content: tab.content });
        tab.modified = false;
        updateTabUI(tab);
        flashAutoSaveIndicator();
      } catch (err) {
        console.error('Auto-save error:', err);
      }
    }
  }, state.autoSaveDelay);
}

// ─── Recent Files ───
function addRecentFile(path, name) {
  state.recentFiles = state.recentFiles.filter(r => r.path !== path);
  state.recentFiles.unshift({ path, name });
  if (state.recentFiles.length > 10) state.recentFiles = state.recentFiles.slice(0, 10);
  localStorage.setItem('crabtree-recent', JSON.stringify(state.recentFiles));
  renderRecentFiles();
}

function renderRecentFiles() {
  const container = document.getElementById('recent-files-list');
  if (!container) return;
  if (state.recentFiles.length === 0) {
    container.innerHTML = '<div class="empty-state">No recent files</div>';
    return;
  }
  container.innerHTML = '';
  state.recentFiles.forEach(item => {
    const el = document.createElement('div');
    el.className = 'recent-item';
    el.innerHTML = `<span class="recent-icon">📄</span><span class="recent-name">${escapeHtml(item.name)}</span><span class="recent-path">${escapeHtml(item.path)}</span>`;
    el.addEventListener('dblclick', async () => {
      const existing = state.tabs.find(t => t.path === item.path);
      if (existing) { switchToTab(existing.id); return; }
      try {
        const fileData = await invoke('read_file', { path: item.path });
        createTab(fileData);
      } catch (err) {
        console.error('Error opening recent file:', err);
      }
    });
    container.appendChild(el);
  });
}

// ─── Log Severity Gutter ───
class SeverityMarker extends GutterMarker {
  constructor(severity) {
    super();
    this.severity = severity;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = `severity-dot severity-${this.severity}`;
    el.title = this.severity.toUpperCase();
    return el;
  }
}

const severityMarkers = {
  error: new SeverityMarker('error'),
  warn: new SeverityMarker('warn'),
  info: new SeverityMarker('info'),
  debug: new SeverityMarker('debug'),
  trace: new SeverityMarker('trace'),
  fatal: new SeverityMarker('fatal'),
  critical: new SeverityMarker('critical'),
};

const SEVERITY_RE = /\b(ERROR|FATAL|CRITICAL|FAIL)\b/i;
const WARN_RE = /\b(WARN(?:ING)?)\b/i;
const INFO_RE = /\b(INFO)\b/i;
const DEBUG_RE = /\b(DEBUG)\b/i;
const TRACE_RE = /\b(TRACE)\b/i;

function logSeverityGutter() {
  return gutter({
    class: 'cm-severity-gutter',
    lineMarker(view, line) {
      const text = view.state.doc.sliceString(line.from, Math.min(line.from + 200, line.to));
      if (SEVERITY_RE.test(text)) return severityMarkers.error;
      if (WARN_RE.test(text)) return severityMarkers.warn;
      if (INFO_RE.test(text)) return severityMarkers.info;
      if (DEBUG_RE.test(text)) return severityMarkers.debug;
      if (TRACE_RE.test(text)) return severityMarkers.trace;
      return null;
    },
    lineMarkerChange(update) {
      return update.docChanged || update.viewportChanged;
    },
  });
}

// ─── Editor Creation ───
function createEditorView(content, language, options = {}) {
  const { readOnly = false } = options;
  const extensions = [
    basicSetup,
    keymap.of([indentWithTab]),
    search(),
    wrapCompartment.of(state.wordWrap ? EditorView.lineWrapping : []),
    lineNumCompartment.of(state.lineNumbers ? lineNumbersExt() : []),
    ...getLinter(language),
    EditorView.updateListener.of(update => {
      if (update.docChanged && state.activeTabId) {
        const tab = state.tabs.find(t => t.id === state.activeTabId);
        if (tab) {
          tab.modified = true;
          updateTabUI(tab);
          scheduleAutoSave(tab.id);
        }
      }
      if (update.selectionSet || update.docChanged) {
        updateCursorStatus(update.view);
      }
    }),
    ...getLanguageExtension(language),
    EditorView.theme({
      '&': { backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', height: '100%' },
      '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: 'var(--editor-font-size, 14px)', overflow: 'auto' },
      '.cm-gutters': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)', borderRight: '1px solid var(--border-subtle)' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--accent-dim)', color: 'var(--text-accent)' },
      '.cm-activeLine': { backgroundColor: 'var(--accent-dim)' },
      '.cm-cursor': { borderLeftColor: 'var(--accent)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgba(122, 162, 247, 0.2) !important' },
      '.cm-matchingBracket': { backgroundColor: 'rgba(122, 162, 247, 0.3)', outline: '1px solid var(--accent)' },
      '.cm-searchMatch': { backgroundColor: 'rgba(224, 175, 104, 0.3)', outline: '1px solid var(--warning)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(122, 162, 247, 0.3)' },
      '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-hover)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' },
      '.cm-diagnostic-error': { borderLeft: '3px solid var(--error)' },
      '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warning)' },
      '.cm-lint-marker-error': { content: '"●"', color: 'var(--error)' },
    }),
  ];

  if (readOnly) {
    extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
  }

  if (state.theme === 'dark') extensions.push(oneDark);

  // Log severity gutter for log-like files
  if (language === 'log' || language === 'plaintext') {
    extensions.push(logSeverityGutter());
  }

  return new EditorView({
    state: EditorState.create({ doc: content, extensions }),
    parent: document.getElementById('editor-container'),
  });
}

// ─── Tab Management ───
let tabIdCounter = 0;

function createTab(fileData) {
  const id = ++tabIdCounter;
  const tab = {
    id,
    path: fileData.path,
    name: fileData.file_name,
    content: fileData.content,
    encoding: fileData.encoding,
    language: '',
    lineEnding: fileData.line_ending,
    size: fileData.size,
    modified: false,
    pinned: false,
    viewMode: 'code', // 'code' | 'tree'
    readOnly: false,
    largeFileMode: false,
    progressive: false,
    fullContent: null,
    loadedChars: 0,
    query: {
      text: '',
      active: false,
      busy: false,
      previewContent: null,
      resultCount: null,
      totalCount: null,
      error: '',
      pathTokens: null,
      locateResult: null,
      clauseCount: 0,
      termCount: 0,
      clauses: [],
      pathCatalogSignature: '',
      pathCatalog: [],
    },
    editorView: null,
  };

  applyLargeFileSafetyPolicy(tab);
  state.tabs.push(tab);

  if (fileData.path) addRecentFile(fileData.path, fileData.file_name);

  invoke('get_file_language', { fileName: tab.name }).then(lang => {
    const lowerName = tab.name.toLowerCase();
    if (lowerName.endsWith('.log')) lang = 'log';
    if (lowerName.endsWith('.csv') || lowerName.endsWith('.tsv')) lang = 'csv';
    tab.language = lang;
    if (isCsvTab(tab) && tab.viewMode === 'code') tab.viewMode = 'table';

    // Fix race condition: if editor was already created, update content before re-rendering
    syncTabContentFromEditor(tab);

    if (state.activeTabId === tab.id) showEditor(tab.id);
    updateStatusBar(tab);
  });

  renderTab(tab);
  switchToTab(id);
  document.getElementById('welcome-screen').classList.add('hidden');
  return tab;
}

function renderTab(tab) {
  const container = document.getElementById('tabs-container');
  const el = document.createElement('div');
  el.className = 'tab' + (tab.pinned ? ' pinned' : '');
  el.dataset.id = tab.id;
  const tabFileColor = getFileColor(tab.name);
  const tabIcon = renderFileIcon(tab.name, false);
  el.innerHTML = `
    ${tab.pinned ? '<span class="tab-pin">📌</span>' : '<span class="tab-modified"></span>'}
    <span class="tab-icon">${tabIcon}</span>
    <span class="tab-name" style="color:${tabFileColor}">${escapeHtml(tab.name)}</span>
    ${tab.pinned ? '' : '<span class="tab-close">×</span>'}
  `;

  el.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) closeTab(tab.id);
    else switchToTab(tab.id);
  });

  // Context menu
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showTabContextMenu(e.clientX, e.clientY, tab.id);
  });

  // ─── Tab Drag Reorder ───
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(tab.id));
    el.classList.add('tab-dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('tab-dragging'));
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  el.addEventListener('dragenter', () => el.classList.add('tab-drag-over'));
  el.addEventListener('dragleave', () => el.classList.remove('tab-drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('tab-drag-over');
    const draggedId = parseInt(e.dataTransfer.getData('text/plain'));
    if (draggedId === tab.id) return;
    const fromIdx = state.tabs.findIndex(t => t.id === draggedId);
    const toIdx = state.tabs.findIndex(t => t.id === tab.id);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = state.tabs.splice(fromIdx, 1);
    state.tabs.splice(toIdx, 0, moved);
    reRenderAllTabs();
    scheduleSessionSave();
  });

  // Insert pinned tabs before unpinned
  if (tab.pinned) {
    const firstUnpinned = [...container.children].find(c => !c.classList.contains('pinned'));
    if (firstUnpinned) container.insertBefore(el, firstUnpinned);
    else container.appendChild(el);
  } else {
    container.appendChild(el);
  }
}

function reRenderAllTabs() {
  const container = document.getElementById('tabs-container');
  container.innerHTML = '';
  // Sort: pinned first
  const sorted = [...state.tabs].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  sorted.forEach(tab => renderTab(tab));
  // Re-highlight active
  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.id) === state.activeTabId);
  });
}

function ensureQueryState(tab) {
  if (tab.query) return tab.query;
  tab.query = {
    text: '',
    active: false,
    busy: false,
    previewContent: null,
    resultCount: null,
    totalCount: null,
    error: '',
    pathTokens: null,
    locateResult: null,
    clauseCount: 0,
    termCount: 0,
    clauses: [],
    pathCatalogSignature: '',
    pathCatalog: [],
  };
  return tab.query;
}

function syncTabContentFromEditor(tab) {
  if (!tab || !tab.editorView) return;
  const query = ensureQueryState(tab);
  if (query.active && query.previewContent !== null) return;
  tab.content = tab.editorView.state.doc.toString();
}

function getTabSourceContent(tab) {
  if (tab.fullContent) return tab.fullContent;
  return tab.content || '';
}

function getTabDisplayContent(tab) {
  const query = ensureQueryState(tab);
  if (query.active && query.previewContent !== null) return query.previewContent;
  return tab.content;
}

function isJsonTab(tab) {
  if (!tab) return false;
  return tab.language === 'json' || tab.name.toLowerCase().endsWith('.json');
}

function isCsvTab(tab) {
  if (!tab) return false;
  const lower = tab.name.toLowerCase();
  return tab.language === 'csv' || lower.endsWith('.csv') || lower.endsWith('.tsv');
}

function isLogLikeTab(tab) {
  if (!tab) return false;
  const lowerName = tab.name.toLowerCase();
  return tab.language === 'log' || lowerName.endsWith('.log');
}

function isQueryPreviewActive(tab) {
  if (!tab) return false;
  const query = ensureQueryState(tab);
  return query.active && query.previewContent !== null;
}

function isQueryableTab(tab) {
  if (!tab) return false;
  if (tab.progressive) return false;
  return isJsonTab(tab) || isLogLikeTab(tab);
}

function switchToTab(id) {
  if (state.activeTabId) {
    const currentTab = state.tabs.find(t => t.id === state.activeTabId);
    if (currentTab && currentTab.editorView) {
      // Preserve cursor position before destroying
      currentTab._savedCursorPos = currentTab.editorView.state.selection.main.head;
      syncTabContentFromEditor(currentTab);
      currentTab.editorView.destroy();
      currentTab.editorView = null;
    }
  }
  state.activeTabId = id;
  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.id) === id);
  });
  showEditor(id);
  scheduleSessionSave();
}

function updateBreadcrumb(tab) {
  const bar = document.getElementById('breadcrumb-bar');
  if (!bar) return;
  if (!tab || !tab.path) {
    bar.innerHTML = '';
    return;
  }
  // Build path segments
  const sep = tab.path.includes('/') ? '/' : '\\';
  const parts = tab.path.split(sep).filter(Boolean);
  // If folder is open, show relative path from folder root
  let displayParts = parts;
  if (state.folderPath) {
    const folderSep = state.folderPath.includes('/') ? '/' : '\\';
    const folderParts = state.folderPath.split(folderSep).filter(Boolean);
    if (parts.length > folderParts.length) {
      const relative = parts.slice(folderParts.length);
      displayParts = relative;
    }
  }
  bar.innerHTML = displayParts.map((p, i) =>
    `<span class="breadcrumb-segment">${escapeHtml(p)}</span>`
  ).join('<span class="breadcrumb-sep">/</span>');
}

function showEditor(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  updateBreadcrumb(tab);
  const container = document.getElementById('editor-container');
  container.innerHTML = ''; // Clear previous content (editors or tree)
  const displayContent = getTabDisplayContent(tab) || '';
  const queryPreviewActive = isQueryPreviewActive(tab);

  // Clean up previous editor if switching tabs
  state.tabs.forEach(t => {
    if (t.id !== id && t.editorView) {
      syncTabContentFromEditor(t);
      t.editorView.destroy();
      t.editorView = null;
    }
  });

  if (tab.viewMode === 'tree') {
    renderJsonTree(tab, container);
  } else if (tab.viewMode === 'table') {
    renderCsvTable(tab, container);
  } else {
    // Code View
    tab.editorView = createEditorView(displayContent, tab.language, { readOnly: tab.readOnly || queryPreviewActive });
    // Restore cursor position if we have a saved one
    if (tab._savedCursorPos && tab._savedCursorPos < tab.editorView.state.doc.length) {
      tab.editorView.dispatch({
        selection: { anchor: tab._savedCursorPos },
        scrollIntoView: true,
      });
    }
  }
  renderLargeFileBanner(tab, container);
  updateStatusBar(tab);
  updateQueryBar(tab);
  applyQueryViewEffects(tab);
  renderSecurityBanner(tab, container);
}

function renderJsonTree(tab, container) {
  const source = getTabSourceContent(tab);
  try {
    const data = JSON.parse(source);
    container.innerHTML = `<div class="json-viewer-container"></div>`;
    const viewer = new JsonViewer(container.querySelector('.json-viewer-container'));
    viewer.render(data);
  } catch (e) {
    console.error('JSON Render Error:', e);
    // Fallback to code view if parse fails
    tab.viewMode = 'code';
    tab.editorView = createEditorView(source, tab.language);
    alert('Invalid JSON, switching back to Code View: ' + e.message);
  }
}

function renderCsvTable(tab, container) {
  try {
    const source = getTabSourceContent(tab);
    container.innerHTML = `<div class="csv-viewer-container"></div>`;
    const viewer = new CsvViewer(container.querySelector('.csv-viewer-container'));
    viewer.render(source);
  } catch (e) {
    console.error('CSV Render Error:', e);
    tab.viewMode = 'code';
    tab.editorView = createEditorView(tab.content, tab.language);
    alert('Cannot render CSV table, switching back to Code View: ' + e.message);
  }
}

function toggleViewMode() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;

  if (isJsonTab(tab)) {
    if (tab.viewMode === 'code') {
      syncTabContentFromEditor(tab);
      try {
        JSON.parse(tab.content); // Validate before switching
        tab.viewMode = 'tree';
      } catch (e) {
        alert('Cannot switch to Tree View: Invalid JSON\n' + e.message);
        return;
      }
    } else {
      tab.viewMode = 'code';
    }
  } else if (isCsvTab(tab)) {
    tab.viewMode = tab.viewMode === 'table' ? 'code' : 'table';
  } else {
    return;
  }

  if (tab.editorView) {
    syncTabContentFromEditor(tab);
    tab.editorView.destroy();
    tab.editorView = null;
  }
  showEditor(tab.id);
  scheduleSessionSave();
}

function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];

  if (tab.modified) {
    showCloseDialog(tab).then(async (result) => {
      if (result === 'save') {
        state.activeTabId = tab.id;
        syncTabContentFromEditor(tab);
        if (!tab.path) {
          try {
            const selected = await save({ filters: [{ name: 'All Files', extensions: ['*'] }] });
            if (!selected) return;
            const filePath = typeof selected === 'string' ? selected : selected.path;
            await invoke('save_file', { path: filePath, content: tab.content });
          } catch (err) { console.error('Save error:', err); return; }
        } else {
          try { await invoke('save_file', { path: tab.path, content: tab.content }); }
          catch (err) { console.error('Save error:', err); return; }
        }
        doCloseTab(id);
      } else if (result === 'dont-save') {
        doCloseTab(id);
      }
    });
    return;
  }
  doCloseTab(id);
}

function doCloseTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  if (tab.editorView) { tab.editorView.destroy(); tab.editorView = null; }
  if (autoSaveTimers[id]) clearTimeout(autoSaveTimers[id]);
  state.tabs.splice(idx, 1);
  document.querySelector(`.tab[data-id="${id}"]`)?.remove();

  if (state.activeTabId === id) {
    if (state.tabs.length > 0) {
      switchToTab(state.tabs[Math.min(idx, state.tabs.length - 1)].id);
    } else {
      state.activeTabId = null;
      document.getElementById('welcome-screen').classList.remove('hidden');
      updateStatusBarEmpty();
    }
  }
  scheduleSessionSave();
}

// ─── Close Confirm Dialog ───
let closeDialogResolve = null;

function showCloseDialog(tab) {
  return new Promise((resolve) => {
    closeDialogResolve = resolve;
    document.getElementById('close-dialog-msg').textContent =
      `Do you want to save changes to "${tab.name}" before closing?`;
    document.getElementById('close-dialog').classList.remove('hidden');
  });
}

function hideCloseDialog() {
  document.getElementById('close-dialog').classList.add('hidden');
  closeDialogResolve = null;
}

function resolveCloseDialog(result) {
  if (closeDialogResolve) closeDialogResolve(result);
  hideCloseDialog();
}

// ─── Tab Context Menu ───
function showTabContextMenu(x, y, tabId) {
  hideTabContextMenu();
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;

  const menu = document.createElement('div');
  menu.id = 'tab-context-menu';
  menu.className = 'context-menu';

  const items = [
    { label: tab.pinned ? '📌 Unpin Tab' : '📌 Pin Tab', action: () => togglePinTab(tabId) },
    { label: '─', separator: true },
    { label: '✕ Close', action: () => closeTab(tabId) },
    { label: '✕ Close Others', action: () => closeOtherTabs(tabId) },
    { label: '✕ Close All', action: () => closeAllTabs() },
    { label: '✕ Close to the Right', action: () => closeTabsToRight(tabId) },
    { label: '─', separator: true },
    { label: '📋 Copy Path', action: () => { if (tab.path) navigator.clipboard.writeText(tab.path); } },
    { label: '📋 Copy Name', action: () => navigator.clipboard.writeText(tab.name) },
  ];

  items.forEach(item => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-separator';
      menu.appendChild(sep);
    } else {
      const el = document.createElement('div');
      el.className = 'context-item';
      el.textContent = item.label;
      el.addEventListener('click', () => { hideTabContextMenu(); item.action(); });
      menu.appendChild(el);
    }
  });

  // Position
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 300) + 'px';
  document.body.appendChild(menu);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', hideTabContextMenu, { once: true });
  }, 10);
}

function hideTabContextMenu() {
  document.getElementById('tab-context-menu')?.remove();
}

function closeOtherTabs(keepId) {
  const toClose = state.tabs.filter(t => t.id !== keepId && !t.pinned).map(t => t.id);
  toClose.forEach(id => closeTab(id));
}

function closeAllTabs() {
  const toClose = state.tabs.filter(t => !t.pinned).map(t => t.id);
  toClose.forEach(id => closeTab(id));
}

function closeTabsToRight(fromId) {
  const idx = state.tabs.findIndex(t => t.id === fromId);
  if (idx < 0) return;
  const toClose = state.tabs.slice(idx + 1).filter(t => !t.pinned).map(t => t.id);
  toClose.forEach(id => closeTab(id));
}

// ─── Pin Tabs ───
function togglePinTab(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;
  tab.pinned = !tab.pinned;
  reRenderAllTabs();
  scheduleSessionSave();
}

function updateTabUI(tab) {
  const el = document.querySelector(`.tab[data-id="${tab.id}"]`);
  if (el) el.classList.toggle('modified', tab.modified);
}

// ─── Status Bar ───
function updateStatusBar(tab) {
  document.getElementById('status-file').textContent = `${tab.path || tab.name}${tab.readOnly ? ' (Read-only)' : ''}`;
  document.getElementById('status-lang').textContent = formatLanguage(tab.language);
  document.getElementById('status-encoding').textContent = tab.encoding || 'UTF-8';
  document.getElementById('status-eol').textContent = tab.lineEnding || 'CRLF';
  document.getElementById('status-size').textContent = formatSize(tab.size);

  // View Toggle (Code/Tree)
  let viewToggle = document.getElementById('status-view-mode');
  if (!viewToggle) {
    const sep = document.createElement('span');
    sep.className = 'status-separator';
    sep.textContent = '|';
    viewToggle = document.createElement('span');
    viewToggle.id = 'status-view-mode';
    viewToggle.className = 'status-item clickable';
    viewToggle.title = 'Toggle Code/Tree View';
    viewToggle.onclick = toggleViewMode;

    // Insert before auto-save
    const rightStatus = document.querySelector('.status-right');
    const autoSaveObj = document.getElementById('status-autosave');
    if (rightStatus && autoSaveObj) {
      // Insert before the last separator
      const lastSep = autoSaveObj.previousElementSibling; // This is the | before autosave
      // Create a new separator for our new item
      const newSep = document.createElement('span');
      newSep.id = 'status-view-sep';
      newSep.className = 'status-separator';
      newSep.textContent = '|';

      // We want: ... | [ExistingItem] | [ViewToggle] | [AutoSave]
      // But status bar is flex, so order matters.
      // Let's just append it to the end for simplicity or insert before autosave.
      rightStatus.insertBefore(newSep, autoSaveObj);
      rightStatus.insertBefore(viewToggle, newSep);
    }
  }

  const sep = document.getElementById('status-view-sep');
  const supportsStructuredView = (isJsonTab(tab) || isCsvTab(tab)) && !tab.progressive;
  if (supportsStructuredView) {
    viewToggle.style.display = 'inline';
    if (sep) sep.style.display = 'inline';
    viewToggle.textContent = tab.viewMode === 'tree' ? 'Tree View' : '{} Code View';
    viewToggle.style.color = tab.viewMode === 'tree' ? 'var(--success)' : 'inherit';
    if (isCsvTab(tab)) {
      viewToggle.textContent = tab.viewMode === 'table' ? 'Table View' : '{} Code View';
      viewToggle.style.color = tab.viewMode === 'table' ? 'var(--success)' : 'inherit';
    }
  } else {
    viewToggle.style.display = 'none';
    if (sep) sep.style.display = 'none';
  }

  if (tab.editorView) updateCursorStatus(tab.editorView);
  else document.getElementById('status-cursor').textContent = '—';
}

function updateStatusBarEmpty() {
  document.getElementById('status-file').textContent = 'No file open';
  document.getElementById('status-lang').textContent = 'Plain Text';
  document.getElementById('status-encoding').textContent = 'UTF-8';
  document.getElementById('status-eol').textContent = 'CRLF';
  document.getElementById('status-cursor').textContent = 'Ln 1, Col 1';
  document.getElementById('status-size').textContent = '0 B';

  const viewToggle = document.getElementById('status-view-mode');
  if (viewToggle) viewToggle.style.display = 'none';
  const sep = document.getElementById('status-view-sep');
  if (sep) sep.style.display = 'none';
  updateQueryBar(null);
}

function updateCursorStatus(view) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from + 1;
  const selLen = Math.abs(view.state.selection.main.to - view.state.selection.main.from);
  let text = `Ln ${line.number}, Col ${col}`;
  if (selLen > 0) text += ` (${selLen} sel)`;
  document.getElementById('status-cursor').textContent = text;
}

function applyLargeFileSafetyPolicy(tab) {
  tab.largeFileMode = tab.size >= state.largeFileWarnThreshold;
  tab.readOnly = tab.largeFileMode;
  tab.progressive = false;
  tab.fullContent = null;
  tab.loadedChars = 0;

  if (!tab.largeFileMode) return;

  const original = tab.content || '';
  tab.loadedChars = original.length;
  if (original.length > state.largeFileChunkChars) {
    tab.progressive = true;
    tab.fullContent = original;
    tab.loadedChars = state.largeFileChunkChars;
    tab.content = original.slice(0, tab.loadedChars);
  }
}

function loadNextChunk(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab || !tab.progressive || !tab.fullContent) return;

  tab.loadedChars = Math.min(tab.loadedChars + state.largeFileChunkChars, tab.fullContent.length);
  tab.content = tab.fullContent.slice(0, tab.loadedChars);

  // If fully loaded, clear progressive state and dismiss banner
  if (tab.loadedChars >= tab.fullContent.length) {
    tab.fullContent = null;
    tab.progressive = false;
    if (tab.size < state.largeFileStrictThreshold) {
      tab.readOnly = false;
      tab.largeFileMode = false;
    }
  }

  if (state.activeTabId === tab.id) showEditor(tab.id);
}

function loadFullLargeFile(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab || !tab.largeFileMode) return;

  if (tab.fullContent) {
    tab.content = tab.fullContent;
    tab.loadedChars = tab.fullContent.length;
    tab.fullContent = null;
    tab.progressive = false;
  }

  if (tab.size < state.largeFileStrictThreshold) {
    tab.readOnly = false;
    tab.largeFileMode = false;
  }

  if (state.activeTabId === tab.id) showEditor(tab.id);
}

function renderLargeFileBanner(tab, container) {
  if (!tab.largeFileMode) return;

  const banner = document.createElement('div');
  banner.className = 'file-mode-banner' + (tab.size >= state.largeFileStrictThreshold ? ' strict' : '');

  const textWrap = document.createElement('div');
  textWrap.className = 'file-mode-banner-text';
  const title = document.createElement('div');
  title.className = 'file-mode-banner-title';
  title.textContent = tab.size >= state.largeFileStrictThreshold
    ? `Large file safety mode (${formatSize(tab.size)}): opened read-only to reduce memory pressure.`
    : `Large file mode (${formatSize(tab.size)}): opened read-only for safer performance.`;

  const meta = document.createElement('div');
  meta.className = 'file-mode-banner-meta';
  if (tab.progressive && tab.fullContent) {
    const percent = Math.min(100, Math.round((tab.loadedChars / tab.fullContent.length) * 100));
    meta.textContent = `Progressive preview: ${formatSize(tab.loadedChars)} / ${formatSize(tab.fullContent.length)} loaded (${percent}%).`;
  } else {
    meta.textContent = `Loaded content: ${formatSize(tab.content.length)}.`;
  }
  textWrap.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'file-mode-banner-actions';

  if (tab.progressive && tab.fullContent && tab.loadedChars < tab.fullContent.length) {
    const nextBtn = document.createElement('button');
    nextBtn.className = 'file-mode-btn';
    nextBtn.textContent = 'Load Next Chunk';
    nextBtn.addEventListener('click', () => loadNextChunk(tab.id));
    actions.appendChild(nextBtn);
  }

  if (tab.size < state.largeFileStrictThreshold && (tab.progressive || tab.readOnly)) {
    const fullBtn = document.createElement('button');
    fullBtn.className = 'file-mode-btn secondary';
    fullBtn.textContent = 'Load Full File';
    fullBtn.addEventListener('click', () => loadFullLargeFile(tab.id));
    actions.appendChild(fullBtn);
  }

  if (actions.children.length > 0) banner.append(textWrap, actions);
  else banner.append(textWrap);

  container.appendChild(banner);
}

async function applyLogQuery(tab, rawQuery) {
  const query = ensureQueryState(tab);
  const source = getTabSourceContent(tab);

  // Show loading state immediately
  query.active = true;
  query.busy = true;
  query.error = '';
  query.previewContent = null;
  query.pathTokens = null;
  query.locateResult = null;
  query.clauseCount = 0;
  query.termCount = 0;
  query.clauses = [];
  updateQueryBar(tab);

  try {
    const result = await workerBridge.filterLog(source, rawQuery);
    // Guard: query may have changed while worker was running
    if (query.text !== rawQuery) return;

    query.totalCount = result.totalCount;
    query.resultCount = result.resultCount;
    query.previewContent = result.error ? null : result.filteredLines.join('\n');
    query.clauseCount = result.clauseCount || 0;
    query.termCount = result.termCount || 0;
    query.clauses = result.clauses || [];
    query.error = result.error || '';
    query.busy = false;

    if (state.activeTabId === tab.id) showEditor(tab.id);
    updateQueryBar(tab);
  } catch (err) {
    if (err.message === 'cancelled') return;
    query.error = err.message;
    query.busy = false;
    updateQueryBar(tab);
  }
}

async function applyJsonQuery(tab, rawQuery) {
  const query = ensureQueryState(tab);
  const source = getTabSourceContent(tab);
  query.previewContent = null;
  query.totalCount = 1;
  query.resultCount = 0;
  query.pathTokens = null;
  query.clauseCount = 0;
  query.termCount = 0;
  query.clauses = [];
  query.error = '';
  query.locateResult = null;

  let data;
  try {
    data = JSON.parse(source);
  } catch {
    query.active = true;
    query.error = 'JSON parsing failed for query mode.';
    return;
  }

  const tokens = parseJsonPathTokens(rawQuery);
  if (tokens.length === 0) {
    query.active = true;
    query.error = 'Use JSON path syntax like stats.errors or nodes[1].status';
    return;
  }

  const resolved = resolveJsonPathValue(data, tokens);
  query.pathTokens = tokens;
  query.resultCount = resolved.found ? 1 : 0;
  if (!resolved.found) {
    query.error = `Path not found: ${rawQuery}`;
  }
  query.active = true;

  // Async: locate exact position in background (this is the slow part)
  if (resolved.found) {
    query.busy = true;
    if (state.activeTabId === tab.id) showEditor(tab.id);
    updateQueryBar(tab);

    try {
      const locate = await workerBridge.jsonLocate(source, tokens);
      if (query.text !== rawQuery) return;
      query.locateResult = locate;
      query.busy = false;
      if (state.activeTabId === tab.id) applyQueryViewEffects(tab);
      updateQueryBar(tab);
    } catch (err) {
      if (err.message === 'cancelled') return;
      query.busy = false;
      updateQueryBar(tab);
    }
  }
}

function applyQueryToTab(tab, rawQuery) {
  if (!tab) return;
  const query = ensureQueryState(tab);
  const text = (rawQuery || '').trim();
  query.text = rawQuery || '';
  query.error = '';
  query.pathTokens = null;
  query.resultCount = null;
  query.totalCount = null;
  query.previewContent = null;
  query.locateResult = null;
  query.busy = false;
  query.clauseCount = 0;
  query.termCount = 0;
  query.clauses = [];

  if (!text) {
    query.active = false;
    if (state.activeTabId === tab.id) showEditor(tab.id);
    updateQueryBar(tab);
    scheduleSessionSave();
    return;
  }

  if (isJsonTab(tab)) applyJsonQuery(tab, text);
  else if (isLogLikeTab(tab)) applyLogQuery(tab, text);
  else query.active = false;
  scheduleSessionSave();

  if (state.activeTabId === tab.id) showEditor(tab.id);
  updateQueryBar(tab);
}

function highlightJsonPathInTree(pathTokens) {
  const root = document.querySelector('#editor-container .json-viewer-container');
  if (!root) return;
  root.querySelectorAll('.json-node.query-highlight').forEach(el => el.classList.remove('query-highlight'));

  const encodedPath = pathTokens.map(token => encodeURIComponent(String(token))).join('/');
  const target = [...root.querySelectorAll('.json-node')].find(node => node.dataset.path === encodedPath);
  if (!target) return;

  target.classList.add('query-highlight');
  let parent = target.parentElement;
  while (parent) {
    if (parent.classList?.contains('json-children') && parent.classList.contains('hidden')) {
      parent.classList.remove('hidden');
      const ownerNode = parent.parentElement;
      const arrow = ownerNode?.querySelector(':scope > .json-line > .json-arrow');
      const size = ownerNode?.querySelector(':scope > .json-line > .json-size');
      const closePreview = ownerNode?.querySelector(':scope > .json-line > .json-close-preview');
      if (arrow) {
        arrow.classList.add('expanded');
        arrow.textContent = '▼';
      }
      if (size) size.classList.remove('visible');
      if (closePreview) closePreview.classList.add('hidden');
    }
    parent = parent.parentElement;
  }

  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function jumpToJsonPathInCode(tab, pathTokens) {
  if (!tab?.editorView || !pathTokens?.length) return;
  const query = ensureQueryState(tab);
  const precise = query.locateResult;
  if (precise) {
    tab.editorView.dispatch({
      selection: { anchor: precise.from, head: precise.to },
      scrollIntoView: true,
    });
    tab.editorView.focus();
    return;
  }

  // Fallback: simple text search for the last token
  const docText = tab.editorView.state.doc.toString();
  const fallback = String(pathTokens[pathTokens.length - 1]);
  const idx = docText.indexOf(`"${fallback}"`);
  if (idx < 0) return;
  tab.editorView.dispatch({
    selection: { anchor: idx, head: idx + fallback.length + 2 },
    scrollIntoView: true,
  });
  tab.editorView.focus();
}

function applyQueryViewEffects(tab) {
  const query = ensureQueryState(tab);
  if (!query.active || !isJsonTab(tab) || !query.pathTokens?.length) return;

  if (tab.viewMode === 'tree') highlightJsonPathInTree(query.pathTokens);
  else jumpToJsonPathInCode(tab, query.pathTokens);
}

let queryInputTimer = null;

function focusQueryInput() {
  const bar = document.getElementById('query-bar');
  const input = document.getElementById('query-input');
  if (!bar || !input || bar.classList.contains('hidden')) return;
  input.focus();
  input.select();
}

function persistSavedLogFilters() {
  localStorage.setItem('crabtree-saved-log-filters', JSON.stringify(state.savedLogFilters.slice(0, 20)));
}

function updateSavedLogFiltersUI() {
  const select = document.getElementById('query-saved');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Saved...';
  select.appendChild(placeholder);
  state.savedLogFilters.forEach((filter) => {
    const option = document.createElement('option');
    option.value = filter;
    option.textContent = filter.length > 64 ? `${filter.slice(0, 61)}...` : filter;
    select.appendChild(option);
  });
  if (current && state.savedLogFilters.includes(current)) select.value = current;
}

function saveCurrentLogFilter() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab || !isLogLikeTab(tab)) {
    alert('Saved filters are available for log files.');
    return;
  }
  const query = ensureQueryState(tab);
  const value = (query.text || '').trim();
  if (!value) {
    alert('Enter a filter query first.');
    return;
  }
  state.savedLogFilters = state.savedLogFilters.filter(item => item !== value);
  state.savedLogFilters.unshift(value);
  state.savedLogFilters = state.savedLogFilters.slice(0, 20);
  persistSavedLogFilters();
  updateSavedLogFiltersUI();
  const select = document.getElementById('query-saved');
  if (select) select.value = value;
}

function normalizeJsonPathBase(raw) {
  const input = (raw || '').trim();
  if (!input) return '';
  if (input.endsWith('.')) return input.slice(0, -1);
  const bracket = input.match(/^(.*)\[(\d*)$/);
  if (bracket) return bracket[1];
  const dot = input.lastIndexOf('.');
  if (dot >= 0) return input.slice(0, dot);
  return '';
}

function collectJsonPaths(node, out, path = [], depth = 0) {
  if (out.length >= 500 || depth > 7 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    const len = Math.min(node.length, 20);
    for (let i = 0; i < len; i++) {
      const childPath = [...path, String(i)];
      out.push(childPath.map((token, idx) => (idx === 0 ? token : token.match(/^\d+$/) ? `[${token}]` : `.${token}`)).join(''));
      collectJsonPaths(node[i], out, childPath, depth + 1);
      if (out.length >= 500) return;
    }
    return;
  }
  if (typeof node !== 'object') return;

  const keys = Object.keys(node).slice(0, 80);
  for (const key of keys) {
    const childPath = [...path, key];
    out.push(childPath.map((token, idx) => (idx === 0 ? token : token.match(/^\d+$/) ? `[${token}]` : `.${token}`)).join(''));
    collectJsonPaths(node[key], out, childPath, depth + 1);
    if (out.length >= 500) return;
  }
}

function getJsonPathCatalog(tab) {
  const query = ensureQueryState(tab);
  const source = getTabSourceContent(tab);
  const signature = `${source.length}:${source.slice(0, 80)}:${source.slice(-80)}`;
  if (query.pathCatalogSignature === signature && Array.isArray(query.pathCatalog) && query.pathCatalog.length > 0) {
    return query.pathCatalog;
  }

  try {
    const parsed = JSON.parse(source);
    const paths = [];
    collectJsonPaths(parsed, paths);
    query.pathCatalogSignature = signature;
    query.pathCatalog = paths;
    return paths;
  } catch {
    query.pathCatalogSignature = signature;
    query.pathCatalog = [];
    return [];
  }
}

function updateJsonSuggestions(tab, rawInput) {
  const dataList = document.getElementById('query-suggestions');
  if (!dataList) return;
  if (!tab || !isJsonTab(tab)) {
    dataList.innerHTML = '';
    return;
  }

  const input = (rawInput || '').trim();
  const base = normalizeJsonPathBase(input);
  const prefix = input || base;
  const paths = getJsonPathCatalog(tab);
  if (!paths.length) {
    dataList.innerHTML = '';
    return;
  }

  const candidates = paths
    .filter(path => (prefix ? path.startsWith(prefix) || path.startsWith(base) : true))
    .slice(0, 24);
  dataList.innerHTML = candidates.map(item => `<option value="${escapeHtml(item)}"></option>`).join('');
}

function renderQueryParseBar(tab) {
  const parseBar = document.getElementById('query-parsebar');
  const summary = document.getElementById('query-parse-summary');
  const tokenList = document.getElementById('query-token-list');
  if (!parseBar || !summary || !tokenList) return;

  if (!tab || !isLogLikeTab(tab)) {
    parseBar.classList.add('hidden');
    summary.textContent = '';
    tokenList.innerHTML = '';
    return;
  }

  const query = ensureQueryState(tab);
  if (!query.text || !query.active) {
    parseBar.classList.add('hidden');
    summary.textContent = '';
    tokenList.innerHTML = '';
    return;
  }

  parseBar.classList.remove('hidden');
  if (query.error) {
    summary.textContent = 'Filter parse failed';
    tokenList.innerHTML = '';
    return;
  }

  summary.textContent = `${query.clauseCount || 0} clause(s), ${query.termCount || 0} term(s)`;
  const chips = [];
  (query.clauses || []).forEach((clause, idx) => {
    if (idx > 0) chips.push('<span class="query-token operator">OR</span>');
    clause.forEach((cond, condIdx) => {
      if (condIdx > 0) chips.push('<span class="query-token operator">AND</span>');
      const cls = cond.negate ? 'query-token negated' : 'query-token';
      const token = cond.negate ? `NOT ${escapeHtml(cond.token)}` : escapeHtml(cond.token);
      chips.push(`<span class="${cls}">${token}</span>`);
    });
  });
  tokenList.innerHTML = chips.join('');
}

function updateQueryBar(tab) {
  const bar = document.getElementById('query-bar');
  const input = document.getElementById('query-input');
  const prefix = document.getElementById('query-prefix');
  const meta = document.getElementById('query-meta');
  const saveBtn = document.getElementById('query-save');
  const savedSelect = document.getElementById('query-saved');
  const clearBtn = document.getElementById('query-clear');
  if (!bar || !input || !prefix || !meta || !clearBtn || !saveBtn || !savedSelect) return;

  if (!tab || !isQueryableTab(tab)) {
    bar.classList.add('hidden');
    meta.classList.remove('error');
    meta.textContent = '';
    saveBtn.classList.add('hidden');
    savedSelect.classList.add('hidden');
    updateJsonSuggestions(null, '');
    renderQueryParseBar(null);
    return;
  }

  const query = ensureQueryState(tab);
  bar.classList.remove('hidden');
  const jsonMode = isJsonTab(tab);
  const logMode = isLogLikeTab(tab);
  prefix.textContent = jsonMode ? 'JSON Path' : 'Log Filter';
  input.placeholder = jsonMode
    ? 'e.g. stats.errors or nodes[1].status'
    : 'e.g. severity:error AND ip:127.0.0.1 OR NOT text:"health check"';
  if (input.value !== query.text) input.value = query.text || '';

  saveBtn.classList.toggle('hidden', !logMode);
  savedSelect.classList.toggle('hidden', !logMode);
  if (logMode) updateSavedLogFiltersUI();

  if (query.error) {
    meta.textContent = query.error;
  } else if (query.busy) {
    meta.textContent = jsonMode ? 'Locating path…' : 'Filtering…';
  } else if (query.active && query.resultCount !== null) {
    if (jsonMode && query.resultCount > 0 && Array.isArray(query.pathTokens) && query.pathTokens.length > 0) {
      const precise = query.locateResult;
      if (precise) meta.textContent = `Path found at Ln ${precise.line}, Col ${precise.col}`;
      else meta.textContent = `${query.resultCount} / ${query.totalCount} matches`;
    } else if (!jsonMode && query.clauseCount > 0) {
      const suffix = `${query.clauseCount}c/${query.termCount}t`;
      if (query.totalCount !== null) meta.textContent = `${query.resultCount} / ${query.totalCount} (${suffix})`;
      else meta.textContent = `${query.resultCount} matches (${suffix})`;
    } else if (query.totalCount !== null) meta.textContent = `${query.resultCount} / ${query.totalCount} matches`;
    else meta.textContent = `${query.resultCount} matches`;
  } else {
    meta.textContent = jsonMode
      ? 'Path lookup mode'
      : 'Supports AND / OR / NOT, plus fields: severity, ip, text, re';
  }
  meta.classList.toggle('error', Boolean(query.error));
  meta.classList.toggle('busy', Boolean(query.busy));

  clearBtn.disabled = !query.text;
  updateJsonSuggestions(tab, query.text || '');
  renderQueryParseBar(tab);
}

function setupQueryBar() {
  const input = document.getElementById('query-input');
  const clearBtn = document.getElementById('query-clear');
  const saveBtn = document.getElementById('query-save');
  const savedSelect = document.getElementById('query-saved');
  if (!input || !clearBtn || !saveBtn || !savedSelect) return;

  input.addEventListener('input', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab || !isQueryableTab(tab)) return;
    if (isJsonTab(tab)) updateJsonSuggestions(tab, input.value);
    clearTimeout(queryInputTimer);
    queryInputTimer = setTimeout(() => {
      applyQueryToTab(tab, input.value);
    }, 120);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (!tab || !isQueryableTab(tab)) return;
      e.preventDefault();
      applyQueryToTab(tab, input.value);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (!tab) return;
      applyQueryToTab(tab, '');
      input.blur();
    }
  });

  clearBtn.addEventListener('click', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab) return;
    input.value = '';
    applyQueryToTab(tab, '');
    input.focus();
  });

  saveBtn.addEventListener('click', () => {
    saveCurrentLogFilter();
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab) updateQueryBar(tab);
  });

  savedSelect.addEventListener('change', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab || !isLogLikeTab(tab)) return;
    if (!savedSelect.value) return;
    input.value = savedSelect.value;
    applyQueryToTab(tab, savedSelect.value);
    input.focus();
  });
}

function clearActiveQuery() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;
  applyQueryToTab(tab, '');
}

async function exportFilteredResults(format = 'text') {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab || !isLogLikeTab(tab)) {
    alert('Open a log file to export filtered results.');
    return;
  }

  const query = ensureQueryState(tab);
  if (!query.active || query.previewContent === null) {
    alert('Run a log filter query first.');
    return;
  }

  let exportContent = query.previewContent;
  let defaultExt = 'log';
  const lines = query.previewContent.split(/\r?\n/).filter(l => l.trim());

  if (format === 'json') {
    exportContent = JSON.stringify(lines, null, 2);
    defaultExt = 'json';
  } else if (format === 'csv') {
    exportContent = 'line_number,content\n' + lines.map((l, i) => `${i + 1},"${l.replace(/"/g, '""')}"`).join('\n');
    defaultExt = 'csv';
  }

  try {
    const selected = await save({
      filters: [
        { name: 'Log Files', extensions: ['log', 'txt'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (!selected) return;
    const filePath = typeof selected === 'string' ? selected : selected.path;
    await invoke('approve_path', { path: filePath }).catch(err => console.warn('Failed to approve path:', err));
    await invoke('save_file', { path: filePath, content: exportContent });
  } catch (err) {
    console.error('Export filtered results error:', err);
    alert(`Export failed: ${err.message}`);
  }
}

function applyMostRecentSavedFilter() {
  if (state.savedLogFilters.length === 0) {
    alert('No saved log filters yet.');
    return;
  }
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab || !isLogLikeTab(tab)) {
    alert('Open a log file to apply saved filters.');
    return;
  }
  const latest = state.savedLogFilters[0];
  const input = document.getElementById('query-input');
  if (input) input.value = latest;
  applyQueryToTab(tab, latest);
}

function showBenchmarkHelp() {
  alert('Run `npm run benchmark` in the project terminal.\nResults will be written to benchmark/latest.json and benchmark/latest.md.');
}

// ─── Data Analyzer ───
function closeAnalysisModal() {
  document.getElementById('analysis-overlay')?.remove();
}

function showDataAnalysis() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;

  syncTabContentFromEditor(tab);

  const result = DataAnalyzer.analyze(tab.content, tab.language || 'plaintext');
  closeAnalysisModal();

  const overlay = document.createElement('div');
  overlay.id = 'analysis-overlay';
  overlay.className = 'analysis-overlay';

  const modal = document.createElement('div');
  modal.className = 'analysis-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'analysis-header';
  const title = document.createElement('h3');
  title.textContent = 'Data Analysis';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'dialog-btn secondary';
  closeBtn.id = 'analysis-close-btn';
  closeBtn.textContent = 'Close';
  header.appendChild(title);
  header.appendChild(closeBtn);

  // Content
  const content = document.createElement('div');
  content.className = 'analysis-content';

  const statGrid = document.createElement('div');
  statGrid.className = 'stat-grid';

  // Stats rows  
  const addStat = (label, value) => {
    const item = document.createElement('div');
    item.className = 'stat-item';
    const lblEl = document.createElement('div');
    lblEl.className = 'stat-label';
    lblEl.textContent = label;
    const valEl = document.createElement('div');
    valEl.className = 'stat-value';
    valEl.textContent = value;
    item.appendChild(lblEl);
    item.appendChild(valEl);
    statGrid.appendChild(item);
  };

  addStat('Type', result.type || 'Unknown');
  addStat('Lines', String(result.lines));
  addStat('Size', formatSize(result.size));
  addStat('Language', formatLanguage(tab.language || 'plaintext'));

  // Insights list (safely rendered)
  const insightList = document.createElement('div');
  insightList.className = 'insight-list';

  if (result.insights && result.insights.length > 0) {
    result.insights.forEach(insight => {
      const item = document.createElement('div');
      item.className = 'insight-item';
      // safely render: insights may contain HTML tags, so we parse them carefully
      // For now, use textContent to be safe, or use a simple parser
      item.innerHTML = escapeHtml(insight); // Escape first, then use innerHTML to allow existing <strong> tags
      insightList.appendChild(item);
    });
  } else {
    const noInsights = document.createElement('div');
    noInsights.className = 'insight-item';
    noInsights.textContent = 'No insights available.';
    insightList.appendChild(noInsights);
  }

  content.appendChild(statGrid);
  content.appendChild(insightList);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'analysis-footer';
  const okBtn = document.createElement('button');
  okBtn.className = 'dialog-btn primary';
  okBtn.id = 'analysis-ok-btn';
  okBtn.textContent = 'OK';
  footer.appendChild(okBtn);

  modal.appendChild(header);
  modal.appendChild(content);
  modal.appendChild(footer);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeAnalysisModal();
  });

  document.body.appendChild(overlay);
  document.getElementById('analysis-close-btn')?.addEventListener('click', closeAnalysisModal);
  document.getElementById('analysis-ok-btn')?.addEventListener('click', closeAnalysisModal);
}

// ─── File Operations ───
function newFile() {
  state.untitledCounter++;
  const id = ++tabIdCounter;
  const tab = {
    id, path: null, name: `Untitled-${state.untitledCounter}`,
    content: '', encoding: 'UTF-8', language: 'plaintext',
    lineEnding: 'CRLF', size: 0, modified: false, pinned: false,
    readOnly: false,
    largeFileMode: false,
    progressive: false,
    fullContent: null,
    loadedChars: 0,
    query: {
      text: '',
      active: false,
      busy: false,
      previewContent: null,
      resultCount: null,
      totalCount: null,
      error: '',
      pathTokens: null,
      locateResult: null,
      clauseCount: 0,
      termCount: 0,
      clauses: [],
      pathCatalogSignature: '',
      pathCatalog: [],
    },
    editorView: null,
  };
  state.tabs.push(tab);
  renderTab(tab);
  switchToTab(id);
  document.getElementById('welcome-screen').classList.add('hidden');
  updateStatusBar(tab);
}

async function openFile() {
  try {
    const selected = await open({
      multiple: false,
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Data Files', extensions: ['json', 'log', 'csv', 'tsv', 'txt'] },
        { name: 'Text Files', extensions: ['txt', 'md', 'log', 'csv', 'tsv'] },
        { name: 'Code Files', extensions: ['js', 'ts', 'py', 'rs', 'cpp', 'c', 'java', 'html', 'css', 'json', 'xml'] },
      ]
    });
    if (!selected) return;
    const filePath = typeof selected === 'string' ? selected : selected.path;
    await invoke('approve_path', { path: filePath }).catch(err => console.warn('Failed to approve path:', err));
    const existing = state.tabs.find(t => t.path === filePath);
    if (existing) { switchToTab(existing.id); return; }
    const fileData = await invoke('read_file', { path: filePath });
    createTab(fileData);
  } catch (err) { console.error('Open file error:', err); }
}

async function saveFile() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;
  if (tab.readOnly) {
    alert('This file is in read-only safety mode. Use "Load Full File" from the safety banner (when available) before saving edits.');
    return;
  }
  syncTabContentFromEditor(tab);
  if (!tab.path) return saveFileAs();
  try {
    await invoke('save_file', { path: tab.path, content: tab.content });
    tab.modified = false;
    updateTabUI(tab);
  } catch (err) { console.error('Save error:', err); }
}

async function saveFileAs() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;
  if (tab.readOnly) {
    alert('This file is in read-only safety mode. Use "Load Full File" from the safety banner (when available) before saving edits.');
    return;
  }
  syncTabContentFromEditor(tab);
  try {
    const selected = await save({ filters: [{ name: 'All Files', extensions: ['*'] }] });
    if (!selected) return;
    const filePath = typeof selected === 'string' ? selected : selected.path;
    await invoke('approve_path', { path: filePath }).catch(err => console.warn('Failed to approve path:', err));
    await invoke('save_file', { path: filePath, content: tab.content });
    tab.path = filePath;
    tab.name = filePath.split(/[\\/]/).pop();
    tab.modified = false;
    const el = document.querySelector(`.tab[data-id="${tab.id}"] .tab-name`);
    if (el) el.textContent = tab.name;
    updateTabUI(tab);
    updateStatusBar(tab);
    addRecentFile(tab.path, tab.name);
    const lang = await invoke('get_file_language', { fileName: tab.name });
    const lowerName = tab.name.toLowerCase();
    if (lowerName.endsWith('.log')) tab.language = 'log';
    else if (lowerName.endsWith('.csv') || lowerName.endsWith('.tsv')) tab.language = 'csv';
    else tab.language = lang;
    if (!isJsonTab(tab) && tab.viewMode === 'tree') tab.viewMode = 'code';
    if (isCsvTab(tab) && tab.viewMode === 'code') tab.viewMode = 'table';
    syncTabContentFromEditor(tab);
    if (state.activeTabId === tab.id) showEditor(tab.id);
    updateStatusBar(tab);
  } catch (err) { console.error('Save As error:', err); }
}

// ─── Folder / Sidebar ───
async function openFolder() {
  try {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    const folderPath = typeof selected === 'string' ? selected : selected.path;
    await invoke('approve_path', { path: folderPath }).catch(err => console.warn('Failed to approve path:', err));
    state.folderPath = folderPath;
    const entries = await invoke('list_directory', { path: folderPath });
    state.folderEntries = entries;
    renderFileTree(entries);
  } catch (err) { console.error('Open folder error:', err); }
}

function renderFileTree(entries, container, depth) {
  if (depth === undefined) depth = 0;
  if (!container) {
    container = document.getElementById('file-tree');
    container.innerHTML = '';
  }
  entries.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.paddingLeft = `${12 + depth * 16}px`;
    const iconHtml = renderFileIcon(entry.name, entry.is_dir);
    const fileColor = getFileColor(entry.name);

    if (entry.is_dir) {
      const arrow = document.createElement('span');
      arrow.className = 'tree-arrow'; arrow.textContent = '▶';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'tree-icon'; iconSpan.innerHTML = iconHtml;
      const nameSpan = document.createElement('span');
      nameSpan.className = 'tree-name dir-name';
      nameSpan.textContent = entry.name;
      item.append(arrow, iconSpan, nameSpan);

      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children';
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        arrow.classList.toggle('expanded');
        childContainer.classList.toggle('expanded');
        if (childContainer.classList.contains('expanded') && !childContainer.children.length && entry.children) {
          renderFileTree(entry.children, childContainer, depth + 1);
        }
      });
      container.append(item, childContainer);
    } else {
      const spacer = document.createElement('span');
      spacer.style.cssText = 'width:16px;flex-shrink:0;display:inline-block';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'tree-icon'; iconSpan.innerHTML = iconHtml;
      const nameSpan = document.createElement('span');
      nameSpan.className = 'tree-name';
      nameSpan.style.color = fileColor;
      nameSpan.textContent = entry.name;
      item.append(spacer, iconSpan, nameSpan);
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const existing = state.tabs.find(t => t.path === entry.path);
        if (existing) { switchToTab(existing.id); return; }
        try { createTab(await invoke('read_file', { path: entry.path })); }
        catch (err) { console.error('Error opening file:', err); }
      });
      container.appendChild(item);
    }
  });
}

// ─── File Icon & Color System (Zed-inspired) ───
const FILE_TYPE_MAP = {
  // JavaScript / TypeScript
  js: { icon: 'JS', color: '#f7df1e', group: 'script' },
  mjs: { icon: 'MJ', color: '#f7df1e', group: 'script' },
  cjs: { icon: 'CJ', color: '#f7df1e', group: 'script' },
  jsx: { icon: 'JX', color: '#61dafb', group: 'script' },
  ts: { icon: 'TS', color: '#3178c6', group: 'script' },
  tsx: { icon: 'TX', color: '#3178c6', group: 'script' },
  vue: { icon: 'V', color: '#42b883', group: 'script' },
  svelte: { icon: 'SV', color: '#ff3e00', group: 'script' },

  // Systems
  rs: { icon: 'RS', color: '#dea584', group: 'script' },
  go: { icon: 'GO', color: '#00add8', group: 'script' },
  c: { icon: 'C', color: '#555555', group: 'script' },
  cpp: { icon: 'C+', color: '#f34b7d', group: 'script' },
  h: { icon: 'H', color: '#a074c4', group: 'script' },
  hpp: { icon: 'H+', color: '#a074c4', group: 'script' },
  cs: { icon: 'C#', color: '#178600', group: 'script' },

  // Scripting
  py: { icon: 'PY', color: '#3572a5', group: 'script' },
  rb: { icon: 'RB', color: '#cc342d', group: 'script' },
  php: { icon: 'PH', color: '#4f5d95', group: 'script' },
  java: { icon: 'JA', color: '#b07219', group: 'script' },
  kt: { icon: 'KT', color: '#a97bff', group: 'script' },
  swift: { icon: 'SW', color: '#f05138', group: 'script' },
  dart: { icon: 'DA', color: '#00b4ab', group: 'script' },
  lua: { icon: 'LU', color: '#000080', group: 'script' },
  r: { icon: 'R', color: '#198ce7', group: 'script' },
  scala: { icon: 'SC', color: '#dc322f', group: 'script' },
  zig: { icon: 'ZG', color: '#ec915c', group: 'script' },

  // Web
  html: { icon: '', color: '#e34c26', group: 'web' },
  htm: { icon: '', color: '#e34c26', group: 'web' },
  css: { icon: '', color: '#563d7c', group: 'style' },
  scss: { icon: '', color: '#c6538c', group: 'style' },
  sass: { icon: '', color: '#c6538c', group: 'style' },
  less: { icon: '', color: '#1d365d', group: 'style' },

  // Data
  json: { icon: '{}', color: '#f7df1e', group: 'data' },
  jsonc: { icon: '{}', color: '#f7df1e', group: 'data' },
  json5: { icon: '{}', color: '#f7df1e', group: 'data' },
  xml: { icon: '<>', color: '#e37933', group: 'data' },
  csv: { icon: ',,', color: '#237346', group: 'data' },
  tsv: { icon: '⇥', color: '#237346', group: 'data' },
  sql: { icon: 'SQ', color: '#e38c00', group: 'data' },
  graphql: { icon: 'GQ', color: '#e535ab', group: 'data' },
  prisma: { icon: 'PR', color: '#2d3748', group: 'data' },

  // Config
  yaml: { icon: 'YA', color: '#cb171e', group: 'config' },
  yml: { icon: 'YA', color: '#cb171e', group: 'config' },
  toml: { icon: 'TM', color: '#9c4221', group: 'config' },
  ini: { icon: 'IN', color: '#a074c4', group: 'config' },
  env: { icon: 'EN', color: '#ecd53f', group: 'config' },
  properties: { icon: 'PR', color: '#2d6cdf', group: 'config' },

  // Shell
  sh: { icon: '$_', color: '#89e051', group: 'shell' },
  bash: { icon: '$_', color: '#89e051', group: 'shell' },
  zsh: { icon: '$_', color: '#89e051', group: 'shell' },
  fish: { icon: '$_', color: '#89e051', group: 'shell' },
  bat: { icon: '>_', color: '#c1f12e', group: 'shell' },
  cmd: { icon: '>_', color: '#c1f12e', group: 'shell' },
  ps1: { icon: 'PS', color: '#012456', group: 'shell' },

  // Docs
  md: { icon: 'M↓', color: '#083fa1', group: 'doc' },
  mdx: { icon: 'MX', color: '#083fa1', group: 'doc' },
  txt: { icon: 'Tx', color: '#a9b1d6', group: 'doc' },
  rst: { icon: 'RS', color: '#141414', group: 'doc' },
  tex: { icon: 'TX', color: '#3d6117', group: 'doc' },

  // Log
  log: { icon: '▤', color: '#e0af68', group: 'log' },

  // Images
  png: { icon: '◻', color: '#a074c4', group: 'image' },
  jpg: { icon: '◻', color: '#a074c4', group: 'image' },
  jpeg: { icon: '◻', color: '#a074c4', group: 'image' },
  gif: { icon: '◻', color: '#a074c4', group: 'image' },
  webp: { icon: '◻', color: '#a074c4', group: 'image' },
  svg: { icon: '◇', color: '#ff9a00', group: 'image' },
  ico: { icon: '◻', color: '#a074c4', group: 'image' },

  // Binary / Archive
  zip: { icon: '⊞', color: '#e38c00', group: 'archive' },
  tar: { icon: '⊞', color: '#e38c00', group: 'archive' },
  gz: { icon: '⊞', color: '#e38c00', group: 'archive' },
  pdf: { icon: 'PF', color: '#ec2025', group: 'archive' },
  wasm: { icon: 'WA', color: '#654ff0', group: 'binary' },

  // Lock / Generated
  lock: { icon: '🔒', color: '#565f89', group: 'lock' },
  map: { icon: '◎', color: '#565f89', group: 'generated' },
  min: { icon: '▬', color: '#565f89', group: 'generated' },

  // Git
  gitignore: { icon: 'GI', color: '#f05032', group: 'git' },
  gitattributes: { icon: 'GA', color: '#f05032', group: 'git' },

  // Docker / CI
  dockerfile: { icon: '🐋', color: '#384d54', group: 'devops' },
  dockerignore: { icon: 'DI', color: '#384d54', group: 'devops' },
};

// Special full-name matches
const FILE_NAME_MAP = {
  'package.json': { icon: '{}', color: '#cb3837', group: 'config' },
  'tsconfig.json': { icon: 'TS', color: '#3178c6', group: 'config' },
  'vite.config.js': { icon: '⚡', color: '#646cff', group: 'config' },
  'webpack.config.js': { icon: 'WP', color: '#8dd6f9', group: 'config' },
  'Cargo.toml': { icon: '🦀', color: '#dea584', group: 'config' },
  'Cargo.lock': { icon: '🔒', color: '#dea584', group: 'lock' },
  'Makefile': { icon: 'MK', color: '#427819', group: 'config' },
  'Dockerfile': { icon: '🐋', color: '#384d54', group: 'devops' },
  'LICENSE': { icon: '§', color: '#d4a52a', group: 'doc' },
  'README.md': { icon: '📖', color: '#083fa1', group: 'doc' },
  '.env': { icon: 'EN', color: '#ecd53f', group: 'config' },
  '.gitignore': { icon: 'GI', color: '#f05032', group: 'git' },
};

function getFileIcon(name, isDir) {
  if (isDir) return { icon: '📁', color: '#7aa2f7', group: 'dir' };
  // Check full name match first
  const nameMatch = FILE_NAME_MAP[name];
  if (nameMatch) return nameMatch;
  // Then extension
  const ext = name.split('.').pop().toLowerCase();
  return FILE_TYPE_MAP[ext] || { icon: '📄', color: '#a9b1d6', group: 'file' };
}

function renderFileIcon(name, isDir) {
  const { icon, color } = getFileIcon(name, isDir);
  if (icon.length <= 2 && !icon.includes('📁') && !icon.includes('📄') && !icon.includes('🦀') && !icon.includes('🐋') && !icon.includes('⚡') && !icon.includes('📖') && !icon.includes('🔒')) {
    return `<span class="file-icon-badge" style="--fi-color:${color}">${icon}</span>`;
  }
  return icon;
}

function getFileColor(name) {
  if (!name) return '#a9b1d6';
  const { color } = getFileIcon(name, false);
  return color;
}

// ─── Go to Line ───
function showGoToLine() {
  document.getElementById('goto-dialog').classList.remove('hidden');
  const input = document.getElementById('goto-input');
  input.value = ''; input.focus();
}
function hideGoToLine() { document.getElementById('goto-dialog').classList.add('hidden'); }
function goToLine() {
  const lineNum = parseInt(document.getElementById('goto-input').value);
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!lineNum || !tab || !tab.editorView) { hideGoToLine(); return; }
  const doc = tab.editorView.state.doc;
  const line = doc.line(Math.min(Math.max(1, lineNum), doc.lines));
  tab.editorView.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  tab.editorView.focus();
  hideGoToLine();
}

// ─── Drag & Drop ───
function setupDragDrop() {
  const body = document.body;
  body.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); body.classList.add('drag-over'); });
  body.addEventListener('dragleave', (e) => { e.preventDefault(); body.classList.remove('drag-over'); });
  body.addEventListener('drop', async (e) => {
    e.preventDefault();
    body.classList.remove('drag-over');
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    for (const file of files) {
      const path = file.path || file.name;
      if (!path) continue;
      const existing = state.tabs.find(t => t.path === path);
      if (existing) { switchToTab(existing.id); continue; }
      try { createTab(await invoke('read_file', { path })); }
      catch (err) { console.error('Drop open error:', err); }
    }
  });
}

// ─── Helpers ───
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatLanguage(lang) {
  const names = {
    javascript: 'JavaScript', typescript: 'TypeScript', jsx: 'JSX', tsx: 'TSX',
    python: 'Python', rust: 'Rust', html: 'HTML', css: 'CSS', json: 'JSON', xml: 'XML', csv: 'CSV',
    markdown: 'Markdown', sql: 'SQL', cpp: 'C++', c: 'C', java: 'Java',
    csharp: 'C#', go: 'Go', ruby: 'Ruby', php: 'PHP', swift: 'Swift', kotlin: 'Kotlin',
    scala: 'Scala', r: 'R', yaml: 'YAML', toml: 'TOML',
    shell: 'Shell', powershell: 'PowerShell', plaintext: 'Plain Text',
  };
  return names[lang] || lang || 'Plain Text';
}

// ─── Keyboard Shortcuts ───
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'n') { e.preventDefault(); newFile(); }
  if (e.ctrlKey && e.key === 'o') { e.preventDefault(); openFile(); }
  if (e.ctrlKey && !e.shiftKey && e.key === 's') { e.preventDefault(); saveFile(); }
  if (e.ctrlKey && e.shiftKey && e.key === 'S') { e.preventDefault(); saveFileAs(); }
  if (e.ctrlKey && e.key === 'w') { e.preventDefault(); if (state.activeTabId) closeTab(state.activeTabId); }
  if (e.ctrlKey && e.key === 'g') { e.preventDefault(); showGoToLine(); }
  if (e.ctrlKey && e.shiftKey && e.key === 'P') { e.preventDefault(); commandPalette.open(); }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); focusQueryInput(); }
  if (e.key === 'Escape') {
    hideGoToLine();
    closeAnalysisModal();
    closeGlobalSearch();
    closeRegexBuilder();
    closeCheatsheet();
    if (closeDialogResolve) resolveCloseDialog('cancel');
  }
  if (e.ctrlKey && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
  // Tab cycling: Ctrl+Tab forward, Ctrl+Shift+Tab backward
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const idx = state.tabs.findIndex(t => t.id === state.activeTabId);
    if (state.tabs.length > 1) {
      const next = e.shiftKey
        ? (idx - 1 + state.tabs.length) % state.tabs.length
        : (idx + 1) % state.tabs.length;
      switchToTab(state.tabs[next].id);
    }
  }
  // Global search
  if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); toggleGlobalSearch(); }
  // Problems panel
  if (e.ctrlKey && e.shiftKey && e.key === 'E') { e.preventDefault(); toggleProblemsPanel(); }
  // File finder
  if (e.ctrlKey && e.key === 'p') { e.preventDefault(); toggleFileFinder(); }
  // Minimap
  if (e.ctrlKey && e.key === 'm') { e.preventDefault(); toggleMinimap(); }
  // Keyboard cheatsheet
  if (e.ctrlKey && e.key === '/') { e.preventDefault(); toggleCheatsheet(); }
  // Font size
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); setFontSize(state.fontSize + 1); }
  if (e.ctrlKey && e.key === '-') { e.preventDefault(); setFontSize(state.fontSize - 1); }
  if (e.ctrlKey && e.key === '0') { e.preventDefault(); setFontSize(14); }
});


function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('collapsed', !state.sidebarOpen);
  if (state.sidebarOpen) {
    sidebar.style.width = (state.sidebarWidth || 240) + 'px';
  }
  // Status bar sidebar badge
  const badge = document.getElementById('status-sidebar-badge');
  if (badge) badge.classList.toggle('hidden', state.sidebarOpen);
}

function setupSidebarResize() {
  const handle = document.getElementById('sidebar-resize-handle');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;

  let startX, startWidth;

  handle.addEventListener('mousedown', (e) => {
    if (!state.sidebarOpen) return;
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    handle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e) => {
      const dx = e.clientX - startX;
      const newWidth = Math.min(Math.max(startWidth + dx, 140), window.innerWidth * 0.5);
      sidebar.style.width = newWidth + 'px';
    };

    const onMouseUp = () => {
      handle.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      state.sidebarWidth = sidebar.getBoundingClientRect().width;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ─── Command Palette ───
const commandPalette = new CommandPalette();

// Register Commands
commandPalette.register('file:new', 'File: New File', () => newFile(), 'Ctrl+N');
commandPalette.register('file:open', 'File: Open File', () => openFile(), 'Ctrl+O');
commandPalette.register('file:save', 'File: Save', () => saveFile(), 'Ctrl+S');
commandPalette.register('file:saveas', 'File: Save As', () => saveFileAs(), 'Ctrl+Shift+S');
commandPalette.register('file:load_next_chunk', 'File: Load Next Chunk', () => loadNextChunk(state.activeTabId));
commandPalette.register('file:load_full', 'File: Load Full File', () => loadFullLargeFile(state.activeTabId));
commandPalette.register('editor:wrap', 'Editor: Toggle Word Wrap', () => toggleWordWrap());
commandPalette.register('editor:linenums', 'Editor: Toggle Line Numbers', () => toggleLineNumbers());
commandPalette.register('editor:fontsize_inc', 'Editor: Zoom In', () => setFontSize(state.fontSize + 1), 'Ctrl+t');
commandPalette.register('editor:fontsize_dec', 'Editor: Zoom Out', () => setFontSize(state.fontSize - 1), 'Ctrl+-');
commandPalette.register('editor:fontsize_reset', 'Editor: Reset Zoom', () => setFontSize(14), 'Ctrl+0');
commandPalette.register('view:sidebar', 'View: Toggle Sidebar', () => toggleSidebar(), 'Ctrl+B');
commandPalette.register('view:theme', 'View: Toggle Theme', () => toggleTheme());
commandPalette.register('data:analyze', 'Data: Analyze File', () => showDataAnalysis());
commandPalette.register('data:export_text', 'Data: Export Filtered (Text)', () => exportFilteredResults('text'));
commandPalette.register('data:export_json', 'Data: Export Filtered (JSON)', () => exportFilteredResults('json'));
commandPalette.register('data:export_csv', 'Data: Export Filtered (CSV)', () => exportFilteredResults('csv'));
commandPalette.register('data:benchmark_help', 'Data: Benchmark Instructions', () => showBenchmarkHelp());
commandPalette.register('query:focus', 'Query: Focus Filter', () => focusQueryInput(), 'Ctrl+L');
commandPalette.register('query:clear', 'Query: Clear Filter', () => clearActiveQuery());
commandPalette.register('query:save_current', 'Query: Save Current Filter', () => saveCurrentLogFilter());
commandPalette.register('query:apply_latest_saved', 'Query: Apply Latest Saved Filter', () => applyMostRecentSavedFilter());
commandPalette.register('search:global', 'Search: Find in All Tabs', () => toggleGlobalSearch(), 'Ctrl+Shift+F');
commandPalette.register('tools:regex_builder', 'Tools: Regex Builder', () => toggleRegexBuilder());
commandPalette.register('session:export', 'Session: Export Investigation', () => exportSession());
commandPalette.register('session:import', 'Session: Import Investigation', () => importSession());
commandPalette.register('session:clear', 'Session: Clear Saved Session', () => {
  localStorage.removeItem(SESSION_KEY);
  alert('Saved session cleared. Next launch will start fresh.');
});

// JSON Tools
commandPalette.register('json:prettify', 'JSON: Prettify', () => {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab || !tab.editorView) return;
  const content = tab.editorView.state.doc.toString();
  try {
    const parsed = JSON.parse(content);
    const formatted = JSON.stringify(parsed, null, 2);
    tab.editorView.dispatch({
      changes: { from: 0, to: content.length, insert: formatted }
    });
  } catch (e) {
    alert('Invalid JSON: ' + e.message);
  }
});

commandPalette.register('json:minify', 'JSON: Minify', () => {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab || !tab.editorView) return;
  const content = tab.editorView.state.doc.toString();
  try {
    const parsed = JSON.parse(content);
    const minified = JSON.stringify(parsed);
    tab.editorView.dispatch({
      changes: { from: 0, to: content.length, insert: minified }
    });
  } catch (e) {
    alert('Invalid JSON: ' + e.message);
  }
});

// ─── Global Search (Ctrl+Shift+F) ───
let globalSearchOpen = false;

function toggleGlobalSearch() {
  globalSearchOpen ? closeGlobalSearch() : openGlobalSearch();
}

function openGlobalSearch() {
  closeRegexBuilder();
  let overlay = document.getElementById('global-search-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'global-search-overlay';
    overlay.className = 'global-search-overlay';
    overlay.innerHTML = `
      <div class="global-search-panel">
        <div class="global-search-header">
          <h3>🔍 Find in All Tabs</h3>
          <button class="dialog-btn secondary" id="global-search-close">✕</button>
        </div>
        <div class="global-search-input-row">
          <input type="text" id="global-search-input" class="query-input" placeholder="Search text or /regex/i..." autocomplete="off" />
          <label class="global-search-checkbox"><input type="checkbox" id="global-search-case" /> Case sensitive</label>
        </div>
        <div id="global-search-results" class="global-search-results"></div>
        <div id="global-search-status" class="global-search-status"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('global-search-close').addEventListener('click', closeGlobalSearch);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeGlobalSearch(); });

    const input = document.getElementById('global-search-input');
    let searchTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runGlobalSearch(), 200);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeGlobalSearch();
      if (e.key === 'Enter') runGlobalSearch();
    });
    document.getElementById('global-search-case').addEventListener('change', () => runGlobalSearch());
  }

  overlay.classList.remove('hidden');
  globalSearchOpen = true;
  setTimeout(() => document.getElementById('global-search-input')?.focus(), 50);
}

function closeGlobalSearch() {
  const overlay = document.getElementById('global-search-overlay');
  if (overlay) overlay.classList.add('hidden');
  globalSearchOpen = false;
}

function runGlobalSearch() {
  const input = document.getElementById('global-search-input');
  const resultsDiv = document.getElementById('global-search-results');
  const statusDiv = document.getElementById('global-search-status');
  if (!input || !resultsDiv || !statusDiv) return;

  const query = input.value.trim();
  if (!query) { resultsDiv.innerHTML = '<div class="empty-state">Type to search across all open tabs</div>'; statusDiv.textContent = ''; return; }

  const caseSensitive = document.getElementById('global-search-case')?.checked;
  let regex;
  const regexMatch = query.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try { regex = new RegExp(regexMatch[1], regexMatch[2] || (caseSensitive ? 'g' : 'gi')); }
    catch (e) { statusDiv.textContent = 'Invalid regex: ' + e.message; resultsDiv.innerHTML = ''; return; }
  } else {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
  }

  let totalMatches = 0;
  let html = '';
  for (const tab of state.tabs) {
    const content = tab.content || (tab.editorView ? tab.editorView.state.doc.toString() : '');
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push({ line: i + 1, text: lines[i].substring(0, 200) });
        if (matches.length >= 50) break;
      }
      regex.lastIndex = 0;
    }
    if (matches.length === 0) continue;
    totalMatches += matches.length;
    html += `<div class="global-search-file"><div class="global-search-file-name">${escapeHtml(tab.name)} <span class="global-search-count">(${matches.length})</span></div>`;
    for (const m of matches) {
      const highlighted = m.text.replace(regex, (match) => `<mark>${escapeHtml(match)}</mark>`);
      regex.lastIndex = 0;
      html += `<div class="global-search-match" data-tab-id="${tab.id}" data-line="${m.line}"><span class="global-search-line-num">Ln ${m.line}</span> <span class="global-search-line-text">${highlighted}</span></div>`;
    }
    html += `</div>`;
  }

  if (!html) html = '<div class="empty-state">No matches found</div>';
  resultsDiv.innerHTML = html;
  statusDiv.textContent = `${totalMatches} match${totalMatches !== 1 ? 'es' : ''} in ${state.tabs.length} tab${state.tabs.length !== 1 ? 's' : ''}`;

  resultsDiv.querySelectorAll('.global-search-match').forEach(el => {
    el.addEventListener('click', () => {
      const tabId = parseInt(el.dataset.tabId);
      const line = parseInt(el.dataset.line);
      switchToTab(tabId);
      const tab = state.tabs.find(t => t.id === tabId);
      if (tab?.editorView) {
        const doc = tab.editorView.state.doc;
        const targetLine = doc.line(Math.min(Math.max(1, line), doc.lines));
        tab.editorView.dispatch({ selection: { anchor: targetLine.from }, scrollIntoView: true });
        tab.editorView.focus();
      }
      closeGlobalSearch();
    });
  });
}

// ─── Regex Builder ───
let regexBuilderOpen = false;

function toggleRegexBuilder() {
  regexBuilderOpen ? closeRegexBuilder() : openRegexBuilder();
}

function openRegexBuilder() {
  closeGlobalSearch();
  let overlay = document.getElementById('regex-builder-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'regex-builder-overlay';
    overlay.className = 'global-search-overlay';
    overlay.innerHTML = `
      <div class="global-search-panel regex-builder-panel">
        <div class="global-search-header">
          <h3>🔧 Regex Builder</h3>
          <button class="dialog-btn secondary" id="regex-builder-close">✕</button>
        </div>
        <div class="regex-builder-input-row">
          <span class="regex-slash">/</span>
          <input type="text" id="regex-pattern-input" class="query-input regex-pattern" placeholder="pattern" autocomplete="off" />
          <span class="regex-slash">/</span>
          <input type="text" id="regex-flags-input" class="query-input regex-flags" placeholder="gi" value="gi" maxlength="6" />
        </div>
        <div class="regex-builder-test-area">
          <label>Test string (one per line):</label>
          <textarea id="regex-test-input" class="regex-test-textarea" rows="6" placeholder="Paste sample log lines here..."></textarea>
        </div>
        <div id="regex-match-results" class="regex-match-results"></div>
        <div class="regex-builder-actions">
          <button id="regex-export-btn" class="dialog-btn primary">Export to Log Filter</button>
          <span id="regex-match-status" class="global-search-status"></span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('regex-builder-close').addEventListener('click', closeRegexBuilder);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeRegexBuilder(); });

    const patternInput = document.getElementById('regex-pattern-input');
    const flagsInput = document.getElementById('regex-flags-input');
    const testInput = document.getElementById('regex-test-input');

    const runTest = () => runRegexTest();
    patternInput.addEventListener('input', runTest);
    flagsInput.addEventListener('input', runTest);
    testInput.addEventListener('input', runTest);
    patternInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRegexBuilder(); });

    document.getElementById('regex-export-btn').addEventListener('click', () => {
      const pattern = patternInput.value;
      const flags = flagsInput.value;
      if (!pattern) return;
      const queryStr = `re:/${pattern}/${flags}`;
      const queryInput = document.getElementById('query-input');
      if (queryInput) {
        queryInput.value = queryStr;
        const tab = state.tabs.find(t => t.id === state.activeTabId);
        if (tab && isQueryableTab(tab)) applyQueryToTab(tab, queryStr);
      }
      closeRegexBuilder();
    });

    // Pre-fill test area with current tab's first 20 lines
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab) {
      const content = tab.content || (tab.editorView ? tab.editorView.state.doc.toString() : '');
      if (content) testInput.value = content.split(/\r?\n/).slice(0, 20).join('\n');
    }
  }

  overlay.classList.remove('hidden');
  regexBuilderOpen = true;
  setTimeout(() => document.getElementById('regex-pattern-input')?.focus(), 50);
}

function closeRegexBuilder() {
  const overlay = document.getElementById('regex-builder-overlay');
  if (overlay) overlay.classList.add('hidden');
  regexBuilderOpen = false;
}

function runRegexTest() {
  const pattern = document.getElementById('regex-pattern-input')?.value;
  const flags = document.getElementById('regex-flags-input')?.value || '';
  const testText = document.getElementById('regex-test-input')?.value || '';
  const resultsDiv = document.getElementById('regex-match-results');
  const statusDiv = document.getElementById('regex-match-status');
  if (!resultsDiv || !statusDiv) return;

  if (!pattern) { resultsDiv.innerHTML = '<div class="empty-state">Enter a regex pattern</div>'; statusDiv.textContent = ''; return; }

  let regex;
  try { regex = new RegExp(pattern, flags); }
  catch (e) { resultsDiv.innerHTML = `<div class="regex-error">❌ ${escapeHtml(e.message)}</div>`; statusDiv.textContent = ''; return; }

  const lines = testText.split(/\r?\n/);
  let matchCount = 0;
  let html = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isMatch = regex.test(line);
    regex.lastIndex = 0;
    if (isMatch) {
      matchCount++;
      const highlighted = line.replace(regex, (match) => `<mark>${escapeHtml(match)}</mark>`);
      regex.lastIndex = 0;
      html += `<div class="regex-line regex-match"><span class="regex-line-num">${i + 1}</span>${highlighted}</div>`;
    } else {
      html += `<div class="regex-line regex-no-match"><span class="regex-line-num">${i + 1}</span>${escapeHtml(line)}</div>`;
    }
  }

  resultsDiv.innerHTML = html || '<div class="empty-state">No test lines</div>';
  statusDiv.textContent = `${matchCount}/${lines.length} lines match`;
}

// ─── Clipboard Integration ───
function setupClipboardPaste() {
  document.addEventListener('paste', (e) => {
    // Only intercept if not in an input/textarea/editor
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.closest('.cm-editor'))) return;

    const text = e.clipboardData?.getData('text/plain');
    if (!text || text.length < 10) return;

    e.preventDefault();
    const trimmed = text.trim();
    let language = 'plaintext';
    let name = 'Clipboard';

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { JSON.parse(trimmed); language = 'json'; name = 'Clipboard.json'; } catch { }
    }
    if (language === 'plaintext' && (trimmed.includes(',') && trimmed.split(/\r?\n/)[0].split(',').length > 2)) {
      language = 'csv'; name = 'Clipboard.csv';
    }
    if (language === 'plaintext' && /\b(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\b/i.test(trimmed.split(/\r?\n/).slice(0, 5).join('\n'))) {
      language = 'log'; name = 'Clipboard.log';
    }

    state.untitledCounter++;
    const id = ++tabIdCounter;
    const tab = {
      id, path: null, name: `${name}-${state.untitledCounter}`,
      content: text, encoding: 'UTF-8', language,
      lineEnding: 'CRLF', size: new Blob([text]).size, modified: false, pinned: false,
      readOnly: false, largeFileMode: false, progressive: false,
      fullContent: null, loadedChars: 0,
      query: { text: '', active: false, busy: false, previewContent: null, resultCount: null, totalCount: null, error: '', pathTokens: null, locateResult: null, clauseCount: 0, termCount: 0, clauses: [], pathCatalogSignature: '', pathCatalog: [] },
      editorView: null,
    };
    state.tabs.push(tab);
    renderTab(tab);
    switchToTab(id);
    document.getElementById('welcome-screen').classList.add('hidden');
    updateStatusBar(tab);
  });
}

// ─── Session Export / Import ───
async function exportSession() {
  const sessionData = {
    version: 1,
    timestamp: new Date().toISOString(),
    tabs: state.tabs.map(t => ({
      name: t.name, path: t.path, language: t.language,
      content: t.content || (t.editorView ? t.editorView.state.doc.toString() : ''),
      pinned: t.pinned,
      queryText: t.query?.text || '',
    })),
    savedLogFilters: state.savedLogFilters,
    theme: state.theme,
  };

  try {
    const selected = await save({
      filters: [{ name: 'CrabTree Session', extensions: ['crabtree'] }, { name: 'JSON', extensions: ['json'] }],
    });
    if (!selected) return;
    const filePath = typeof selected === 'string' ? selected : selected.path;
    await invoke('approve_path', { path: filePath }).catch(err => console.warn('approve_path err:', err));
    await invoke('save_file', { path: filePath, content: JSON.stringify(sessionData, null, 2) });
    alert('Session exported successfully!');
  } catch (err) {
    console.error('Export session error:', err);
    alert(`Export failed: ${err.message}`);
  }
}

async function importSession() {
  try {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'CrabTree Session', extensions: ['crabtree', 'json'] }],
    });
    if (!selected) return;
    const filePath = typeof selected === 'string' ? selected : selected.path;
    await invoke('approve_path', { path: filePath }).catch(err => console.warn('approve_path err:', err));
    const fileData = await invoke('read_file', { path: filePath });
    const sessionData = JSON.parse(fileData.content);
    if (!sessionData.tabs || !Array.isArray(sessionData.tabs)) {
      alert('Invalid session file.'); return;
    }

    // Import saved filters
    if (sessionData.savedLogFilters) {
      sessionData.savedLogFilters.forEach(f => {
        if (!state.savedLogFilters.includes(f)) state.savedLogFilters.push(f);
      });
      persistSavedLogFilters();
    }

    // Create tabs from session
    for (const tabData of sessionData.tabs) {
      state.untitledCounter++;
      const id = ++tabIdCounter;
      const tab = {
        id, path: tabData.path, name: tabData.name,
        content: tabData.content || '', encoding: 'UTF-8', language: tabData.language || 'plaintext',
        lineEnding: 'CRLF', size: new Blob([tabData.content || '']).size,
        modified: false, pinned: tabData.pinned || false,
        readOnly: false, largeFileMode: false, progressive: false,
        fullContent: null, loadedChars: 0,
        query: { text: tabData.queryText || '', active: false, busy: false, previewContent: null, resultCount: null, totalCount: null, error: '', pathTokens: null, locateResult: null, clauseCount: 0, termCount: 0, clauses: [], pathCatalogSignature: '', pathCatalog: [] },
        editorView: null,
      };
      state.tabs.push(tab);
      renderTab(tab);
    }

    if (state.tabs.length > 0) {
      switchToTab(state.tabs[state.tabs.length - 1].id);
      document.getElementById('welcome-screen').classList.add('hidden');
    }
    alert(`Imported ${sessionData.tabs.length} tab(s) from session.`);
  } catch (err) {
    console.error('Import session error:', err);
    alert(`Import failed: ${err.message}`);
  }
}

// ─── Keyboard Shortcut Cheatsheet ───
let cheatsheetOpen = false;

function toggleCheatsheet() {
  cheatsheetOpen ? closeCheatsheet() : openCheatsheet();
}

function openCheatsheet() {
  let overlay = document.getElementById('cheatsheet-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'cheatsheet-overlay';
    overlay.className = 'global-search-overlay';
    const shortcuts = [
      ['Ctrl+N', 'New File'],
      ['Ctrl+O', 'Open File'],
      ['Ctrl+S', 'Save'],
      ['Ctrl+Shift+S', 'Save As'],
      ['Ctrl+W', 'Close Tab'],
      ['Ctrl+Tab', 'Next Tab'],
      ['Ctrl+Shift+Tab', 'Previous Tab'],
      ['Ctrl+B', 'Toggle Sidebar'],
      ['Ctrl+G', 'Go to Line'],
      ['Ctrl+F', 'Find in File'],
      ['Ctrl+Shift+F', 'Find in All Tabs'],
      ['Ctrl+L', 'Focus Query Filter'],
      ['Ctrl+Shift+P', 'Command Palette'],
      ['Ctrl+= / Ctrl+-', 'Zoom In / Out'],
      ['Ctrl+0', 'Reset Zoom'],
      ['Escape', 'Close Dialog / Panel'],
    ];
    const rows = shortcuts.map(([key, desc]) =>
      `<div class="cheatsheet-row"><kbd>${key}</kbd><span>${desc}</span></div>`
    ).join('');
    overlay.innerHTML = `
      <div class="global-search-panel cheatsheet-panel">
        <div class="global-search-header">
          <h3>⌨️ Keyboard Shortcuts</h3>
          <button class="dialog-btn secondary" id="cheatsheet-close">✕</button>
        </div>
        <div class="cheatsheet-grid">${rows}</div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('cheatsheet-close').addEventListener('click', closeCheatsheet);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCheatsheet(); });
  }
  overlay.classList.remove('hidden');
  cheatsheetOpen = true;
}

function closeCheatsheet() {
  const overlay = document.getElementById('cheatsheet-overlay');
  if (overlay) overlay.classList.add('hidden');
  cheatsheetOpen = false;
}

// ─── Auto-Save Visual Indicator ───
function flashAutoSaveIndicator() {
  const el = document.getElementById('status-autosave');
  if (!el) return;
  el.classList.add('saving');
  setTimeout(() => el.classList.remove('saving'), 1200);
}

// Register cheatsheet and other new commands
commandPalette.register('help:shortcuts', 'Help: Keyboard Shortcuts', () => toggleCheatsheet(), 'Ctrl+/');
commandPalette.register('tab:close_others', 'Tab: Close Other Tabs', () => {
  if (state.activeTabId) closeOtherTabs(state.activeTabId);
});
commandPalette.register('tab:close_right', 'Tab: Close Tabs to Right', () => {
  if (state.activeTabId) closeTabsToRight(state.activeTabId);
});
commandPalette.register('tab:close_all', 'Tab: Close All Tabs', () => closeAllTabs());

// ─── Fuzzy File Finder (Ctrl+P) ───
let fileFinderOpen = false;

function fuzzyMatch(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0, score = 0, prevMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += (ti === prevMatch + 1) ? 10 : 1; // consecutive chars score higher
      if (ti === 0 || target[ti - 1] === '/' || target[ti - 1] === '\\' || target[ti - 1] === '.') score += 5; // word boundary
      prevMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? score : 0;
}

function collectAllFiles(entries, base = '') {
  const files = [];
  if (!entries) return files;
  for (const e of entries) {
    const path = base ? `${base}/${e.name}` : e.name;
    if (e.is_dir && e.children) {
      files.push(...collectAllFiles(e.children, path));
    } else if (!e.is_dir) {
      files.push({ name: e.name, path: e.path || path, displayPath: path });
    }
  }
  return files;
}

function toggleFileFinder() {
  fileFinderOpen ? closeFileFinder() : openFileFinder();
}

function openFileFinder() {
  fileFinderOpen = true;
  let overlay = document.getElementById('file-finder-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'file-finder-overlay';
    overlay.className = 'overlay-fullscreen';
    overlay.innerHTML = `
      <div class="file-finder-panel">
        <input type="text" id="file-finder-input" placeholder="Search files by name..." autocomplete="off" spellcheck="false" />
        <div id="file-finder-results" class="file-finder-results"></div>
      </div>
    `;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFileFinder(); });
    document.body.appendChild(overlay);
  }
  overlay.classList.remove('hidden');
  const input = document.getElementById('file-finder-input');
  input.value = '';
  input.focus();
  renderFileFinderResults('');

  let selectedIdx = 0;
  input.oninput = () => { selectedIdx = 0; renderFileFinderResults(input.value, selectedIdx); };
  input.onkeydown = (e) => {
    const items = document.querySelectorAll('.file-finder-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, items.length - 1); highlightFinderItem(items, selectedIdx); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); highlightFinderItem(items, selectedIdx); }
    else if (e.key === 'Enter') { e.preventDefault(); items[selectedIdx]?.click(); }
    else if (e.key === 'Escape') { closeFileFinder(); }
  };
}

function closeFileFinder() {
  fileFinderOpen = false;
  const overlay = document.getElementById('file-finder-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function highlightFinderItem(items, idx) {
  items.forEach((it, i) => it.classList.toggle('selected', i === idx));
  items[idx]?.scrollIntoView({ block: 'nearest' });
}

function renderFileFinderResults(query, selIdx = 0) {
  const container = document.getElementById('file-finder-results');
  if (!container) return;
  container.innerHTML = '';

  // Gather all sources: open tabs + folder tree files
  const candidates = [];
  for (const tab of state.tabs) {
    candidates.push({ name: tab.name, displayPath: tab.path || tab.name, type: 'tab', tabId: tab.id });
  }
  if (state.folderEntries) {
    for (const f of collectAllFiles(state.folderEntries)) {
      if (!candidates.find(c => c.displayPath === f.path)) {
        candidates.push({ name: f.name, displayPath: f.displayPath, type: 'file', path: f.path });
      }
    }
  }

  let results = candidates;
  if (query.trim()) {
    results = candidates
      .map(c => ({ ...c, score: fuzzyMatch(query, c.name) + fuzzyMatch(query, c.displayPath) * 0.5 }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score);
  }
  results = results.slice(0, 20);

  if (results.length === 0) {
    container.innerHTML = '<div class="file-finder-empty">No files found</div>';
    return;
  }

  results.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'file-finder-item' + (i === selIdx ? ' selected' : '');
    const iconHtml = renderFileIcon(r.name, false);
    const color = getFileColor(r.name);
    item.innerHTML = `
      <span class="ff-icon">${iconHtml}</span>
      <span class="ff-name" style="color:${color}">${escapeHtml(r.name)}</span>
      <span class="ff-path">${escapeHtml(r.displayPath)}</span>
      ${r.type === 'tab' ? '<span class="ff-badge">open</span>' : ''}
    `;
    item.addEventListener('click', async () => {
      closeFileFinder();
      if (r.type === 'tab') {
        switchToTab(r.tabId);
      } else if (r.path) {
        const existing = state.tabs.find(t => t.path === r.path);
        if (existing) { switchToTab(existing.id); return; }
        try { createTab(await invoke('read_file', { path: r.path })); }
        catch (err) { console.error('File finder open error:', err); }
      }
    });
    container.appendChild(item);
  });
}

// ─── Minimap / Severity Heatmap ───
let minimapVisible = false;

function toggleMinimap() {
  minimapVisible = !minimapVisible;
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (minimapVisible && tab) renderMinimap(tab);
  else hideMinimap();
}

function renderMinimap(tab) {
  let minimap = document.getElementById('minimap-container');
  if (!minimap) {
    minimap = document.createElement('div');
    minimap.id = 'minimap-container';
    document.getElementById('editor-container')?.parentElement?.appendChild(minimap);
  }
  minimap.classList.remove('hidden');
  minimap.innerHTML = '<div class="minimap-header">MINIMAP</div>';

  const canvas = document.createElement('canvas');
  canvas.className = 'minimap-canvas';
  canvas.width = 100;
  const content = tab.editorView ? tab.editorView.state.doc.toString() : (tab.content || '');
  const lines = content.split('\n');
  const lineHeight = 2;
  canvas.height = Math.min(lines.length * lineHeight, 600);
  minimap.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1b26';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const severityColors = {
    error: '#f7768e', warn: '#e0af68', info: '#7aa2f7', debug: '#565f89', trace: '#3b3f54'
  };

  lines.forEach((line, i) => {
    const y = i * lineHeight;
    if (y > canvas.height) return;
    let color = '#292e42'; // default
    if (SEVERITY_RE.test(line)) color = severityColors.error;
    else if (WARN_RE.test(line)) color = severityColors.warn;
    else if (INFO_RE.test(line)) color = severityColors.info;
    else if (DEBUG_RE.test(line)) color = severityColors.debug;
    else if (TRACE_RE.test(line)) color = severityColors.trace;
    ctx.fillStyle = color;
    // Draw line representation
    const lineLen = Math.min(line.length, 100);
    ctx.fillRect(0, y, lineLen, lineHeight);
  });

  // Viewport indicator
  if (tab.editorView) {
    const vp = tab.editorView.viewport;
    const vpStart = tab.editorView.state.doc.lineAt(vp.from).number - 1;
    const vpEnd = tab.editorView.state.doc.lineAt(vp.to).number - 1;
    const vpY = vpStart * lineHeight;
    const vpH = Math.max((vpEnd - vpStart) * lineHeight, 10);
    ctx.strokeStyle = 'rgba(122, 162, 247, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, vpY, canvas.width, vpH);
  }

  // Click to scroll
  canvas.addEventListener('click', (e) => {
    if (!tab.editorView) return;
    const rect = canvas.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const targetLine = Math.floor(clickY / lineHeight) + 1;
    const line = tab.editorView.state.doc.line(Math.min(targetLine, tab.editorView.state.doc.lines));
    tab.editorView.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
  });

  // Stats
  const stats = document.createElement('div');
  stats.className = 'minimap-stats';
  const counts = { error: 0, warn: 0, info: 0, debug: 0 };
  lines.forEach(l => {
    if (SEVERITY_RE.test(l)) counts.error++;
    else if (WARN_RE.test(l)) counts.warn++;
    else if (INFO_RE.test(l)) counts.info++;
    else if (DEBUG_RE.test(l)) counts.debug++;
  });
  stats.innerHTML = `
    <span class="mm-stat" style="color:#f7768e">● ${counts.error} errors</span>
    <span class="mm-stat" style="color:#e0af68">● ${counts.warn} warns</span>
    <span class="mm-stat" style="color:#7aa2f7">● ${counts.info} info</span>
    <span class="mm-stat" style="color:#565f89">● ${counts.debug} debug</span>
  `;
  minimap.appendChild(stats);
}

function hideMinimap() {
  const minimap = document.getElementById('minimap-container');
  if (minimap) minimap.classList.add('hidden');
}

// ─── Problems Panel ───
let problemsPanelOpen = false;

function toggleProblemsPanel() {
  problemsPanelOpen ? closeProblemsPanel() : openProblemsPanel();
}

function openProblemsPanel() {
  problemsPanelOpen = true;
  let panel = document.getElementById('problems-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'problems-panel';
    panel.className = 'bottom-panel';
    document.querySelector('.main-content')?.appendChild(panel);
  }
  panel.classList.remove('hidden');
  refreshProblemsPanel();
}

function closeProblemsPanel() {
  problemsPanelOpen = false;
  const panel = document.getElementById('problems-panel');
  if (panel) panel.classList.add('hidden');
}

function refreshProblemsPanel() {
  const panel = document.getElementById('problems-panel');
  if (!panel) return;

  const problems = [];
  for (const tab of state.tabs) {
    const content = tab.content || '';
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (SEVERITY_RE.test(line)) {
        problems.push({ tab, line: idx + 1, text: line.trim().substring(0, 200), severity: 'error' });
      } else if (WARN_RE.test(line)) {
        problems.push({ tab, line: idx + 1, text: line.trim().substring(0, 200), severity: 'warn' });
      }
    });
  }

  const errors = problems.filter(p => p.severity === 'error');
  const warnings = problems.filter(p => p.severity === 'warn');

  panel.innerHTML = `
    <div class="problems-header">
      <span class="problems-title">PROBLEMS</span>
      <span class="problems-counts">
        <span style="color:#f7768e">⊘ ${errors.length} Errors</span>
        <span style="color:#e0af68">⚠ ${warnings.length} Warnings</span>
      </span>
      <button class="problems-close" onclick="closeProblemsPanel()">✕</button>
    </div>
    <div class="problems-list">
      ${problems.slice(0, 200).map(p => `
        <div class="problem-item problem-${p.severity}" data-tab-id="${p.tab.id}" data-line="${p.line}">
          <span class="problem-icon">${p.severity === 'error' ? '⊘' : '⚠'}</span>
          <span class="problem-file">${escapeHtml(p.tab.name)}:${p.line}</span>
          <span class="problem-text">${escapeHtml(p.text)}</span>
        </div>
      `).join('')}
      ${problems.length === 0 ? '<div class="problems-empty">No problems found ✓</div>' : ''}
      ${problems.length > 200 ? `<div class="problems-truncated">Showing 200 of ${problems.length} problems</div>` : ''}
    </div>
  `;

  // Click to jump
  panel.querySelectorAll('.problem-item').forEach(item => {
    item.addEventListener('click', () => {
      const tabId = parseInt(item.dataset.tabId);
      const line = parseInt(item.dataset.line);
      switchToTab(tabId);
      setTimeout(() => {
        const tab = state.tabs.find(t => t.id === tabId);
        if (tab?.editorView) {
          const l = tab.editorView.state.doc.line(Math.min(line, tab.editorView.state.doc.lines));
          tab.editorView.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
          tab.editorView.focus();
        }
      }, 50);
    });
  });
}

// ─── Which-Key Progressive Hints ───
let whichKeyTimer = null;
let whichKeyVisible = false;

function setupWhichKey() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Control' && !e.repeat && !whichKeyVisible) {
      whichKeyTimer = setTimeout(() => showWhichKey(), 600);
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control') {
      clearTimeout(whichKeyTimer);
      if (whichKeyVisible) hideWhichKey();
    }
  });
}

function showWhichKey() {
  whichKeyVisible = true;
  let panel = document.getElementById('which-key-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'which-key-panel';
    document.body.appendChild(panel);
  }
  panel.innerHTML = `
    <div class="wk-grid">
      <div class="wk-item"><kbd>N</kbd> New File</div>
      <div class="wk-item"><kbd>O</kbd> Open File</div>
      <div class="wk-item"><kbd>S</kbd> Save</div>
      <div class="wk-item"><kbd>P</kbd> File Finder</div>
      <div class="wk-item"><kbd>⇧P</kbd> Command Palette</div>
      <div class="wk-item"><kbd>B</kbd> Toggle Sidebar</div>
      <div class="wk-item"><kbd>G</kbd> Go to Line</div>
      <div class="wk-item"><kbd>F</kbd> Find in File</div>
      <div class="wk-item"><kbd>⇧F</kbd> Global Search</div>
      <div class="wk-item"><kbd>Tab</kbd> Next Tab</div>
      <div class="wk-item"><kbd>/</kbd> Shortcuts</div>
      <div class="wk-item"><kbd>M</kbd> Minimap</div>
      <div class="wk-item"><kbd>⇧E</kbd> Problems</div>
      <div class="wk-item"><kbd>+/-</kbd> Font Size</div>
    </div>
  `;
  panel.classList.remove('hidden');
}

function hideWhichKey() {
  whichKeyVisible = false;
  const panel = document.getElementById('which-key-panel');
  if (panel) panel.classList.add('hidden');
}

// Register new commands
commandPalette.register('file:finder', 'File: Quick Open', () => toggleFileFinder(), 'Ctrl+P');
commandPalette.register('view:minimap', 'View: Toggle Minimap', () => toggleMinimap(), 'Ctrl+M');
commandPalette.register('view:problems', 'View: Toggle Problems Panel', () => toggleProblemsPanel(), 'Ctrl+Shift+E');

// ─── Initialize ───
async function init() {
  applyTheme(state.theme);
  setFontSize(state.fontSize);
  updateWrapUI();
  setupWhichKey();

  document.getElementById('btn-new-file').addEventListener('click', newFile);
  document.getElementById('btn-open-file').addEventListener('click', openFile);
  document.getElementById('btn-open-folder').addEventListener('click', openFolder);
  document.getElementById('btn-save').addEventListener('click', saveFile);
  document.getElementById('btn-save-as').addEventListener('click', saveFileAs);
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  document.getElementById('btn-collapse-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);

  // Sidebar resize handle
  setupSidebarResize();

  // Go to line dialog
  document.getElementById('goto-go').addEventListener('click', goToLine);
  document.getElementById('goto-cancel').addEventListener('click', hideGoToLine);
  document.getElementById('goto-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToLine();
    if (e.key === 'Escape') hideGoToLine();
  });

  // Close dialog
  document.getElementById('close-save').addEventListener('click', () => resolveCloseDialog('save'));
  document.getElementById('close-dont-save').addEventListener('click', () => resolveCloseDialog('dont-save'));
  document.getElementById('close-cancel').addEventListener('click', () => resolveCloseDialog('cancel'));

  // Status bar toggles
  document.getElementById('status-wrap').addEventListener('click', toggleWordWrap);
  document.getElementById('status-autosave').addEventListener('click', toggleAutoSave);
  document.getElementById('status-fontsize').addEventListener('click', () => setFontSize(14));
  setupQueryBar();
  updateSavedLogFiltersUI();

  // Auto-save UI
  document.getElementById('status-autosave').textContent = state.autoSave ? '💾 Auto' : '💾 Manual';

  // Drag & drop
  setupDragDrop();

  // Clipboard paste auto-detect
  setupClipboardPaste();

  // Recent files
  renderRecentFiles();
  updateQueryBar(null);

  // Restore previous investigation session
  const restored = await restoreSession();
  if (!restored) {
    document.getElementById('welcome-screen').classList.remove('hidden');
  }

  // Session cleanup: clear approved paths on app quit
  window.addEventListener('beforeunload', async () => {
    try {
      await invoke('clear_approved_paths');
    } catch (err) {
      console.warn('Failed to clear approved paths:', err);
    }
  });

  console.log('🦀 Crab Tree initialized');
}

// ─── Security: Secret Detection ───
const SECRET_PATTERNS = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g, severity: 'critical' },
  { name: 'AWS Secret Key', regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*\S{20,}/gi, severity: 'critical' },
  { name: 'RSA Private Key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, severity: 'critical' },
  { name: 'PGP Private Key', regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g, severity: 'critical' },
  { name: 'Stripe Key', regex: /(?:sk|pk)_(?:live|test)_[0-9a-zA-Z]{24,}/g, severity: 'high' },
  { name: 'GitHub Token', regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g, severity: 'high' },
  { name: 'GitLab Token', regex: /glpat-[A-Za-z0-9\-_]{20,}/g, severity: 'high' },
  { name: 'Generic Password', regex: /(?:password|passwd|secret|api_key|apikey|token)\s*[=:]\s*['"][^'"]{8,}['"]/gi, severity: 'warning' },
  { name: 'JWT Token', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, severity: 'warning' },
];

function scanSecrets(content) {
  const findings = [];
  const lines = content.split('\n');
  for (const pattern of SECRET_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].matchAll(pattern.regex);
      for (const m of matches) {
        findings.push({
          name: pattern.name,
          severity: pattern.severity,
          line: i + 1,
          match: m[0].length > 40 ? m[0].substring(0, 40) + '…' : m[0],
        });
      }
    }
  }
  return findings;
}

function renderSecurityBanner(tab, container) {
  // Remove existing banner
  const existing = container.parentElement?.querySelector('.security-banner');
  if (existing) existing.remove();

  const content = getTabDisplayContent(tab) || '';
  const findings = scanSecrets(content);
  tab._secretFindings = findings;

  if (findings.length === 0) return;

  const banner = document.createElement('div');
  banner.className = 'security-banner';

  const criticals = findings.filter(f => f.severity === 'critical').length;
  const highs = findings.filter(f => f.severity === 'high').length;
  const warnings = findings.filter(f => f.severity === 'warning').length;

  const severityIcon = criticals > 0 ? '🚨' : highs > 0 ? '⚠️' : '🔍';
  const severityClass = criticals > 0 ? 'critical' : highs > 0 ? 'high' : 'warning';

  let summary = `${severityIcon} <strong>${findings.length} potential secret${findings.length > 1 ? 's' : ''} detected</strong>`;
  const parts = [];
  if (criticals) parts.push(`${criticals} critical`);
  if (highs) parts.push(`${highs} high`);
  if (warnings) parts.push(`${warnings} warning`);
  summary += ` (${parts.join(', ')})`;

  // Group findings by type
  const grouped = {};
  findings.forEach(f => {
    if (!grouped[f.name]) grouped[f.name] = [];
    grouped[f.name].push(f);
  });

  const details = Object.entries(grouped).map(([name, items]) =>
    `<span class="secret-finding-group"><span class="secret-label">${escapeHtml(name)}</span> ` +
    `on line${items.length > 1 ? 's' : ''} ${items.map(i => `<span class="secret-line" data-line="${i.line}">${i.line}</span>`).join(', ')}</span>`
  ).join(' · ');

  banner.innerHTML = `<div class="security-banner-content ${severityClass}">${summary}<div class="secret-details">${details}</div></div>`;

  // Click-to-jump on line numbers
  banner.querySelectorAll('.secret-line').forEach(el => {
    el.addEventListener('click', () => {
      const line = parseInt(el.dataset.line);
      if (tab.editorView) {
        const lineInfo = tab.editorView.state.doc.line(Math.min(line, tab.editorView.state.doc.lines));
        tab.editorView.dispatch({
          selection: { anchor: lineInfo.from },
          scrollIntoView: true,
        });
        tab.editorView.focus();
      }
    });
  });

  // Insert before editor container
  container.parentElement.insertBefore(banner, container);
}

// ─── Security: Path Traversal Protection ───
function isPathTraversalSafe(filePath) {
  if (!filePath || typeof filePath !== 'string') return { safe: false, reason: 'Empty path' };

  const dangerous = [
    { pattern: /\.\.[/\\]/g, reason: 'Directory traversal (../)' },
    { pattern: /[/\\]\.\.[/\\]/g, reason: 'Mid-path traversal' },
    { pattern: /%2e%2e/gi, reason: 'URL-encoded traversal (%2e%2e)' },
    { pattern: /%2f/gi, reason: 'URL-encoded slash (%2f)' },
    { pattern: /\0/g, reason: 'Null byte injection' },
  ];

  for (const d of dangerous) {
    if (d.pattern.test(filePath)) {
      return { safe: false, reason: d.reason };
    }
  }

  return { safe: true };
}

init();
