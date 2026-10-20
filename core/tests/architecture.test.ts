/**
 * The freeze rule: adding a device must not change compiler, simulation, verification or
 * layout code. Device knowledge belongs in designs/ and tests; these checks enforce that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/backends.js';
import { compile } from '../src/compiler.js';
import { designs } from '../../designs/templates.js';

// Generated contracts mirror the Zod source, so scanning them would only repeat it.
const generated = new Set(['src/agentpic/ir.py']);
async function engineFiles() {
  const files: string[] = [];
  const visit = async (dir: string) => {
    for (const entry of await readdir(path.join(projectRoot, dir), { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== '__pycache__') await visit(file);
      else if (/\.(ts|py)$/.test(entry.name) && !generated.has(file)) files.push(file);
    }
  };
  await visit('core/src');
  await visit('src/agentpic');
  return files;
}
const deviceVocabulary =
  /\b(mzi|mzi_cascade|cascade|ring_add_drop|top_arm|bottom_arm|splitter|combiner|right_return|left_return|interconnect_\d+_\d+|in0|in1|out0|out1|delta_length_um|loop_height_um|side_extension_um)\b/i;

test('engine sources never name a device family, device instance or device port', async () => {
  const offences: string[] = [];
  for (const file of await engineFiles()) {
    const lines = (await readFile(path.join(projectRoot, file), 'utf8')).split('\n');
    lines.forEach((line, n) => {
      if (deviceVocabulary.test(line)) offences.push(`${file}:${n + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offences, []);
});
test('engine sources never import design generators or tests', async () => {
  for (const file of await engineFiles()) {
    const source = await readFile(path.join(projectRoot, file), 'utf8');
    assert.doesNotMatch(source, /designs\/|from ['"].*tests\//, file);
  }
});
test('checked-in design files equal their generators and compile without engine changes', async () => {
  const files = (await readdir(path.join(projectRoot, 'designs'))).filter((f) =>
    f.endsWith('.json'),
  );
  assert.deepEqual(files.map((f) => f.slice(0, -5)).sort(), Object.keys(designs).sort());
  for (const [name, design] of Object.entries(designs)) {
    const text = await readFile(path.join(projectRoot, 'designs', `${name}.json`), 'utf8');
    assert.equal(text, JSON.stringify(design, null, 2) + '\n', `${name}: run npm run generate`);
    assert.equal(compile(design).specification.name, name);
  }
});
