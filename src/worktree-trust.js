// ============================================
// CRAB TREE — Worktree Trust
// Restricted mode + persisted trust decisions.
// ============================================

const TRUST_KEY = 'crabtree-trusted-worktrees';
const TRUST_ALL_KEY = 'crabtree-trust-all-worktrees';

function getStorage() {
  if (typeof localStorage !== 'undefined') return localStorage;
  if (!globalThis.__crabtreeMemoryStorage) {
    const store = {};
    globalThis.__crabtreeMemoryStorage = {
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
      },
      setItem(key, value) {
        store[key] = String(value);
      },
      removeItem(key) {
        delete store[key];
      },
    };
  }
  return globalThis.__crabtreeMemoryStorage;
}

function normalizePath(path) {
  if (!path) return '';
  const text = String(path).replace(/\\/g, '/').trim();
  return text.endsWith('/') ? text.slice(0, -1) : text;
}

function isChildPath(path, root) {
  const p = normalizePath(path);
  const r = normalizePath(root);
  if (!p || !r) return false;
  return p === r || p.startsWith(`${r}/`);
}

function loadTrustedRoots() {
  const storage = getStorage();
  try {
    const parsed = JSON.parse(storage.getItem(TRUST_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizePath).filter(Boolean);
  } catch {
    return [];
  }
}

function saveTrustedRoots(roots) {
  const storage = getStorage();
  storage.setItem(TRUST_KEY, JSON.stringify(Array.from(new Set(roots.map(normalizePath).filter(Boolean)))));
}

export class WorktreeTrustManager {
  constructor() {
    this.currentWorktree = '';
    this.trustedRoots = loadTrustedRoots();
    const storage = getStorage();
    this.trustAll = storage.getItem(TRUST_ALL_KEY) === 'true';
  }

  setCurrentWorktree(path) {
    this.currentWorktree = normalizePath(path);
  }

  setTrustAll(enabled) {
    this.trustAll = Boolean(enabled);
    const storage = getStorage();
    storage.setItem(TRUST_ALL_KEY, this.trustAll ? 'true' : 'false');
  }

  clearAllTrusted() {
    this.trustedRoots = [];
    saveTrustedRoots(this.trustedRoots);
    this.setTrustAll(false);
  }

  trustPath(path) {
    const normalized = normalizePath(path);
    if (!normalized) return;
    if (!this.trustedRoots.includes(normalized)) {
      this.trustedRoots.push(normalized);
      saveTrustedRoots(this.trustedRoots);
    }
  }

  untrustPath(path) {
    const normalized = normalizePath(path);
    this.trustedRoots = this.trustedRoots.filter((r) => r !== normalized);
    saveTrustedRoots(this.trustedRoots);
  }

  isTrusted(path = this.currentWorktree) {
    const candidate = normalizePath(path);
    if (this.trustAll) return true;
    if (!candidate) return false;
    return this.trustedRoots.some((root) => isChildPath(candidate, root));
  }

  getRestrictedReason(path = this.currentWorktree) {
    if (!path) return 'No workspace selected';
    if (this.isTrusted(path)) return '';
    return 'Workspace is untrusted. Risky actions are restricted.';
  }
}

export function createTrustSnapshot(manager) {
  return {
    currentWorktree: manager.currentWorktree,
    trustAll: manager.trustAll,
    trustedRoots: [...manager.trustedRoots],
    restricted: !manager.isTrusted(),
  };
}
