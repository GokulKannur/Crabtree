import test from 'node:test';
import assert from 'node:assert/strict';

import { collectDiagnostics, summarizeDiagnostics, toCodeMirrorDiagnostics } from '../src/diagnostics-core.js';

test('collectDiagnostics returns JSON parse error for invalid json', () => {
  const out = collectDiagnostics('{"a":', 'json');
  assert.ok(out.some((d) => d.severity === 'error'));
});

test('collectDiagnostics identifies log severities', () => {
  const content = [
    '2026-02-15 ERROR service=db message="down"',
    '2026-02-15 WARN service=api message="slow"',
  ].join('\n');
  const out = collectDiagnostics(content, 'log');
  const summary = summarizeDiagnostics(out);
  assert.ok(summary.error >= 1);
  assert.ok(summary.warning >= 1);
});

test('toCodeMirrorDiagnostics maps line/column to from/to ranges', () => {
  const out = toCodeMirrorDiagnostics('line1\nline2   ', 'plaintext');
  assert.ok(Array.isArray(out));
  assert.ok(out.length > 0);
  assert.ok(typeof out[0].from === 'number');
});
