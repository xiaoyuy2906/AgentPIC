/** Write designs/*.json from designs/templates.ts; CI fails if the committed files drift. */
import { writeFileSync } from 'node:fs';
import { designs } from '../designs/templates.js';
for (const [name, design] of Object.entries(designs))
  writeFileSync(`designs/${name}.json`, JSON.stringify(design, null, 2) + '\n');
