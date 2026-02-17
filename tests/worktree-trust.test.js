import test from 'node:test';
import assert from 'node:assert/strict';

import { WorktreeTrustManager, createTrustSnapshot } from '../src/worktree-trust.js';

test('WorktreeTrustManager trusts exact and child paths', () => {
  delete globalThis.__crabtreeMemoryStorage;
  const manager = new WorktreeTrustManager();
  manager.trustPath('C:\\repo\\project');
  assert.equal(manager.isTrusted('C:\\repo\\project'), true);
  assert.equal(manager.isTrusted('C:\\repo\\project\\src\\main.js'), true);
  assert.equal(manager.isTrusted('C:\\other\\project'), false);
});

test('trust_all bypasses per-path checks', () => {
  delete globalThis.__crabtreeMemoryStorage;
  const manager = new WorktreeTrustManager();
  manager.setTrustAll(true);
  assert.equal(manager.isTrusted('/any/path'), true);
  const snapshot = createTrustSnapshot(manager);
  assert.equal(snapshot.trustAll, true);
  assert.equal(snapshot.restricted, false);
});
