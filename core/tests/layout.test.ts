/** Generic placement, Manhattan routing, extraction, backannotation and layout constraints. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, writeFile } from 'node:fs/promises';
import { compile } from '../src/compiler.js';
import { PythonBackend } from '../src/backends.js';
import { verifyArtifacts } from '../src/verification.js';
import type { RunResult } from '../src/contracts.js';
import { designs, cascade, ring, type DesignInput } from '../../designs/templates.js';
import { checked, corruptCopy, json, klayout, tempRuntime } from './helpers.js';

const { root, runtime } = await tempRuntime('layout');
const runs: Record<string, RunResult> = {};
const completed = async (design: DesignInput) => {
  const run = await runtime.run(design);
  assert.equal(run.status, 'completed', JSON.stringify(run));
  const report = await runtime.verifyRun(run.run_id);
  assert.equal(report.status, 'passed_with_limitations', JSON.stringify(report));
  return { run, report };
};

for (const name of ['mzi', 'mzi_cascade', 'ring'] as const)
  test(`${name} layout plan produces connected GDS, measured lengths and satisfied constraints`, async () => {
    const { run, report } = await completed(designs[name]);
    runs[name] = run;
    for (const id of [
      'layout_plan',
      'layout_netlist_agreement',
      'physical_port_alignment',
      'physical_length_backannotation',
      'layout_constraints',
      'gds_readback',
      'gds_connected_core',
      'demo_bend_radius',
      'gds_contains_waveguide_centerlines',
      'workflow_state_consistency',
      'artifact_integrity',
    ])
      assert.equal(checked(report, id)?.status, 'pass', `${name}: ${id}`);
    assert.equal(report.checks.filter((c) => c.status === 'not_run').length, 3);
    const ir = await json(path.join(run.artifact_directory, 'engineering_ir.json'));
    assert.equal(ir.length_source, 'layout');
    const gds = await json(path.join(run.artifact_directory, 'layout.json'));
    assert.ok(gds.extracted_circuit);
  });
test('arm imbalance and link lengths are measured from the routed geometry', async () => {
  const constraints = async (name: string) =>
    checked(await runtime.verifyRun(runs[name].run_id), 'layout_constraints')!.evidence
      .constraints as { kind: string; actual_um: number; value_um: number }[];
  const mzi = await constraints('mzi');
  assert.ok(Math.abs(mzi[0].actual_um - 10) <= 0.002);
  const chain = await constraints('mzi_cascade');
  assert.deepEqual(
    chain.map((c) => c.kind),
    ['length_difference', 'length_difference', 'length', 'length'],
  );
  for (const c of chain) assert.ok(Math.abs(c.actual_um - c.value_um) <= 0.002);
});
test('the same design reproduces GDS and circuit JSON in separate backend processes', async () => {
  const second = await runtime.run(designs.mzi);
  for (const name of [
    'design.gds',
    'engineering_ir.json',
    'netlist.json',
    'layout.json',
    'simulation.json',
  ])
    assert.equal(
      runs.mzi.artifacts.find((a) => a.name === name)?.sha256,
      second.artifacts.find((a) => a.name === name)?.sha256,
      name,
    );
});
test('negative, zero and large imbalances route in a four-stage series layout', async () => {
  await completed(
    cascade({
      stages: [-15, 0, 10, 25].map((delta_length_um, i) => ({
        name: `stage${i}`,
        delta_length_um,
      })),
      link_length_um: 50,
    }),
  );
});
test('anchored placement keeps sub-nanometre link requests within the 1 nm layout grid', async () => {
  const { report } = await completed(
    cascade({
      stages: [-200, 0, 200].map((delta_length_um, i) => ({ name: `stage${i}`, delta_length_um })),
      link_length_um: 10.0004,
    }),
  );
  const links = (
    checked(report, 'layout_constraints')!.evidence.constraints as {
      kind: string;
      error_um: number;
    }[]
  ).filter((c) => c.kind === 'length');
  assert.ok(links.every((c) => c.error_um <= 0.001));
});
test('ring loop and extension bounds still route, with the actuator on the longest straight', async () => {
  for (const [loop_height_um, side_extension_um, active_length_um] of [
    [200, 150, 20],
    [600, 500, 200],
  ])
    await completed(
      ring({
        loop_height_um,
        side_extension_um,
        phase_control: { phase_rad: 0, active_length_um },
      }),
    );
});
test('the layout engine rejects routes that cannot be drawn with the PDK bend radius', async () => {
  const backend = new PythonBackend();
  const tight = structuredClone(designs.mzi) as any;
  tight.layout.routes.top_arm.steps[0] = { dx_um: 20 };
  await assert.rejects(
    () => backend.layout(compile(tight), root),
    /too short for the PDK bend radius/,
  );
  const backwards = structuredClone(designs.mzi) as any;
  backwards.layout.routes.top_arm.steps = [{ dx_um: -100 }];
  await assert.rejects(() => backend.layout(compile(backwards), root), /leave its start port/);
  const clash = structuredClone(designs.mzi) as any;
  clash.layout.placements.combiner.x_um = 60;
  const run = await runtime.run(clash);
  assert.equal(run.status, 'failed');
  assert.ok(run.error);
});
test('violated layout constraints fail verification with measured evidence', async () => {
  const wrong = structuredClone(designs.mzi) as any;
  wrong.layout.constraints[0].value_um = 12;
  const run = await runtime.run(wrong);
  assert.equal(run.status, 'failed');
  const report = await runtime.verifyRun(run.run_id);
  const constraint = checked(report, 'layout_constraints')!;
  assert.equal(constraint.status, 'fail');
  assert.ok(
    Math.abs((constraint.evidence.constraints as { error_um: number }[])[0].error_um - 2) < 0.002,
  );
});
test('corrupt extraction, geometry, lengths, links and removed GDS segments cannot pass', async () => {
  const faults: Record<string, [string, (d: any) => void, string]> = {
    topology: [
      'layout.json',
      (l) => l.extracted_circuit.connections.pop(),
      'layout_netlist_agreement',
    ],
    port: [
      'layout.json',
      (l) => (l.ports.combiner.o1.center_um[0] += 1),
      'physical_port_alignment',
    ],
    centerline: [
      'layout.json',
      (l) =>
        (l.centerlines_um.right_return[Math.floor(l.centerlines_um.right_return.length / 2)][0] +=
          10),
      'physical_length_backannotation',
    ],
    length: [
      'engineering_ir.json',
      (ir) =>
        (ir.netlist.instances.find((i: { name: string }) => i.name === 'left_return').length_um +=
          1),
      'physical_length_backannotation',
    ],
  };
  for (const [fault, [file, edit, id]] of Object.entries(faults)) {
    const dir = path.join(root, `corrupt-${fault}`);
    const source = fault === 'port' ? runs.mzi : runs.ring;
    await corruptCopy(source.artifact_directory, dir, file, edit);
    const report = await verifyArtifacts(dir);
    assert.equal(report.status, 'failed', fault);
    assert.equal(
      checked(report, id)?.status,
      'fail',
      `${fault}: ${JSON.stringify(report.checks.filter((c) => c.status === 'fail'))}`,
    );
  }
  const links = path.join(root, 'corrupt-links');
  await corruptCopy(runs.mzi_cascade.artifact_directory, links, 'layout.json', (l) => {
    l.extracted_circuit.connections = l.extracted_circuit.connections.filter(
      (c: { a: { instance: string }; b: { instance: string } }) =>
        !c.a.instance.includes('interconnect') && !c.b.instance.includes('interconnect'),
    );
  });
  assert.equal((await verifyArtifacts(links)).status, 'failed');
  const removed = path.join(root, 'corrupt-gds-segment');
  await cp(runs.ring.artifact_directory, removed, { recursive: true });
  klayout(
    `l=k.Layout();l.read(sys.argv[1]);idx=l.find_layer(1,0)
r=k.Region(l.top_cell().begin_shapes_rec(idx)).merged()
r-=k.Region(k.Box(248000,145000,252000,155000))
l.clear_layer(idx);l.top_cell().shapes(idx).insert(r);l.write(sys.argv[1])`,
    path.join(removed, 'design.gds'),
  );
  assert.equal(
    checked(await verifyArtifacts(removed), 'gds_contains_waveguide_centerlines')?.status,
    'fail',
  );
  const broken = path.join(root, 'corrupt-gds');
  await cp(runs.mzi.artifact_directory, broken, { recursive: true });
  await writeFile(path.join(broken, 'design.gds'), 'deliberately corrupted GDS');
  assert.equal((await verifyArtifacts(broken)).status, 'failed');
});
test('a design without a layout plan exports no GDS and reports layout as not_run', async () => {
  const run = await runtime.run(designs.coupler);
  assert.equal(run.status, 'completed');
  assert.ok(!run.artifacts.some((a) => a.name.endsWith('.gds') || a.name === 'layout.json'));
  const report = await runtime.verifyRun(run.run_id);
  assert.equal(checked(report, 'layout_generation')?.status, 'not_run');
  assert.equal(checked(report, 'layout_boundary')?.status, 'pass');
  await assert.rejects(
    () => new PythonBackend().layout(compile(designs.coupler), root),
    /no layout plan/,
  );
});
