import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { filterLogContent, parseJsonPathTokens, resolveJsonPathValue } from '../src/query-core.js';
import { findJsonPathSelection } from '../src/json-path-locator.js';

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

async function main() {
  const sizes = process.argv.includes('--quick') ? [10, 25] : [50, 200];
  const results = [];

  for (const size of sizes) {
    const row = benchmarkScenario(size);
    results.push(row);
    console.log(
      `[bench] ${row.dataset} :: parse=${row.json_parse_ms}ms, path=${row.json_path_ms}ms, locate=${row.json_locate_ms}ms, filter=${row.log_filter_ms}ms, rss=${row.rss_mb}MB`
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
