// ============================================
// CRAB TREE — Investigation Workspace
// Multi-source analytical buffer generator.
// ============================================

function timestamp() {
  return new Date().toISOString();
}

export function buildWorkspaceDocument(title, sections) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push(`Generated: ${timestamp()}`);
  lines.push('');

  for (const section of sections) {
    lines.push(`## ${section.title}`);
    lines.push(section.description || '');
    lines.push('');
    for (const item of section.items || []) {
      const marker = `@source(tab=${item.tabId},line=${item.line})`;
      lines.push(`- ${marker} ${item.tabName}:${item.line} :: ${item.text}`);
    }
    lines.push('');
  }

  if (sections.length === 0) {
    lines.push('No investigation data available.');
  }

  return lines.join('\n');
}

export function buildGlobalSearchSection(results = []) {
  const items = [];
  for (const result of results) {
    for (const match of result.matches || []) {
      items.push({
        tabId: result.tabId,
        tabName: result.tabName,
        line: match.line,
        text: String(match.text || '').trim(),
      });
    }
  }
  return {
    title: 'Global Search Matches',
    description: `${items.length} result line${items.length === 1 ? '' : 's'}`,
    items,
  };
}

export function buildProblemsSection(problems = []) {
  return {
    title: 'Problems',
    description: `${problems.length} diagnostics`,
    items: problems.map((p) => ({
      tabId: p.tabId,
      tabName: p.tabName,
      line: p.line,
      text: `[${p.severity}] ${p.text}`,
    })),
  };
}
