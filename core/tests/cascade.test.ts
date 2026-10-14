import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { compile, validateIR, SemanticError } from '../src/compiler.js';
import { Runtime } from '../src/runtime.js';
import { simulateCircuit, verifyArtifacts } from '../src/verification.js';
import { EngineeringIRSchema, type RunResult, type VerificationReport } from '../src/contracts.js';
const specification = JSON.parse(await readFile('examples/cascaded_mzi_1550.json', 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'agentpic-cascade-'));
const runtime = new Runtime(root);
let run: RunResult;

test('cascade compiler binds hierarchy, physical assembly and all primitive paths', () => {
  const ir = compile(specification);
  assert.equal(ir.netlist.instances.length, 10);
  assert.equal(ir.netlist.connections.length, 12);
  assert.equal(Object.keys(ir.instance_paths).length, 10);
  assert.equal(ir.assembly?.blocks.length, 2);
  assert.equal(ir.assembly?.links.length, 2);
  assert.ok(ir.hierarchy);
  assert.equal(
    ir.assembly!.links.every((link) => ir.netlist.instances.some((i) => i.name === link.instance)),
    true,
  );
});
for (const [label, stages, link] of [
  ['too few stages', [{ name: 'only', delta_length_um: 0 }], 100],
  [
    'duplicate stage names',
    [
      { name: 'same', delta_length_um: 0 },
      { name: 'same', delta_length_um: 10 },
    ],
    100,
  ],
  ['link outside supported geometry', specification.stages, 0],
] as const)
  test(`cascade rejects ${label}`, () =>
    assert.throws(() => compile({ ...specification, stages, link_length_um: link })));

