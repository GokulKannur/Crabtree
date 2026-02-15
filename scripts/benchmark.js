import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { filterLogContent, parseJsonPathTokens, resolveJsonPathValue, validateRegexInput, regexSearch } from '../src/query-core.js';
import { findJsonPathSelection } from '../src/json-path-locator.js';
import { parseCsvContent } from '../src/csv-viewer.js';

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function msDiff(start) {
  return Number((performance.now() - start).toFixed(2));
}

function buildJsonData(targetMb) {
  const targetBytes = targetMb * 1024 * 1024;
  const rows = [];
  let estimated = 0;
  let i = 0;

  while (estimated < targetBytes) {
    const row = `{"id":${i},"service":"crabtree","env":"prod","status":"ok","node":"api-${i % 64}","stats":{"errors":${i % 17},"latency_ms":${80 + (i % 220)}}}`;
    rows.push(row);
    estimated += row.length + 1;
    i++;
  }

  return `{"items":[${rows.join(',')}],"summary":{"total":${rows.length},"errors":${Math.floor(rows.length / 17)}}}`;
}

function buildLogData(targetMb) {
  const targetBytes = targetMb * 1024 * 1024;
  const lines = [];
  let estimated = 0;
  let i = 0;

  while (estimated < targetBytes) {
    const level = i % 9 === 0 ? 'ERROR' : i % 5 === 0 ? 'WARN' : 'INFO';
    const line = `2026-02-13 15:${String((i / 60) % 60 | 0).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} ${level} service=crabtree host=api-${i % 32} ip=10.0.${i % 16}.${i % 255} message="event ${i}"`;
    lines.push(line);
    estimated += line.length + 1;
    i++;
  }

  return lines.join('\n');
}

function benchmarkScenario(sizeMb) {
  const jsonContent = buildJsonData(sizeMb);
  const logContent = buildLogData(sizeMb);
  const jsonBytes = Buffer.byteLength(jsonContent);
  const logBytes = Buffer.byteLength(logContent);

  const parseStart = performance.now();
  const parsed = JSON.parse(jsonContent);
  const jsonParseMs = msDiff(parseStart);

  const pathTokens = parseJsonPathTokens('summary.errors');
  const pathStart = performance.now();
  const resolved = resolveJsonPathValue(parsed, pathTokens);
  const jsonPathMs = msDiff(pathStart);

  const locateStart = performance.now();
  const located = findJsonPathSelection(jsonContent, pathTokens);
  const jsonLocateMs = msDiff(locateStart);

  const filterStart = performance.now();
  const filtered = filterLogContent(logContent, 'severity:error AND NOT text:"health check" OR re:/event\\s+[0-9]+/');
  const logFilterMs = msDiff(filterStart);

  const memoryMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1));

  return {
    dataset: `${sizeMb}MB`,
    json_size: mb(jsonBytes),
    log_size: mb(logBytes),
    json_parse_ms: jsonParseMs,
    json_path_ms: jsonPathMs,
    json_locate_ms: jsonLocateMs,
    log_filter_ms: logFilterMs,
    resolved: resolved.found,
    located: Boolean(located),
    log_matches: filtered.resultCount,
    rss_mb: memoryMb,
  };
}

