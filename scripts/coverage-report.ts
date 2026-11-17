import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface FileCoverage {
  file: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
}

const [kind, source, destination, flag] = process.argv.slice(2);
if (!kind || !source || !destination || !['unit', 'integrated'].includes(kind)) {
  throw new Error('Usage: bun scripts/coverage-report.ts unit|integrated input.lcov report.md [--enforce]');
}

const content = readFileSync(source, 'utf8');
const records: FileCoverage[] = [];
for (const block of content.split('end_of_record')) {
  const field = (name: string): string | undefined =>
    block.split('\n').find((line) => line.startsWith(name + ':'))?.slice(name.length + 1);
  const file = field('SF');
  if (!file) continue;
  const n = (name: string): number => Number(field(name) ?? '0');
  records.push({
    file: file.replace(/^.*\/(src\/)/, '$1'),
    linesFound: n('LF'),
    linesHit: n('LH'),
    functionsFound: n('FNF'),
    functionsHit: n('FNH'),
  });
}
records.sort((a, b) => a.file.localeCompare(b.file));
if (!records.length) throw new Error('Empty coverage report: no source records found');
const sum = (key: 'linesFound' | 'linesHit' | 'functionsFound' | 'functionsHit'): number =>
  records.reduce((result, file) => result + file[key], 0);
const percent = (hit: number, count: number): number => count ? (hit / count) * 100 : 0;
const pct = (hit: number, count: number): string => count ? percent(hit, count).toFixed(2) + '%' : 'n/a';
const lines = percent(sum('linesHit'), sum('linesFound'));
const functions = percent(sum('functionsHit'), sum('functionsFound'));
const report = [
  '# Relatório de cobertura ' + (kind === 'unit' ? 'unitária' : 'integrada'),
  '',
  'Origem: Bun 1.x, arquivo LCOV produzido na CI. Números medidos, não estimados.',
  '',
  '| Métrica | Cobertos | Total | Taxa |',
  '| --- | ---: | ---: | ---: |',
  `| Linhas | ${sum('linesHit')} | ${sum('linesFound')} | ${pct(sum('linesHit'), sum('linesFound'))} |`,
  `| Funções | ${sum('functionsHit')} | ${sum('functionsFound')} | ${pct(sum('functionsHit'), sum('functionsFound'))} |`,
  '',
  '| Arquivo | Linhas | Funções |',
  '| --- | ---: | ---: |',
  ...records.map((record) =>
    `| \`${record.file}\` | ${pct(record.linesHit, record.linesFound)} | ${pct(record.functionsHit, record.functionsFound)} |`,
  ),
  '',
  kind === 'unit'
    ? 'Escopo: `bun test --coverage ./src`. Os testes de infraestrutura não estão neste relatório.'
    : 'Escopo: `bun test --coverage ./src ./test`. Abrange também os testes de PostgreSQL, MiniStack, SQS, races e eventos; o E2E com Keycloak roda em um job distinto.',
  '',
].join('\n');
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, report);
console.log(`Coverage ${kind}: lines=${lines.toFixed(2)}% functions=${functions.toFixed(2)}%`);
if (flag === '--enforce' && (lines < 70 || functions < 70)) {
  throw new Error('Integrated coverage is below the enforced 70% line/function floor');
}
