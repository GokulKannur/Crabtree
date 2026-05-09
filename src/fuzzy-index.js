// ============================================
// CRAB TREE — Fuzzy Index & Ranking
// High-signal ranking for palette/finder.
// ============================================

function toLower(value) {
  return String(value || '').toLowerCase();
}

function isWordBoundary(text, idx) {
  if (idx <= 0) return true;
  const prev = text[idx - 1];
  return prev === '/' || prev === '\\' || prev === '_' || prev === '-' || prev === '.' || prev === ' ';
}

export function fuzzyScore(query, target) {
  const q = toLower(query);
  const t = toLower(target);
  if (!q) {
    return { matched: true, score: 0, positions: [] };
  }

  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  const positions = [];

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    positions.push(ti);
    score += 2;

    if (isWordBoundary(target, ti)) score += 10;
    if (ti === lastMatch + 1) score += 8;
    if (ti < 4) score += 4; // prefix bias

    lastMatch = ti;
    qi++;
  }

  if (qi !== q.length) {
    return { matched: false, score: 0, positions: [] };
  }

  // Shorter targets with same matched chars rank higher.
  score -= Math.max(0, t.length - q.length) * 0.12;
  return { matched: true, score, positions };
}

export function buildFuzzyIndex(items, options = {}) {
  const {
    textFields = ['label', 'name', 'displayPath', 'shortcut', 'id'],
    recencyMap = new Map(),
  } = options;

  return items.map((item, idx) => {
    const parts = [];
    for (const field of textFields) {
      const v = item[field];
      if (v) parts.push(String(v));
    }
    const haystack = parts.join(' · ');
    return {
      raw: item,
      idx,
      haystack,
      haystackLower: toLower(haystack),
      recency: Number(recencyMap.get(item.id || item.path || item.name) || 0),
    };
  });
}

export function queryFuzzyIndex(index, query, options = {}) {
  const {
    limit = 40,
    pathField = 'displayPath',
    recencyWeight = 2.5,
    pathDepthPenalty = 0.2,
  } = options;

  const q = toLower(query).trim();
  if (!q) {
    return index
      .slice(0, limit)
      .map((entry) => ({ item: entry.raw, score: entry.recency * recencyWeight, positions: [] }));
  }

  const ranked = [];
  for (const entry of index) {
    // Fast containment precheck: if query chars are impossible, skip early.
    if (q.length > 1 && !entry.haystackLower.includes(q[0])) continue;
    const base = fuzzyScore(q, entry.haystack);
    if (!base.matched) continue;

    const path = String(entry.raw[pathField] || '');
    const depth = path ? path.split(/[\\/]/).length : 0;
    const score =
      base.score +
      entry.recency * recencyWeight -
      Math.max(0, depth - 1) * pathDepthPenalty;

    ranked.push({
      item: entry.raw,
      score,
      positions: base.positions,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

export function recordFuzzyUsage(storageKey, id, now = Date.now()) {
  if (!id) return;
  let parsed = {};
  try {
    parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
  } catch {
    parsed = {};
  }
  parsed[id] = now;
  localStorage.setItem(storageKey, JSON.stringify(parsed));
}

export function loadRecencyMap(storageKey) {
  let parsed = {};
  try {
    parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
  } catch {
    parsed = {};
  }
  const map = new Map();
  for (const [k, v] of Object.entries(parsed)) {
    map.set(k, Number(v) || 0);
  }
  return map;
}