function toMarkdown(results) {
  const header = [
    '| Dataset | JSON Parse (ms) | JSON Path (ms) | JSON Locate (ms) | Log Filter (ms) | RSS (MB) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];

  const rows = results.map((row) =>
    `| ${row.dataset} | ${row.json_parse_ms} | ${row.json_path_ms} | ${row.json_locate_ms} | ${row.log_filter_ms} | ${row.rss_mb} |`
  );

  return `${header.concat(rows).join('\n')}\n`;
}

// ─── Stress / Security Scenarios ───

function buildCsvData(targetMb) {
  const targetBytes = targetMb * 1024 * 1024;
  const lines = ['id,name,status,message'];
  let estimated = lines[0].length + 1;
  let i = 0;
  while (estimated < targetBytes) {
    const line = `${i},"service-${i % 100}",${i % 3 === 0 ? 'error' : 'ok'},"event message ${i} with ""quotes"""`;
    lines.push(line);
    estimated += line.length + 1;
    i++;
  }
  return lines.join('\n');
}

function stressScenarios(sizeMb) {
  const results = {};

  // CSV parsing stress test
  const csvContent = buildCsvData(sizeMb);
  const csvStart = performance.now();
  const parsed = parseCsvContent(csvContent);
  results.csv_parse_ms = msDiff(csvStart);
  results.csv_rows = parsed.rowCount;

  // Regex validation stress: validate many patterns
  const patterns = [
    { p: '[a-z]+\\d{1,3}', f: 'gi' },
    { p: 'error|warn|info', f: 'i' },
    { p: '\\bfoo\\b', f: '' },
    { p: '\\d{4}-\\d{2}-\\d{2}', f: 'g' },
  ];
  const valStart = performance.now();
  for (let i = 0; i < 10000; i++) {
    const pat = patterns[i % patterns.length];
    validateRegexInput(pat.p, pat.f);
  }
  results.regex_validate_10k_ms = msDiff(valStart);

  // regexSearch across multiple tabs
  const logContent = buildLogData(Math.min(sizeMb, 5));
  const tabs = Array.from({ length: 10 }, (_, i) => ({
    id: i,
    name: `tab-${i}.log`,
    content: logContent,
  }));
  const searchStart = performance.now();
  const searchResults = regexSearch(tabs, 'ERROR', 'gi', 50, 5000);
  results.regex_search_10tabs_ms = msDiff(searchStart);
  results.regex_search_total_matches = searchResults.reduce((s, r) => s + r.matches.length, 0);

  return results;
}

// ─── Regression Thresholds (CI gating) ───
const THRESHOLDS = {
  // Maximum allowed milliseconds per scenario at given size
  '10MB': { json_parse_ms: 2000, log_filter_ms: 3000, csv_parse_ms: 3000 },
  '25MB': { json_parse_ms: 5000, log_filter_ms: 8000, csv_parse_ms: 8000 },
};

function checkThresholds(results, stressResults) {
  const failures = [];
  for (const row of results) {
    const limits = THRESHOLDS[row.dataset];
    if (!limits) continue;
    for (const [key, max] of Object.entries(limits)) {
      const actual = key.startsWith('csv_') ? stressResults[row.dataset]?.[key] : row[key];
      if (actual !== undefined && actual > max) {
        failures.push(`${row.dataset}/${key}: ${actual}ms exceeds threshold ${max}ms`);
      }
    }
  }
  return failures;
}

async function main() {
  const isCI = process.argv.includes('--ci');
  const sizes = process.argv.includes('--quick') || isCI ? [10, 25] : [50, 200];
  const results = [];
  const stressMap = {};

  for (const size of sizes) {
    const row = benchmarkScenario(size);
    results.push(row);
    console.log(
      `[bench] ${row.dataset} :: parse=${row.json_parse_ms}ms, path=${row.json_path_ms}ms, locate=${row.json_locate_ms}ms, filter=${row.log_filter_ms}ms, rss=${row.rss_mb}MB`
    );

    const stress = stressScenarios(size);
    stressMap[row.dataset] = stress;
    console.log(
      `[stress] ${row.dataset} :: csv=${stress.csv_parse_ms}ms (${stress.csv_rows} rows), validate10k=${stress.regex_validate_10k_ms}ms, search10tabs=${stress.regex_search_10tabs_ms}ms`
    );
  }

  const output = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    results,
  };

  await mkdir('benchmark', { recursive: true });
  await writeFile('benchmark/latest.json', JSON.stringify(output, null, 2), 'utf8');
  await writeFile('benchmark/latest.md', toMarkdown(results), 'utf8');

  console.log('\nBenchmark summary:\n');
  console.log(toMarkdown(results));
  console.log('Wrote benchmark/latest.json and benchmark/latest.md');

  // CI threshold gating
  if (isCI) {
    const failures = checkThresholds(results, stressMap);
    if (failures.length > 0) {
      console.error('\n❌ BENCHMARK REGRESSION DETECTED:');
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    } else {
      console.log('\n✅ All benchmarks within thresholds.');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
