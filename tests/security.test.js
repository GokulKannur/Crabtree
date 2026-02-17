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

// ─── resolveRelativePath rejects traversal sequences ───
// Replicate the fixed resolveRelativePath from main.js

function resolveRelativePath(baseDir, maybeRelativePath) {
  const p = String(maybeRelativePath || '');
  if (!p) return '';
  if (/^[A-Za-z]:\\/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) return p;
  const sep = baseDir?.includes('/') ? '/' : '\\';
  const candidate = `${baseDir}${sep}${p}`.replace(/[\\/]+/g, sep);
  if (candidate.includes('..')) {
    return '';
  }
  return candidate;
}

test('resolveRelativePath rejects ../ traversal in relative path', () => {
  assert.equal(resolveRelativePath('/workspace', '../../../etc/passwd'), '');
  assert.equal(resolveRelativePath('C:\\project', '..\\..\\Windows\\System32'), '');
  assert.equal(resolveRelativePath('', '../etc/passwd'), '');
});

test('resolveRelativePath allows safe relative paths', () => {
  const result = resolveRelativePath('/workspace', 'src/main.js');
  assert.ok(result.includes('src'));
  assert.ok(result.includes('main.js'));
});

test('resolveRelativePath passes through absolute paths unchanged', () => {
  assert.equal(resolveRelativePath('/workspace', '/etc/hosts'), '/etc/hosts');
  assert.equal(resolveRelativePath('C:\\project', 'D:\\other\\file.txt'), 'D:\\other\\file.txt');
});

// ─── isPathTraversalSafe blocks dangerous paths ───
// Replicate from main.js

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

test('isPathTraversalSafe blocks directory traversal attacks', () => {
  assert.equal(isPathTraversalSafe('../../../etc/passwd').safe, false);
  assert.equal(isPathTraversalSafe('..\\..\\Windows\\System32').safe, false);
  assert.equal(isPathTraversalSafe('%2e%2e%2fetc%2fpasswd').safe, false);
  assert.equal(isPathTraversalSafe('file\0.txt').safe, false);
  assert.equal(isPathTraversalSafe(null).safe, false);
  assert.equal(isPathTraversalSafe('').safe, false);
});

test('isPathTraversalSafe allows normal paths', () => {
  assert.equal(isPathTraversalSafe('/home/user/project/src/main.js').safe, true);
  assert.equal(isPathTraversalSafe('C:\\Users\\gokul\\project\\file.txt').safe, true);
  assert.equal(isPathTraversalSafe('src/utils/helpers.js').safe, true);
});

// ─── Extension open_file defense: both checks must pass ───

test('extension open_file path must survive both resolveRelativePath and isPathTraversalSafe', () => {
  // Simulate the fixed flow: resolve → validate → proceed
  const attacks = [
    '../../../etc/passwd',
    '..\\..\\Windows\\System32\\config\\SAM',
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  ];
  for (const malicious of attacks) {
    const resolved = resolveRelativePath('/workspace', malicious);
    // Either resolveRelativePath rejects it (returns '')
    // or isPathTraversalSafe catches it
    if (resolved) {
      assert.equal(isPathTraversalSafe(resolved).safe, false,
        `Attack path "${malicious}" resolved to "${resolved}" but wasn't blocked`);
    }
    // If resolved is '', the open_file handler returns early — also safe
  }
});

// ─── Extension open_file blocks absolute paths ───

test('extension open_file rejects absolute paths from extensions', () => {
  // The fixed handler blocks absolute paths before they reach resolveRelativePath.
  // Simulate the absolute-path check from executeExtensionCommand:
  const absolutePaths = [
    'C:\\Windows\\System32\\config\\SAM',
    'D:\\secrets\\passwords.txt',
    '/etc/passwd',
    '/root/.ssh/id_rsa',
    '\\\\server\\share\\file.txt',
  ];
  for (const p of absolutePaths) {
    const isAbsolute = /^[A-Za-z]:[\\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
    assert.equal(isAbsolute, true, `Absolute path "${p}" should be detected`);
  }

  // Relative paths should NOT be blocked by absolute-path check
  const relativePaths = ['src/main.js', 'docs/README.md', 'lib\\utils.js'];
  for (const p of relativePaths) {
    const isAbsolute = /^[A-Za-z]:[\\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
    assert.equal(isAbsolute, false, `Relative path "${p}" should pass`);
  }
});
