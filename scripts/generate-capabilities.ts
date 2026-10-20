/** Rewrite the README capability table from core/src/capabilities.ts. */
import { readFileSync, writeFileSync } from 'node:fs';
import { TABLE_END, TABLE_START, capabilityTable } from '../core/src/capabilities.js';

const readme = readFileSync('README.md', 'utf8');
const start = readme.indexOf(TABLE_START),
  end = readme.indexOf(TABLE_END);
if (start < 0 || end < start) throw new Error('README.md lacks the capability table markers');
writeFileSync(
  'README.md',
  `${readme.slice(0, start)}${TABLE_START}\n${capabilityTable()}\n${readme.slice(end)}`,
);
