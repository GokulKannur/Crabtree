import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsvContent, computeColumnStats } from '../src/csv-viewer.js';

test('computeColumnStats computes null%, cardinality, min/max', () => {
  const header = ['id', 'name', 'score'];
  const rows = [
    ['1', 'alice', '90'],
    ['2', '', '80'],
    ['3', 'alice', ''],
    ['4', 'bob', '100'],
  ];
  const stats = computeColumnStats(header, rows, 3);
  // id column: all filled, 4 unique, numeric
  assert.equal(stats[0].nullPct, '0.0');
  assert.equal(stats[0].cardinality, 4);
  assert.equal(stats[0].isNumeric, true);
  assert.equal(stats[0].minNum, 1);
  assert.equal(stats[0].maxNum, 4);
  // name column: 1 empty out of 4 = 25%
  assert.equal(stats[1].nullPct, '25.0');
  assert.equal(stats[1].cardinality, 2); // alice, bob (empty excluded)
  assert.equal(stats[1].isNumeric, false);
  assert.equal(stats[1].min, 'alice');
  assert.equal(stats[1].max, 'bob');
  // score column: 1 empty, numeric, min 80 max 100
  assert.equal(stats[2].nullPct, '25.0');
  assert.equal(stats[2].isNumeric, true);
  assert.equal(stats[2].minNum, 80);
  assert.equal(stats[2].maxNum, 100);
});

test('parseCsvContent parses comma-separated content', () => {
  const data = parseCsvContent('id,name,status\n1,api-1,healthy\n2,api-2,degraded');
  assert.equal(data.colCount, 3);
  assert.equal(data.rowCount, 2);
  assert.equal(data.header[1], 'name');
  assert.equal(data.rows[1][2], 'degraded');
});

test('parseCsvContent detects tab delimiter', () => {
  const data = parseCsvContent('id\tname\tstatus\n1\tapi-1\thealthy\n2\tapi-2\tdegraded');
  assert.equal(data.delimiter, '\t');
  assert.equal(data.colCount, 3);
});

test('parseCsvContent handles quoted values', () => {
  const data = parseCsvContent('id,message\n1,"cache miss, threshold exceeded"');
  assert.equal(data.rows[0][1], 'cache miss, threshold exceeded');
});
