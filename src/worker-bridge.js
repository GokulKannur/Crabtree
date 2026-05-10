// ============================================
// CRAB TREE — Worker Bridge
// Promise-based API over the query Web Worker.
// Automatically cancels stale requests so only
// the latest query result is delivered.
// ============================================

export class WorkerBridge {
  constructor() {
    this._worker = null;
    this._nextId = 0;
    this._pending = new Map();       // id → { resolve, reject, createdAt }
    this._latestByType = new Map();  // taskType → latest request id
    this._disposed = false;
    this._staleTimer = null;
    this._startStaleCleanup();
  }

  /** Periodically reject pending requests older than 30 seconds. */
  _startStaleCleanup() {
    this._staleTimer = setInterval(() => {
      const now = Date.now();
      const staleThreshold = 30_000;
      for (const [id, entry] of this._pending) {
        if (now - entry.createdAt > staleThreshold) {
          entry.reject(new Error('cancelled'));
          this._pending.delete(id);
        }
      }
    }, 10_000);
  }

  _ensureWorker() {
    if (this._disposed) throw new Error('WorkerBridge disposed');
    if (!this._worker) {
      this._worker = new Worker(
        new URL('./query-worker.js', import.meta.url),
        { type: 'module' }
      );
      this._worker.onmessage = (e) => this._onMessage(e);
      this._worker.onerror = (e) => this._onError(e);
    }
    return this._worker;
  }

  _onMessage(e) {
    const { id, type, payload } = e.data;
    const pending = this._pending.get(id);
    if (!pending) return; // stale or already cancelled
    this._pending.delete(id);
    if (type === 'error') {
      pending.reject(new Error(payload.message));
    } else {
      pending.resolve(payload);
    }
  }

  _onError(e) {
    // Worker-level error — reject everything pending
    for (const [, pending] of this._pending) {
      pending.reject(new Error(e.message || 'Worker error'));
    }
    this._pending.clear();
    this._worker = null; // force re-creation next time
  }

  /**
   * Send a task to the worker. Any previous in-flight request of
   * the same taskType is automatically cancelled (its Promise rejects
   * with an Error whose message is 'cancelled').
   */
  _send(taskType, payload) {
    this._ensureWorker();
    const id = ++this._nextId;

    // Cancel any previous request of the same task type
    const prevId = this._latestByType.get(taskType);
    if (prevId !== undefined) {
      const prev = this._pending.get(prevId);
      if (prev) {
        prev.reject(new Error('cancelled'));
        this._pending.delete(prevId);
        this._worker.postMessage({ id: prevId, type: 'cancel' });
      }
    }
    this._latestByType.set(taskType, id);

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, createdAt: Date.now() });
      this._worker.postMessage({ id, type: taskType, payload });
    });
  }

  /** Cancel all pending requests without terminating the worker. */
  cancelAll() {
    for (const [id, entry] of this._pending) {
      entry.reject(new Error('cancelled'));
      if (this._worker) {
        try { this._worker.postMessage({ id, type: 'cancel' }); } catch {}
      }
    }
    this._pending.clear();
    this._latestByType.clear();
  }

  /** Terminate the worker and reject all pending. No further sends allowed. */
  dispose() {
    this._disposed = true;
    if (this._staleTimer) {
      clearInterval(this._staleTimer);
      this._staleTimer = null;
    }
    this.cancelAll();
    if (this._worker) {
      try { this._worker.terminate(); } catch {}
      this._worker = null;
    }
  }

  /** Filter log content — returns the same shape as filterLogContent(). */
  filterLog(content, rawQuery) {
    return this._send('filterLog', { content, rawQuery });
  }

  /** Locate a JSON path in raw text — returns the same shape as findJsonPathSelection(). */
  jsonLocate(text, pathTokens) {
    return this._send('jsonLocate', { text, pathTokens });
  }

  /** Run regex search across tabs in the worker — auto-cancels previous request. */
  regexSearch(tabs, pattern, flags, maxMatchesPerTab = 50, timeBudgetMs = 5000) {
    return this._send('regexSearch', { tabs, pattern, flags, maxMatchesPerTab, timeBudgetMs });
  }
}