test('schema-valid hierarchy and physical-plan mutations cannot change declared intent', () => {
  for (const kind of ['module', 'map', 'link'] as const) {
    const ir = compile(specification);
    if (kind === 'module') ir.hierarchy!.definitions.at(-1)!.modules[0].definition = 'missing';
    if (kind === 'map')
      ir.assembly!.blocks[0].primitives.top_arm = ir.assembly!.blocks[0].primitives.bottom_arm;
    if (kind === 'link') ir.assembly!.links[0].b.port = 'in1';
    assert.ok(EngineeringIRSchema.safeParse(ir).success);
    assert.throws(() => validateIR(ir), SemanticError);
  }
});
test('nominal cascade SAX result satisfies an independent two-stage power identity', async () => {
  const result = await simulateCircuit(compile(specification));
  assert.equal(result.verification.status, 'passed_with_limitations');
  const expected = Math.cos((Math.PI * 1.8 * (20 - 10)) / 1.55) ** 2;
  assert.ok(Math.abs(result.simulation.transmission_out0[100] - expected) < 1e-9);
  assert.equal(
    result.verification.checks.find((c) => c.id === 'analytic_cascade_agreement')?.status,
    'pass',
  );
});
test('complete cascade creates connected GDS, backannotates links and verifies independently', async () => {
  run = await runtime.run(specification);
  assert.equal(run.status, 'completed', JSON.stringify(run));
  const report = await runtime.verifyRun(run.run_id);
  assert.equal(report.status, 'passed_with_limitations', JSON.stringify(report));
  for (const name of [
    'hierarchy_intent_consistency',
    'hierarchy_artifact_consistency',
    'requested_interconnect_lengths',
    'layout_netlist_agreement',
    'analytic_cascade_agreement',
    'gds_connected_core',
    'artifact_integrity',
  ])
    assert.equal(report.checks.find((c) => c.id === name)?.status, 'pass', name);
  assert.equal(report.checks.filter((c) => c.status === 'not_run').length, 3);
  const ir = JSON.parse(
    await readFile(path.join(run.artifact_directory, 'engineering_ir.json'), 'utf8'),
  );
  for (const link of ir.assembly.links)
    assert.equal(
      ir.netlist.instances.find((i: { name: string }) => i.name === link.instance).length_um,
      100,
    );
  const layout = JSON.parse(
    await readFile(path.join(run.artifact_directory, 'layout.json'), 'utf8'),
  );
  assert.ok(Math.abs(layout.path_imbalances_um.first - 10) <= 0.002);
  assert.ok(Math.abs(layout.path_imbalances_um.second - 20) <= 0.002);
});
test('four stages include balanced and negative-imbalance blocks in a complete layout', async () => {
  const result = await runtime.run({
    ...specification,
    stages: [-15, 0, 10, 25].map((delta_length_um, i) => ({ name: `stage${i}`, delta_length_um })),
    link_length_um: 50,
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const report = await runtime.verifyRun(result.run_id);
  assert.equal(report.status, 'passed_with_limitations', JSON.stringify(report));
});
test('three-stage links respect the one-nanometer layout grid without losing intent', async () => {
  const result = await runtime.run({
    ...specification,
    stages: [-200, 0, 200].map((delta_length_um, i) => ({ name: `stage${i}`, delta_length_um })),
    link_length_um: 10.0004,
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const report = await runtime.verifyRun(result.run_id);
  assert.equal(report.status, 'passed_with_limitations', JSON.stringify(report));
  const linkCheck = report.checks.find((c) => c.id === 'requested_interconnect_lengths')!;
  assert.equal(linkCheck.status, 'pass');
  assert.ok((linkCheck.evidence.maximum_error_um as number) <= 0.001);
});
test('corrupt module intent, physical interconnect, optical result or GDS cannot pass', async () => {
  for (const kind of ['module', 'interconnect', 'optical', 'geometry']) {
    const directory = path.join(root, `corrupt-${kind}`);
    await cp(run.artifact_directory, directory, { recursive: true });
    if (kind === 'module') {
      const file = path.join(directory, 'engineering_ir.json');
      const ir = JSON.parse(await readFile(file, 'utf8'));
      ir.hierarchy.definitions.at(-1).modules[0].definition = 'missing';
      await writeFile(file, JSON.stringify(ir));
    } else if (kind === 'interconnect') {
      const file = path.join(directory, 'layout.json');
      const layout = JSON.parse(await readFile(file, 'utf8'));
      layout.extracted_circuit.connections = layout.extracted_circuit.connections.filter(
        (c: { a: { instance: string }; b: { instance: string } }) =>
          !c.a.instance.includes('interconnect') && !c.b.instance.includes('interconnect'),
      );
      await writeFile(file, JSON.stringify(layout));
    } else if (kind === 'optical') {
      const file = path.join(directory, 'simulation.json');
      const simulation = JSON.parse(await readFile(file, 'utf8'));
      simulation.s_real[100][2][0] += 0.2;
      await writeFile(file, JSON.stringify(simulation));
    } else await writeFile(path.join(directory, 'design.gds'), 'deliberately corrupted GDS');
    const report = await verifyArtifacts(directory, runtime.backend);
    assert.equal(report.status, 'failed', `${kind}: ${JSON.stringify(report)}`);
  }
});
test('cascade executes through real HTTP and MCP with identical engineering artifacts', async () => {
  const { createAPI } = await import('../src/api.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { projectRoot } = await import('../src/backends.js');
  const server = createAPI(runtime);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let httpRun: RunResult;
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/designs`,
      { method: 'POST', body: JSON.stringify(specification) },
    );
    assert.equal(response.status, 200);
    httpRun = (await response.json()) as RunResult;
    assert.equal(httpRun.status, 'completed', JSON.stringify(httpRun));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const client = new Client({ name: 'cascade-test', version: '1.0' });
  const transport = new StdioClientTransport({
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    command: process.execPath,
    args: ['--import', 'tsx', 'core/src/cli.ts', 'mcp', '--runs-dir', root],
    cwd: projectRoot,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: 'design_pic', arguments: { specification } });
    assert.ok(!response.isError, JSON.stringify(response));
    const result = response.structuredContent as RunResult;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const report = await client.callTool({
      name: 'verify_run',
      arguments: { run_id: result.run_id },
    });
    assert.equal(
      (report.structuredContent as VerificationReport).status,
      'passed_with_limitations',
    );
    for (const name of [
      'design.gds',
      'engineering_ir.json',
      'hierarchy.json',
      'layout.json',
      'simulation.json',
    ])
      assert.equal(
        result.artifacts.find((a) => a.name === name)?.sha256,
        httpRun!.artifacts.find((a) => a.name === name)?.sha256,
        name,
      );
    const gds = await client.readResource({ uri: `agentpic://runs/${result.run_id}/design.gds` });
    assert.ok('blob' in gds.contents[0]);
  } finally {
    await client.close();
  }
});
