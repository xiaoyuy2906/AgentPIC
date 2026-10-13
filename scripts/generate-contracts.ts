import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Contracts } from '../core/src/contracts.js';
mkdirSync('schemas', { recursive: true });
for (const [name, schema] of Object.entries(Contracts))
  writeFileSync(
    `schemas/${name}.schema.json`,
    JSON.stringify(z.toJSONSchema(schema, { io: 'input' }), null, 2) + '\n',
  );
writeFileSync(
  'schemas/contracts.schema.json',
  JSON.stringify(
    z.toJSONSchema(z.strictObject(Contracts).meta({ id: 'Contracts' }), { io: 'input' }),
    null,
    2,
  ) + '\n',
);

const { openAPI } = await import('../core/src/api.js');
writeFileSync('schemas/openapi.json', JSON.stringify(openAPI(), null, 2) + '\n');
