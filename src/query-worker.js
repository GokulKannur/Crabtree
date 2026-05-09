// ============================================
// CRAB TREE — Query Worker (off-main-thread)
// Handles heavy computation: log filtering and
// JSON path location to keep the UI responsive.
// ============================================

import { compileLogQuery, regexSearch } from './query-core.js';
import { findJsonPathSelection } from './json-path-locator.js';

const cancelled = new Set();

function yieldToWorker() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function countNonEmptyLines(content) {
  let total = 0;
  let lineHasText = false;
  for (let i = 0; i <= content.length; i++) {
    const ch = content[i];
    if (i === content.length || ch === '\n' || ch === '\r') {
      if (lineHasText) total++;
      lineHasText = false;
      if (ch === '\r' && content[i + 1] === '\n') i++;
      continue;
    }
    if (!/\s/.test(ch)) lineHasText = true;
  }
  return total;
}

async function filterLogContentChunked(id, content, rawQuery) {
  const text = String(content || '');
  const compiled = compileLogQuery(rawQuery);
  if (!compiled.ok) {
    return {
      error: compiled.error,
      filteredLines: [],
      resultCount: 0,
      totalCount: countNonEmptyLines(text),
      clauseCount: 0,
      termCount: 0,
      clauses: [],
    };
  }

  const filteredLines = [];
  let totalCount = 0;
  let lineStart = 0;
  let scanned = 0;

  for (let i = 0; i <= text.length; i++) {
    if (cancelled.has(id)) throw new Error('cancelled');
    const ch = text[i];
    if (i !== text.length && ch !== '\n' && ch !== '\r') continue;

    const line = text.slice(lineStart, i);
    if (line.trim().length > 0) {
      totalCount++;
      if (compiled.matcher(line)) filteredLines.push(line);
    }

    if (ch === '\r' && text[i + 1] === '\n') i++;
    lineStart = i + 1;
    scanned++;
    if (scanned % 2048 === 0) await yieldToWorker();
  }

  return {
    error: '',
    filteredLines,
    resultCount: filteredLines.length,
    totalCount,
    clauseCount: compiled.clauseCount,
    termCount: compiled.termCount,
    clauses: compiled.clauses,
  };
}

self.onmessage = async function (e) {
  const { id, type, payload } = e.data;

  if (type === 'cancel') {
    cancelled.add(id);
    return;
  }

  try {
    let result;
    switch (type) {
      case 'filterLog':
        result = await filterLogContentChunked(id, payload.content, payload.rawQuery);
        break;
      case 'jsonLocate':
        result = findJsonPathSelection(payload.text, payload.pathTokens);
        break;
      case 'regexSearch':
        result = regexSearch(payload.tabs, payload.pattern, payload.flags, payload.maxMatchesPerTab, payload.timeBudgetMs);
        break;
      default:
        throw new Error(`Unknown worker task type: ${type}`);
    }
    if (cancelled.has(id)) return;
    self.postMessage({ id, type: 'result', payload: result });
  } catch (err) {
    if (err.message === 'cancelled') return;
    self.postMessage({ id, type: 'error', payload: { message: err.message } });
  } finally {
    cancelled.delete(id);
  }
};
