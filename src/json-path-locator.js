// ============================================
// CRAB TREE — JSON Path Locator
// ============================================

function isWs(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

function pathEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}

export function indexToLineCol(text, index) {
  const safe = Math.max(0, Math.min(index, text.length));
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < safe; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastBreak = i;
    }
  }
  return { line, col: safe - lastBreak };
}

export function findJsonPathSelection(text, pathTokens) {
  if (!Array.isArray(pathTokens) || pathTokens.length === 0) return null;

  let i = 0;
  let found = null;

  function skipWs() {
    while (i < text.length && isWs(text[i])) i++;
  }

  function parseString() {
    if (text[i] !== '"') throw new Error('Expected string');
    const from = i;
    i++;
    let value = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === undefined) throw new Error('Invalid escape');
        value += ch + next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        return { value, from, to: i };
      }
      value += ch;
      i++;
    }
    throw new Error('Unterminated string');
  }

  function parseLiteral() {
    const from = i;
    while (i < text.length) {
      const ch = text[i];
      if (ch === ',' || ch === ']' || ch === '}' || isWs(ch)) break;
      i++;
    }
    return { from, to: i };
  }

  function parseValue(path) {
    skipWs();
    const valueStart = i;
    const ch = text[i];
    if (ch === '{') {
      parseObject(path);
      return { from: valueStart, to: i };
    }
    if (ch === '[') {
      parseArray(path);
      return { from: valueStart, to: i };
    }
    if (ch === '"') {
      const str = parseString();
      return { from: str.from, to: str.to };
    }
    const lit = parseLiteral();
    return { from: lit.from, to: lit.to };
  }

  function parseObject(path) {
    if (text[i] !== '{') throw new Error('Expected object');
    i++;
    skipWs();
    if (text[i] === '}') {
      i++;
      return;
    }
    while (i < text.length) {
      skipWs();
      const keyToken = parseString();
      const key = keyToken.value;
      const childPath = [...path, key];

      skipWs();
      if (text[i] !== ':') throw new Error('Expected colon');
      i++;

      const valueRange = parseValue(childPath);
      if (!found && pathEquals(childPath, pathTokens)) {
        found = {
          from: keyToken.from,
          to: keyToken.to,
          valueFrom: valueRange.from,
          valueTo: valueRange.to,
        };
      }

      skipWs();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === '}') {
        i++;
        return;
      }
      throw new Error('Expected comma or object end');
    }
    throw new Error('Unterminated object');
  }

  function parseArray(path) {
    if (text[i] !== '[') throw new Error('Expected array');
    i++;
    skipWs();
    if (text[i] === ']') {
      i++;
      return;
    }
    let idx = 0;
    while (i < text.length) {
      const childPath = [...path, String(idx)];
      const valueRange = parseValue(childPath);
      if (!found && pathEquals(childPath, pathTokens)) {
        found = {
          from: valueRange.from,
          to: valueRange.to,
          valueFrom: valueRange.from,
          valueTo: valueRange.to,
        };
      }
      idx++;

      skipWs();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ']') {
        i++;
        return;
      }
      throw new Error('Expected comma or array end');
    }
    throw new Error('Unterminated array');
  }

  try {
    skipWs();
    parseValue([]);
  } catch {
    return null;
  }

  if (!found) return null;
  const lineCol = indexToLineCol(text, found.from);
  return { ...found, line: lineCol.line, col: lineCol.col };
}
