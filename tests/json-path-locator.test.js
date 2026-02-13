import test from 'node:test';
import assert from 'node:assert/strict';

import { findJsonPathSelection } from '../src/json-path-locator.js';

const SAMPLE_JSON = `{
  "service": "crabtree-api",
  "stats": {
    "requests": 1204,
    "errors": 7
  },
  "nodes": [
    { "id": "api-1", "status": "healthy" },
    { "id": "api-2", "status": "degraded" }
  ]
}`;

test('findJsonPathSelection finds nested key in object', () => {
  const loc = findJsonPathSelection(SAMPLE_JSON, ['stats', 'errors']);
  assert.ok(loc);
  assert.ok(loc.from >= 0);
  assert.ok(loc.to > loc.from);
  assert.equal(loc.line, 5);
});

test('findJsonPathSelection finds array element path', () => {
  const loc = findJsonPathSelection(SAMPLE_JSON, ['nodes', '1', 'status']);
  assert.ok(loc);
  assert.equal(loc.line, 9);
});

test('findJsonPathSelection returns null for missing path', () => {
  const loc = findJsonPathSelection(SAMPLE_JSON, ['nodes', '3', 'status']);
  assert.equal(loc, null);
});
