/**
 * Generate test data files for manual VS Code comparison benchmarks.
 *
 * Produces:
 *   benchmark/comparison-50mb.json
 *   benchmark/comparison-200mb.json
 *   benchmark/comparison-200mb.log
 *
 * These are the same synthetic datasets used by `npm run benchmark`,
 * persisted to disk so they can be opened in VS Code for head-to-head timing.
 *
 * Usage:
 *   node scripts/generate-comparison-files.js
 */

import { mkdir, writeFile } from 'node:fs/promises';

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

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function main() {
  await mkdir('benchmark', { recursive: true });

  const files = [
    { name: 'comparison-50mb.json', gen: () => buildJsonData(50) },
    { name: 'comparison-200mb.json', gen: () => buildJsonData(200) },
    { name: 'comparison-200mb.log', gen: () => buildLogData(200) },
  ];

  for (const { name, gen } of files) {
    process.stdout.write(`Generating benchmark/${name} ... `);
    const content = gen();
    await writeFile(`benchmark/${name}`, content, 'utf8');
    console.log(`${mb(Buffer.byteLength(content))} MB ✓`);
  }

  console.log('\nDone. Open these files in VS Code to measure comparison timings.');
  console.log('See README.md → "VS Code comparison" section for instructions.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
