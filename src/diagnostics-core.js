// ============================================
// CRAB TREE — Diagnostics Core
// Language-aware, lightweight diagnostics.
// ============================================

const LOG_ERROR_RE = /\b(ERROR|FATAL|CRITICAL|FAIL)\b/i;
const LOG_WARN_RE = /\b(WARN(?:ING)?)\b/i;

function makeDiag(line, column, severity, message, source = 'crabtree') {
  return {
    line,
    column,
    severity,
    message,
    source,
  };
}

function parseJsonDiagnostics(content) {
  const out = [];
  const text = String(content || '');
  if (!text.trim()) return out;
  try {
    JSON.parse(text);
  } catch (err) {
    const msg = String(err.message || 'Invalid JSON');
    let line = 1;
    let column = 1;
    const lineCol = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (lineCol) {
      line = Number(lineCol[1]) || 1;
      column = Number(lineCol[2]) || 1;
    } else {
      const posMatch = msg.match(/position\s+(\d+)/i);
      if (posMatch) {
        const pos = Math.max(0, Number(posMatch[1]) || 0);
        const before = text.slice(0, pos);
        line = before.split('\n').length;
        const lastNewline = before.lastIndexOf('\n');
        column = pos - (lastNewline + 1) + 1;
      }
    }
    out.push(makeDiag(line, column, 'error', msg, 'json'));
  }
  return out;
}

function parseLogDiagnostics(content) {
  const out = [];
  const lines = String(content || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (LOG_ERROR_RE.test(line)) {
      out.push(makeDiag(i + 1, 1, 'error', 'Log error severity token', 'log'));
    } else if (LOG_WARN_RE.test(line)) {
      out.push(makeDiag(i + 1, 1, 'warning', 'Log warning severity token', 'log'));
    }
  }
  return out;
}

function parseCsvDiagnostics(content) {
  const out = [];
  const lines = String(content || '').split(/\r?\n/);
  if (lines.length === 0 || !lines[0].trim()) return out;
  const expectedCols = lines[0].split(',').length;
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const cols = raw.split(',').length;
    if (cols !== expectedCols) {
      out.push(
        makeDiag(
          i + 1,
          1,
          'warning',
          `CSV row has ${cols} columns; expected ${expectedCols}`,
          'csv',
        ),
      );
    }
  }
  return out;
}

function parseGenericDiagnostics(content) {
  const out = [];
  const lines = String(content || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 160) {
      out.push(makeDiag(i + 1, 161, 'info', 'Line exceeds 160 characters', 'style'));
    }
    if (/\s+$/.test(line)) {
      out.push(makeDiag(i + 1, line.length, 'info', 'Trailing whitespace', 'style'));
    }
    if (/\b(TODO|FIXME|XXX)\b/i.test(line)) {
      out.push(makeDiag(i + 1, 1, 'warning', 'Outstanding TODO/FIXME/XXX marker', 'style'));
    }
  }
  return out;
}

export function collectDiagnostics(content, language = 'plaintext') {
  const lang = String(language || 'plaintext').toLowerCase();
  let diagnostics = [];

  if (lang === 'json') diagnostics = diagnostics.concat(parseJsonDiagnostics(content));
  if (lang === 'log' || lang === 'plaintext') diagnostics = diagnostics.concat(parseLogDiagnostics(content));
  if (lang === 'csv' || lang === 'tsv') diagnostics = diagnostics.concat(parseCsvDiagnostics(content));

  diagnostics = diagnostics.concat(parseGenericDiagnostics(content));

  diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
  return diagnostics;
}

export function toCodeMirrorDiagnostics(content, language = 'plaintext') {
  const text = String(content || '');
  const diagnostics = collectDiagnostics(text, language);
  if (!diagnostics.length) return [];

  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1);
  }

  const out = [];
  for (const d of diagnostics) {
    const lineIndex = Math.max(0, d.line - 1);
    const lineStart = lineStarts[Math.min(lineIndex, lineStarts.length - 1)] || 0;
    const from = Math.min(text.length, lineStart + Math.max(0, d.column - 1));
    const to = Math.min(text.length, from + 1);
    out.push({
      from,
      to,
      severity: d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info',
      message: d.message,
    });
  }

  return out;
}

export function summarizeDiagnostics(diagnostics) {
  const summary = { error: 0, warning: 0, info: 0, total: diagnostics.length };
  for (const d of diagnostics) {
    if (d.severity === 'error') summary.error += 1;
    else if (d.severity === 'warning') summary.warning += 1;
    else summary.info += 1;
  }
  return summary;
}
