/** The capability audit must name tests that exist and match the README it generates. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/backends.js';
import { CAPABILITIES, TABLE_END, TABLE_START, capabilityTable } from '../src/capabilities.js';

async function testNames() {
  const names = new Set<string>();
  for (const file of await readdir(path.join(projectRoot, 'core/tests')))
    if (file.endsWith('.test.ts'))
      for (const match of (
        await readFile(path.join(projectRoot, 'core/tests', file), 'utf8')
      ).matchAll(/^\s*test\(\s*(?:'([^']+)'|`([^`$]+)`)/gm))
        names.add(match[1] ?? match[2]);
  for (const file of await readdir(path.join(projectRoot, 'tests')))
    if (file.endsWith('.py'))
      for (const [, fn] of (await readFile(path.join(projectRoot, 'tests', file), 'utf8')).matchAll(
        /^def (test_\w+)/gm,
      ))
        names.add(`tests/${file}::${fn}`);
  return names;
}

test('every implemented or partial capability names tests that exist', async () => {
  const names = await testNames();
  for (const c of CAPABILITIES) {
    if (c.status === 'missing') assert.deepEqual(c.evidence, [], `${c.name} cannot have evidence`);
    else assert.ok(c.evidence.length > 0, `${c.name} needs evidence`);
    for (const evidence of c.evidence)
      assert.ok(names.has(evidence), `${c.name}: no test "${evidence}"`);
    assert.ok(c.limitation.length > 0, `${c.name} needs a stated limitation`);
  }
  assert.equal(new Set(CAPABILITIES.map((c) => c.name)).size, CAPABILITIES.length);
});
test('the README capability table is generated from the registry', async () => {
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
  const table = readme.slice(
    readme.indexOf(TABLE_START) + TABLE_START.length,
    readme.indexOf(TABLE_END),
  );
  assert.equal(table.trim(), capabilityTable(), 'run npm run generate');
});
