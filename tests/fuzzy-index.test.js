import test from 'node:test';
import assert from 'node:assert/strict';

import { fuzzyScore, buildFuzzyIndex, queryFuzzyIndex } from '../src/fuzzy-index.js';

test('fuzzyScore rewards contiguous matches', () => {
  const contiguous = fuzzyScore('abc', 'abc-file');
  const scattered = fuzzyScore('abc', 'a_x_b_x_c');
  assert.equal(contiguous.matched, true);
  assert.equal(scattered.matched, true);
  assert.ok(contiguous.score > scattered.score);
});

test('queryFuzzyIndex ranks matches and truncates to limit', () => {
  const items = [
    { id: 'a', name: 'alpha', displayPath: 'src/alpha.js' },
    { id: 'b', name: 'beta', displayPath: 'src/beta.js' },
    { id: 'g', name: 'gamma', displayPath: 'src/gamma.js' },
  ];
  const index = buildFuzzyIndex(items);
  const out = queryFuzzyIndex(index, 'ga', { limit: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].item.id, 'g');
});
