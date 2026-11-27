// Re-record ONLY when the owner has approved a strategy change:
//   node tests/golden/record.mjs
import { writeFileSync } from 'node:fs';
import { allCases } from './cases.mjs';
const data = await allCases();
// One line per case keeps differences readable in a review.
const section = value => `{\n${Object.entries(value).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n }`;
writeFileSync(new URL('./baseline.json', import.meta.url),
  `{\n${Object.entries(data).map(([k, v]) => ` ${JSON.stringify(k)}: ${Array.isArray(v) ? JSON.stringify(v) : section(v)}`).join(',\n')}\n}\n`);
