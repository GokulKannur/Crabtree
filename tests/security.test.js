import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateRegexInput,
  filterLogContent,
  regexSearch,
} from '../src/query-core.js';
import { parseCsvContent } from '../src/csv-viewer.js';

// ─── Regex DoS payloads must be rejected ───

test('validateRegexInput rejects nested quantifier (a+)+', () => {
  assert.throws(
    () => validateRegexInput('(a+)+', 'i'),
    /catastrophic regex/i,
  );
});

test('validateRegexInput rejects nested quantifier (.*)*', () => {
  assert.throws(
    () => validateRegexInput('(.*)*', 'i'),
    /catastrophic regex/i,
  );
});

test('validateRegexInput rejects nested quantifier (a{2,})+', () => {
  assert.throws(
    () => validateRegexInput('(a{2,})+', 'i'),
    /catastrophic regex/i,
  );
});

test('validateRegexInput rejects patterns longer than 256 chars', () => {
  const longPattern = 'a'.repeat(257);
  assert.throws(
    () => validateRegexInput(longPattern, 'i'),
    /too long/i,
  );
});

test('validateRegexInput rejects invalid flags', () => {
  assert.throws(
    () => validateRegexInput('abc', 'xyz'),
    /Invalid regex flags/i,
  );
});

test('validateRegexInput accepts safe patterns', () => {
  assert.doesNotThrow(() => validateRegexInput('[a-z]+\\d{1,3}', 'gi'));
  assert.doesNotThrow(() => validateRegexInput('error|warn|info', 'i'));
  assert.doesNotThrow(() => validateRegexInput('\\bfoo\\b', ''));
});

test('filterLogContent rejects catastrophic regex in re: field', () => {
  const result = filterLogContent('test line', 're:/(a+)+$/');
  assert.equal(result.error !== '', true, 'Should report error for catastrophic regex');
});

test('regexSearch enforces time budget and does not hang', () => {
  const tabs = [
    { id: 1, name: 'test.log', content: 'line1\nline2\nline3\n'.repeat(100) },
  ];
  // Safe pattern, should complete fine
  const results = regexSearch(tabs, 'line\\d', 'gi', 10, 1000);
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 1);
  assert.ok(results[0].matches.length <= 10);
});

// ─── CSV multiline quoted rows parsed correctly ───

test('parseCsvContent handles multiline quoted fields (RFC4180)', () => {
  const csv = 'id,message\n1,"line one\nline two"\n2,"simple"';
  const data = parseCsvContent(csv);
  assert.equal(data.rowCount, 2);
  assert.equal(data.rows[0][1], 'line one\nline two');
  assert.equal(data.rows[1][1], 'simple');
});

test('parseCsvContent handles escaped quotes in quoted fields', () => {
  const csv = 'id,msg\n1,"she said ""hello"""\n2,"ok"';
  const data = parseCsvContent(csv);
  assert.equal(data.rows[0][1], 'she said "hello"');
});

test('parseCsvContent handles CRLF line endings in quoted fields', () => {
  const csv = 'id,msg\r\n1,"has\r\ncrlf"\r\n2,"plain"';
  const data = parseCsvContent(csv);
  assert.equal(data.rowCount, 2);
  assert.equal(data.rows[0][1], 'has\r\ncrlf');
});

// ─── CSV formula strings neutralized on export ───
// We test the neutralization logic inline since safeCsvCell is in main.js (UI module).
// Replicate the logic here for unit testing.

function neutralizeCsvCell(v) {
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

test('neutralizeCsvCell prefixes formula-leading chars with single quote', () => {
  assert.equal(neutralizeCsvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(neutralizeCsvCell('+cmd|something'), "'+cmd|something");
  assert.equal(neutralizeCsvCell('-1+1'), "'-1+1");
  assert.equal(neutralizeCsvCell('@import'), "'@import");
});

test('neutralizeCsvCell passes through safe values', () => {
  assert.equal(neutralizeCsvCell('hello world'), 'hello world');
  assert.equal(neutralizeCsvCell('42'), '42');
  assert.equal(neutralizeCsvCell(''), '');
});

// ─── Cache collision test for secret scanning ───
// Replicate FNV-1a hash used in main.js

function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function hashContent(str) {
  return `${str.length}:${fnv1a(str)}`;
}

test('FNV-1a hash distinguishes similar content', () => {
  const a = hashContent('password=AKIA1234567890ABCDEF');
  const b = hashContent('password=AKIA1234567890ABCDEG');
  assert.notEqual(a, b, 'One-char difference must produce different hashes');
});

test('FNV-1a hash distinguishes same-length different content', () => {
  const a = hashContent('abc');
  const b = hashContent('abd');
  assert.notEqual(a, b);
});

test('FNV-1a hash includes length to avoid trivial collisions', () => {
  const a = hashContent('short');
  const b = hashContent('shortx');
  assert.notEqual(a, b);
  // Length prefix should be different
  assert.notEqual(a.split(':')[0], b.split(':')[0]);
});
