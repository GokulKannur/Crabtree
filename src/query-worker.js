// ============================================
// CRAB TREE — Query Worker (off-main-thread)
// Handles heavy computation: log filtering and
// JSON path location to keep the UI responsive.
// ============================================

import { filterLogContent } from './query-core.js';
import { findJsonPathSelection } from './json-path-locator.js';

self.onmessage = function (e) {
  const { id, type, payload } = e.data;

  try {
    let result;
    switch (type) {
      case 'filterLog':
        result = filterLogContent(payload.content, payload.rawQuery);
        break;
      case 'jsonLocate':
        result = findJsonPathSelection(payload.text, payload.pathTokens);
        break;
      default:
        throw new Error(`Unknown worker task type: ${type}`);
    }
    self.postMessage({ id, type: 'result', payload: result });
  } catch (err) {
    self.postMessage({ id, type: 'error', payload: { message: err.message } });
  }
};
