// ============================================
// CRAB TREE — Outline Core
// Builds structural navigation entries.
// ============================================

function push(items, label, line, kind = 'symbol', depth = 0) {
  items.push({ label, line: Math.max(1, Number(line) || 1), kind, depth });
}

function buildJsonOutline(content, maxItems = 400) {
  const items = [];
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [{ label: 'Invalid JSON', line: 1, kind: 'error', depth: 0 }];
  }

  const walk = (node, path = [], depth = 0) => {
    if (items.length >= maxItems) return;
    if (node && typeof node === 'object') {
      if (Array.isArray(node)) {
        push(items, `${path.join('.') || 'root'} [${node.length}]`, 1, 'array', depth);
        for (let i = 0; i < node.length && i < 40; i++) {
          walk(node[i], [...path, `[${i}]`], depth + 1);
          if (items.length >= maxItems) return;
        }
      } else {
        const keys = Object.keys(node);
        push(items, `${path.join('.') || 'root'} {${keys.length}}`, 1, 'object', depth);
        for (const key of keys.slice(0, 80)) {
          walk(node[key], [...path, key], depth + 1);
          if (items.length >= maxItems) return;
        }
      }
    } else {
      const p = path.join('.');
      if (p) push(items, p, 1, 'value', depth);
    }
  };

  walk(parsed, [], 0);
  return items;
}

function buildCsvOutline(content) {
  const lines = String(content || '').split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = lines[0] ? lines[0].split(',') : [];
  const items = [];
  push(items, `Rows: ${Math.max(0, lines.filter((l) => l.trim()).length - 1)}`, 1, 'meta', 0);
  header.forEach((h, idx) => {
    push(items, `Column ${idx + 1}: ${h || `col_${idx + 1}`}`, 1, 'column', 0);
  });
  return items;
}

function buildLogOutline(content, maxItems = 300) {
  const lines = String(content || '').split(/\r?\n/);
  const items = [];
  let errors = 0;
  let warns = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/\b(ERROR|FATAL|CRITICAL|FAIL)\b/i.test(line)) {
      errors += 1;
      if (items.length < maxItems) push(items, `Error: ${line.slice(0, 90)}`, i + 1, 'error', 0);
    } else if (/\bWARN(?:ING)?\b/i.test(line)) {
      warns += 1;
      if (items.length < maxItems) push(items, `Warn: ${line.slice(0, 90)}`, i + 1, 'warn', 0);
    }
  }
  items.unshift({ label: `Warnings: ${warns}`, line: 1, kind: 'meta', depth: 0 });
  items.unshift({ label: `Errors: ${errors}`, line: 1, kind: 'meta', depth: 0 });
  return items.slice(0, maxItems);
}

function buildCodeOutline(content, maxItems = 500) {
  const lines = String(content || '').split(/\r?\n/);
  const items = [];
  const fnRe = /\b((?:async\s+)?function\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z0-9_$]+\s*=>)|class\s+([A-Za-z0-9_$]+)|def\s+([A-Za-z0-9_$]+)|fn\s+([A-Za-z0-9_$]+))/;
  for (let i = 0; i < lines.length && items.length < maxItems; i++) {
    const line = lines[i];
    const m = line.match(fnRe);
    if (!m) continue;
    const name = m[2] || m[3] || m[4] || m[5] || m[6] || 'symbol';
    push(items, name, i + 1, 'symbol', 0);
  }
  return items;
}

export function buildOutline(content, language = 'plaintext', maxItems = 500) {
  const lang = String(language || 'plaintext').toLowerCase();
  if (lang === 'json') return buildJsonOutline(content, maxItems);
  if (lang === 'csv' || lang === 'tsv') return buildCsvOutline(content);
  if (lang === 'log' || lang === 'plaintext') return buildLogOutline(content, maxItems);
  return buildCodeOutline(content, maxItems);
}
