// ============================================
// CRAB TREE — Query Core (Pure Functions)
// ============================================

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unquote(value) {
  if (!value || value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    const body = value.slice(1, -1);
    return body.replace(/\\(["'\\])/g, '$1');
  }
  return value;
}

function parseRegexValue(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Regex pattern is empty');

  if (raw.startsWith('/')) {
    let lastSlash = -1;
    for (let i = raw.length - 1; i > 0; i--) {
      if (raw[i] === '/' && raw[i - 1] !== '\\') {
        lastSlash = i;
        break;
      }
    }
    if (lastSlash > 0) {
      const pattern = raw.slice(1, lastSlash);
      const flags = raw.slice(lastSlash + 1) || 'i';
      return new RegExp(pattern, flags);
    }
  }

  return new RegExp(raw, 'i');
}

function tokenizeLogQuery(rawQuery) {
  const input = String(rawQuery || '').trim();
  if (!input) return { tokens: [], error: '' };

  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (ch === ',') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (quote) {
    return { tokens: [], error: 'Unterminated quoted value in filter.' };
  }

  if (current) tokens.push(current);
  return { tokens, error: '' };
}

function parseTermPredicate(rawToken) {
  if (!rawToken) return { error: 'Empty filter term.' };

  const token = String(rawToken);
  const splitAt = token.indexOf(':');

  if (splitAt > 0) {
    const field = token.slice(0, splitAt).trim().toLowerCase();
    const valueRaw = token.slice(splitAt + 1).trim();
    const value = unquote(valueRaw);

    if (!value) {
      return { error: `Filter value missing for field "${field}".` };
    }

    if (field === 'severity') {
      const rx = new RegExp(`\\b${escapeRegExp(value)}\\b`, 'i');
      return { predicate: (line) => rx.test(line) };
    }

    if (field === 'ip') {
      const needle = value.toLowerCase();
      return { predicate: (_line, lower) => lower.includes(needle) };
    }

    if (field === 'text' || field === 'msg' || field === 'message') {
      const needle = value.toLowerCase();
      return { predicate: (_line, lower) => lower.includes(needle) };
    }

    if (field === 're' || field === 'regex') {
      try {
        const rx = parseRegexValue(value);
        return { predicate: (line) => rx.test(line) };
      } catch (err) {
        return { error: `Invalid regex: ${err.message}` };
      }
    }

    const fieldNeedleEq = `${field}=${value.toLowerCase()}`;
    const fieldNeedleColon = `${field}:${value.toLowerCase()}`;
    return {
      predicate: (_line, lower) => lower.includes(fieldNeedleEq) || lower.includes(fieldNeedleColon),
    };
  }

  const value = unquote(token);
  if (!value) return { error: 'Empty text filter.' };
  const needle = value.toLowerCase();
  return { predicate: (_line, lower) => lower.includes(needle) };
}

function compileClauseTokens(clauseTokens) {
  const conditions = [];
  let pendingNot = false;

  for (let i = 0; i < clauseTokens.length; i++) {
    const raw = clauseTokens[i];
    const upper = raw.toUpperCase();

    if (raw === '&&' || upper === 'AND') continue;

    if (raw === '!' || upper === 'NOT') {
      pendingNot = !pendingNot;
      continue;
    }

    let token = raw;
    while (token.startsWith('!')) {
      pendingNot = !pendingNot;
      token = token.slice(1);
    }

    if (!token) {
      return { error: 'Invalid NOT usage in filter.' };
    }

    const normalizedToken = token;
    const parsed = parseTermPredicate(token);
    if (parsed.error) return { error: parsed.error };

    conditions.push({ negate: pendingNot, token: normalizedToken, predicate: parsed.predicate });
    pendingNot = false;
  }

  if (pendingNot) {
    return { error: 'Filter cannot end with NOT.' };
  }

  if (conditions.length === 0) {
    return { error: 'Empty filter clause.' };
  }

  return { conditions };
}

export function compileLogQuery(rawQuery) {
  const input = String(rawQuery || '').trim();
  if (!input) {
    return { ok: false, error: 'Filter is empty.' };
  }

  const { tokens, error } = tokenizeLogQuery(input);
  if (error) {
    return { ok: false, error };
  }
  if (tokens.length === 0) {
    return { ok: false, error: 'Filter is empty.' };
  }

  const clauseTokens = [];
  let currentClause = [];

  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (token === '||' || upper === 'OR') {
      if (currentClause.length === 0) {
        return { ok: false, error: 'Unexpected OR operator in filter.' };
      }
      clauseTokens.push(currentClause);
      currentClause = [];
      continue;
    }

    currentClause.push(token);
  }

  if (currentClause.length === 0) {
    return { ok: false, error: 'Filter cannot end with OR.' };
  }
  clauseTokens.push(currentClause);

  const clauses = [];
  let termCount = 0;
  for (const clause of clauseTokens) {
    const compiled = compileClauseTokens(clause);
    if (compiled.error) return { ok: false, error: compiled.error };
    clauses.push(compiled.conditions);
    termCount += compiled.conditions.length;
  }

  return {
    ok: true,
    clauseCount: clauses.length,
    termCount,
    clauses: clauses.map((clause) => clause.map((cond) => ({ token: cond.token, negate: cond.negate }))),
    matcher: (line) => {
      const lower = line.toLowerCase();
      for (const clause of clauses) {
        let match = true;
        for (const cond of clause) {
          const result = cond.predicate(line, lower);
          if ((cond.negate && result) || (!cond.negate && !result)) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
      return false;
    },
  };
}

export function filterLogContent(content, rawQuery) {
  const lines = String(content || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  const compiled = compileLogQuery(rawQuery);
  if (!compiled.ok) {
    return {
      error: compiled.error,
      filteredLines: [],
      resultCount: 0,
      totalCount: lines.length,
      clauseCount: 0,
      termCount: 0,
      clauses: [],
    };
  }

  const filteredLines = lines.filter((line) => compiled.matcher(line));
  return {
    error: '',
    filteredLines,
    resultCount: filteredLines.length,
    totalCount: lines.length,
    clauseCount: compiled.clauseCount,
    termCount: compiled.termCount,
    clauses: compiled.clauses,
  };
}

export function parseJsonPathTokens(rawPath) {
  const input = (rawPath || '').trim();
  if (!input) return [];
  const normalized = input.replace(/^path:\s*/i, '');

  const tokens = [];
  const regex = /([^[.\]]+)|\[(\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\]/g;
  let match;
  while ((match = regex.exec(normalized))) {
    if (match[1]) {
      tokens.push(match[1]);
    } else if (match[2]) {
      tokens.push(unquote(match[2]));
    }
  }
  return tokens;
}

export function resolveJsonPathValue(value, tokens) {
  let current = value;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[idx];
      continue;
    }
    if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, token)) {
      current = current[token];
      continue;
    }
    return { found: false, value: undefined };
  }
  return { found: true, value: current };
}
