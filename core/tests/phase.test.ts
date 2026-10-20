/** Mixed-domain phase shifters: optical projection, metal geometry and electrical terminals. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp } from 'node:fs/promises';
import { compile, validateIR, SemanticError } from '../src/compiler.js';
import { EngineeringIRSchema, type RunResult } from '../src/contracts.js';
import { verifyArtifacts } from '../src/verification.js';
import { designs, mzi, cascade } from '../../designs/templates.js';
import {
  acceptance,
  assertSameGeometry,
  checked,
  corruptCopy,
  json,
  klayout,
  power,
  tempRuntime,
} from './helpers.js';

const specification = designs.mzi_tunable;
const { root, runtime } = await tempRuntime('phase');
let phaseRun: RunResult;

test('phase control emits optical and electrical domains without mixing them', () => {
  const ir = compile(specification);
  const active = ir.netlist.instances.find((i) => i.kind === 'phase_shifter')!;
  assert.equal(active.name, 'top_arm');
  assert.deepEqual(
    active.ports.map((p) => p.domain),
    ['optical', 'optical', 'electrical', 'electrical'],
  );
  assert.equal(Object.keys(ir.netlist.ports).length, 6);
  assert.equal(active.phase_control?.phase_rad, Math.PI);
});
for (const phase_control of [
  { phase_rad: '180 degrees' },
  { phase_rad: 20 },
  { phase_rad: 0, active_length_um: 10 },
  { phase_rad: 0, active_length_um: 201 },
  { voltage: 1 },
  { phase_rad: NaN },
])
  test(`reject malformed or unsupported phase control ${JSON.stringify(phase_control)}`, () => {
    const design = structuredClone(specification) as any;
    design.circuit.instances[2].phase_control = phase_control;
    assert.throws(() => compile(design));
  });
test('schema-valid phase, model and terminal mutations are rejected semantically', () => {
  for (const mutation of ['model', 'terminal', 'domain', 'phase']) {
    const ir = compile(specification);
    const active = ir.netlist.instances.find((i) => i.kind === 'phase_shifter')!;
    if (mutation === 'model') active.kind = 'waveguide';
    if (mutation === 'terminal') delete ir.netlist.ports.phase_e1;
    if (mutation === 'domain') ir.netlist.connections[0].b.port = 'e1';
    if (mutation === 'phase') active.phase_control!.phase_rad += 0.1;
    assert.ok(EngineeringIRSchema.safeParse(ir).success);
    assert.throws(() => validateIR(ir), SemanticError, mutation);
  }
});
test('changing the optical phase changes transmission but not core or metal geometry', async () => {
  phaseRun = await runtime.run(specification);
  assert.equal(phaseRun.status, 'completed', JSON.stringify(phaseRun));
  const off = await runtime.run(
    mzi({ delta_length_um: 0, phase_control: { phase_rad: 0, active_length_um: 100 } }),
  );
  assert.equal(off.status, 'completed', JSON.stringify(off));
  for (const [run, expected] of [
    [phaseRun, 1],
    [off, 0],
  ] as const) {
    const report = await runtime.verifyRun(run.run_id);
    assert.equal(report.status, 'passed_with_limitations', JSON.stringify(report));
    for (const id of [
      'source_intent_consistency',
      'control_artifact_consistency',
      'phase_layout_intent',
      'gds_actuator_geometry',
      'actuator_terminal_alignment',
      'demo_metal_rules',
    ])
      assert.equal(checked(report, id)?.status, 'pass', id);
    assert.equal(report.checks.filter((c) => c.status === 'not_run').length, 4);
    const sim = await json(path.join(run.artifact_directory, 'simulation.json'));
    assert.ok(Math.abs(power(sim, 'out0', 'in0', 100) - expected) < 1e-9);
  }
  assertSameGeometry(
    path.join(phaseRun.artifact_directory, 'design.gds'),
    path.join(off.artifact_directory, 'design.gds'),
  );
});
test('verification rejects moved/missing metal, swapped terminals, altered phase and controls', async () => {
  const faults: Record<string, [string, (d: any) => void, string] | string> = {
    missing: 'gds_actuator_geometry',
    moved: 'gds_actuator_geometry',
    terminal: [
      'layout.json',
      (l) =>
        ([l.ports.top_arm.e1.center_um, l.ports.top_arm.e2.center_um] = [
          l.ports.top_arm.e2.center_um,
          l.ports.top_arm.e1.center_um,
        ]),
      'actuator_terminal_alignment',
    ],
    actuator: [
      'layout.json',
      (l) => (l.actuators.top_arm.centerline_um[0][0] += 5),
      'phase_layout_intent',
    ],
    phase: [
      'engineering_ir.json',
      (ir) =>
        (ir.netlist.instances.find(
          (i: { name: string }) => i.name === 'top_arm',
        ).phase_control.phase_rad = 0),
      'source_intent_consistency',
    ],
    controls: ['controls.json', (c) => (c.top_arm.phase_rad = 0), 'control_artifact_consistency'],
    optical: [
      'simulation.json',
      (s) => (s.s_real[100][2][0] += 0.2),
      'independent_circuit_agreement',
    ],
    shape: [
      'simulation.json',
      (s) => {
        s.s_real = [];
        s.s_imag = [];
      },
      'simulation_shape_and_finiteness',
    ],
  };
  for (const [kind, fault] of Object.entries(faults)) {
    const directory = path.join(root, `corrupt-${kind}`);
    if (typeof fault === 'string') {
      await cp(phaseRun.artifact_directory, directory, { recursive: true });
      klayout(
        `l=k.Layout(); l.read(sys.argv[1]); idx=l.find_layer(2,0)
r=k.Region(l.top_cell().begin_shapes_rec(idx)).merged()
l.clear_layer(idx)
if sys.argv[2]=='moved': l.top_cell().shapes(idx).insert(r.transformed(k.Trans(0,10000)))
l.write(sys.argv[1])`,
        path.join(directory, 'design.gds'),
        kind,
      );
    } else await corruptCopy(phaseRun.artifact_directory, directory, fault[0], fault[1]);
    const id = typeof fault === 'string' ? fault : fault[2];
    const report = await verifyArtifacts(directory, runtime.backend);
    assert.equal(report.status, 'failed', kind);
    assert.equal(checked(report, id)?.status, 'fail', `${kind}: ${id}`);
    assert.equal(checked(report, 'phase_actuation_calibration')?.status, 'not_run', kind);
  }
});
test('controlled cascade completes real HTTP/MCP acceptance and exposes both actuators', async () => {
  const accepted = await acceptance(
    'designs/mzi_cascade_tunable.json',
    path.join(root, 'acceptance'),
  );
  assert.equal(accepted.status, 'passed_with_limitations');
  assert.equal(accepted.verification_counts.not_run, 4);
  assert.ok(accepted.transport_artifacts_identical.includes('controls.json'));
  const sim = await json(path.join(accepted.http_artifact_directory, 'simulation.json'));
  assert.ok(Math.abs(power(sim, 'out0', 'in0', 100) - 0.5) < 1e-9);
  const layout = await json(path.join(accepted.http_artifact_directory, 'layout.json'));
  assert.equal(Object.keys(layout.actuators).length, 2);
  assert.equal(Object.keys(layout.extracted_circuit.ports).length, 8);
});
test('four stages accept mixed controlled/passive blocks and actuator length bounds', async () => {
  const run = await runtime.run(
    cascade({
      stages: [
        {
          name: 'a',
          delta_length_um: -200,
          phase_control: { phase_rad: -Math.PI, active_length_um: 20 },
        },
        { name: 'b', delta_length_um: 0 },
        {
          name: 'c',
          delta_length_um: 200,
          phase_control: { phase_rad: 2 * Math.PI, active_length_um: 200 },
        },
        { name: 'd', delta_length_um: 10 },
      ],
    }),
  );
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.equal((await runtime.verifyRun(run.run_id)).status, 'passed_with_limitations');
});
