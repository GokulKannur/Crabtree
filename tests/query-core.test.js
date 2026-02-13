import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileLogQuery,
  filterLogContent,
  parseJsonPathTokens,
  resolveJsonPathValue,
} from '../src/query-core.js';

const SAMPLE_LOG = [
  '2026-02-13 15:40:12 INFO [startup] service=crabtree pid=2248 ip=127.0.0.1 message="server started"',
  '2026-02-13 15:40:17 WARN [cache] service=crabtree pid=2248 ip=127.0.0.1 message="cache miss rate above threshold"',
  '2026-02-13 15:40:24 ERROR [db] service=crabtree pid=2248 ip=127.0.0.1 message="connection failed"',
  '2026-02-13 15:40:29 DEBUG [retry] service=crabtree pid=2248 ip=127.0.0.1 message="retrying request"',
  '2026-02-13 15:40:33 CRITICAL [db] service=crabtree pid=2248 ip=127.0.0.1 message="failover required"',
  '2026-02-13 15:40:35 ERROR [health] service=crabtree pid=2248 ip=127.0.0.1 message="health check failed"',
].join('\n');

test('parseJsonPathTokens parses dot and bracket notation', () => {
  assert.deepEqual(parseJsonPathTokens('stats.errors'), ['stats', 'errors']);
  assert.deepEqual(parseJsonPathTokens('nodes[1].status'), ['nodes', '1', 'status']);
  assert.deepEqual(parseJsonPathTokens('path: metrics["error_count"]'), ['metrics', 'error_count']);
});

test('resolveJsonPathValue resolves found and missing paths', () => {
  const obj = {
    stats: { errors: 7 },
    nodes: [{ id: 'a' }, { id: 'b', status: 'degraded' }],
  };
  assert.deepEqual(resolveJsonPathValue(obj, ['stats', 'errors']), { found: true, value: 7 });
  assert.deepEqual(resolveJsonPathValue(obj, ['nodes', '1', 'status']), { found: true, value: 'degraded' });
  assert.deepEqual(resolveJsonPathValue(obj, ['nodes', '3', 'status']), { found: false, value: undefined });
});

test('compileLogQuery supports AND / OR / NOT clauses', () => {
  const compiled = compileLogQuery('severity:error AND NOT text:"health check" OR severity:critical');
  assert.equal(compiled.ok, true);
  const result = SAMPLE_LOG.split('\n').filter((line) => compiled.matcher(line));
  assert.equal(result.length, 2);
  assert.ok(result.some((line) => line.includes('connection failed')));
  assert.ok(result.some((line) => line.includes('CRITICAL')));
});

test('filterLogContent supports quoted field values and regex', () => {
  const messageHit = filterLogContent(SAMPLE_LOG, 'message:"cache miss rate above threshold"');
  assert.equal(messageHit.error, '');
  assert.equal(messageHit.resultCount, 1);

  const regexHit = filterLogContent(SAMPLE_LOG, 're:/retry(ing)?/i OR severity:warn');
  assert.equal(regexHit.error, '');
  assert.equal(regexHit.resultCount, 2);
});

test('filterLogContent supports generic field filters', () => {
  const allByService = filterLogContent(SAMPLE_LOG, 'service:crabtree');
  assert.equal(allByService.error, '');
  assert.equal(allByService.resultCount, 6);
  assert.equal(allByService.totalCount, 6);
});

test('filterLogContent accepts comma separators as implicit AND', () => {
  const filtered = filterLogContent(SAMPLE_LOG, 'severity:error, NOT text:"health check"');
  assert.equal(filtered.error, '');
  assert.equal(filtered.resultCount, 1);
});

test('compileLogQuery reports invalid expressions', () => {
  const badRegex = compileLogQuery('re:/[abc/');
  assert.equal(badRegex.ok, false);
  assert.match(badRegex.error, /Invalid regex/i);

  const badQuote = compileLogQuery('text:"unterminated');
  assert.equal(badQuote.ok, false);
  assert.match(badQuote.error, /Unterminated quoted value/i);

  const badOr = compileLogQuery('OR severity:error');
  assert.equal(badOr.ok, false);
  assert.match(badOr.error, /Unexpected OR/i);
});
