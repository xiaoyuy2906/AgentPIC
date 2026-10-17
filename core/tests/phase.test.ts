import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile, validateIR, SemanticError } from '../src/compiler.js';
import { EngineeringIRSchema, type RunResult, type SimulationResult } from '../src/contracts.js';
import { Runtime } from '../src/runtime.js';
import { simulateCircuit, verifyArtifacts } from '../src/verification.js';
import { projectRoot } from '../src/backends.js';

const specification = JSON.parse(await readFile('examples/tunable_mzi_1550.json', 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'agentpic-phase-'));
const runtime = new Runtime(root);
const python = path.resolve(
  projectRoot,
  process.env.UV_PROJECT_ENVIRONMENT ?? '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
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
    assert.throws(() => compile({ ...specification, phase_control }));
  });
test('schema-valid phase/model/terminal mutations are rejected semantically', () => {
  for (const mutation of ['model', 'terminal', 'domain', 'phase']) {
    const ir = compile(specification);
    const active = ir.netlist.instances.find((i) => i.kind === 'phase_shifter')!;
    if (mutation === 'model') active.kind = 'waveguide';
    if (mutation === 'terminal') delete ir.netlist.ports.phase_e1;
    if (mutation === 'domain') ir.netlist.connections[0].b.port = 'e1';
    if (mutation === 'phase') active.phase_control!.phase_rad += 0.1;
    assert.ok(EngineeringIRSchema.safeParse(ir).success);
    assert.throws(() => validateIR(ir), SemanticError);
  }
});
for (const phase of [0, Math.PI / 2, Math.PI, 2 * Math.PI, -Math.PI / 2])
  test(`balanced MZI phase ${phase} follows independent power law and optical projection`, async () => {
    const result = await simulateCircuit(
      compile({ ...specification, phase_control: { phase_rad: phase } }),
    );
    assert.equal(
      result.verification.status,
      'passed_with_limitations',
      JSON.stringify(result.verification),
    );
    assert.deepEqual(result.simulation.ports, ['in0', 'in1', 'out0', 'out1']);
    for (let n = 0; n < result.simulation.wavelength_nm.length; n++) {
      const expected = Math.sin((phase * 1550) / result.simulation.wavelength_nm[n] / 2) ** 2;
      assert.ok(Math.abs(result.simulation.transmission_out0![n] - expected) < 1e-9);
    }
    assert.equal(
      result.verification.checks.find((c) => c.id === 'phase_actuation_calibration')?.status,
      'not_run',
    );
  });
test('full tuning changes transmission but preserves core and metal geometry', async () => {
  phaseRun = await runtime.run(specification);
  assert.equal(phaseRun.status, 'completed', JSON.stringify(phaseRun));
  const off = await runtime.run({ ...specification, phase_control: { phase_rad: 0 } });
  assert.equal(off.status, 'completed', JSON.stringify(off));
  for (const [run, power] of [
    [phaseRun, 1],
    [off, 0],
  ] as const) {
    const report = await runtime.verifyRun(run.run_id);
    assert.equal(report.status, 'passed_with_limitations', JSON.stringify(report));
    for (const name of [
      'phase_intent_consistency',
      'control_artifact_consistency',
      'phase_layout_intent',
      'gds_actuator_geometry',
      'actuator_terminal_alignment',
    ])
      assert.equal(report.checks.find((c) => c.id === name)?.status, 'pass', name);
    assert.equal(report.checks.filter((c) => c.status === 'not_run').length, 4);
    const sim: SimulationResult = await json(path.join(run.artifact_directory, 'simulation.json'));
    assert.ok(Math.abs(sim.transmission_out0![100] - power) < 1e-9);
  }
  execFileSync(python, [
    '-c',
    `import sys, klayout.db as k
a,b=k.Layout(),k.Layout()
a.read(sys.argv[1]); b.read(sys.argv[2])
assert a.dbu == b.dbu
for layer in [(1,0),(2,0)]:
 r=k.Region(a.top_cell().begin_shapes_rec(a.find_layer(*layer))).merged()
 s=k.Region(b.top_cell().begin_shapes_rec(b.find_layer(*layer))).merged()
 assert not r.is_empty() and (r ^ s).is_empty(), layer
`,
    path.join(phaseRun.artifact_directory, 'design.gds'),
    path.join(off.artifact_directory, 'design.gds'),
  ]);
});
test('verification rejects moved/missing metal, swapped terminals, altered phase and controls', async () => {
  const expectedChecks: Record<string, string> = {
    missing: 'gds_actuator_geometry',
    moved: 'gds_actuator_geometry',
    terminal: 'actuator_terminal_alignment',
    phase: 'phase_intent_consistency',
    controls: 'control_artifact_consistency',
    optical: 'analytic_mzi_agreement',
    shape: 'simulation_shape_and_finiteness',
  };
  for (const [kind, expectedCheck] of Object.entries(expectedChecks)) {
    const directory = path.join(root, `corrupt-${kind}`);
    await cp(phaseRun.artifact_directory, directory, { recursive: true });
    if (kind === 'missing' || kind === 'moved') {
      execFileSync(python, [
        '-c',
        `import sys, klayout.db as k
l=k.Layout(); l.read(sys.argv[1]); idx=l.find_layer(2,0)
r=k.Region(l.top_cell().begin_shapes_rec(idx)).merged()
l.clear_layer(idx)
if sys.argv[2]=='moved': l.top_cell().shapes(idx).insert(r.transformed(k.Trans(0,10000)))
l.write(sys.argv[1])
`,
        path.join(directory, 'design.gds'),
        kind,
      ]);
    } else {
      const file = path.join(
        directory,
        kind === 'terminal'
          ? 'layout.json'
          : kind === 'phase'
            ? 'engineering_ir.json'
            : kind === 'optical' || kind === 'shape'
              ? 'simulation.json'
              : 'controls.json',
      );
      const data = await json(file);
      if (kind === 'terminal')
        [data.ports.top_arm.e1.center_um, data.ports.top_arm.e2.center_um] = [
          data.ports.top_arm.e2.center_um,
          data.ports.top_arm.e1.center_um,
        ];
      if (kind === 'phase')
        data.netlist.instances.find(
          (i: { name: string }) => i.name === 'top_arm',
        ).phase_control.phase_rad = 0;
      if (kind === 'controls') data.top_arm.phase_rad = 0;
      if (kind === 'optical') data.s_real[100][2][0] += 0.2;
      if (kind === 'shape') {
        data.s_real = [];
        data.s_imag = [];
      }
      await writeFile(file, JSON.stringify(data));
    }
    const report = await verifyArtifacts(directory, runtime.backend);
    assert.equal(report.status, 'failed', `${kind}: ${JSON.stringify(report)}`);
    assert.equal(report.checks.find((c) => c.id === expectedCheck)?.status, 'fail', kind);
    assert.equal(
      report.checks.find((c) => c.id === 'phase_actuation_calibration')?.status,
      'not_run',
      kind,
    );
  }
});
test('controlled cascade completes real HTTP/MCP acceptance and exposes both actuators', async () => {
  const output = path.join(root, 'acceptance');
  await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/acceptance.ts',
      '--specification',
      'examples/tunable_cascade_1550.json',
      '--output',
      output,
    ],
    { cwd: projectRoot, maxBuffer: 1024 * 1024 },
  );
  const accepted = await json(path.join(output, 'acceptance.json'));
  assert.equal(accepted.status, 'passed_with_limitations');
  assert.equal(accepted.verification_counts.not_run, 4);
  assert.ok(accepted.transport_artifacts_identical.includes('controls.json'));
  assert.ok(Math.abs(accepted.center_transmission.out0 - 0.5) < 1e-9);
  const layout = await json(path.join(accepted.http_artifact_directory, 'layout.json'));
  assert.equal(Object.keys(layout.actuators).length, 2);
  assert.equal(Object.keys(layout.extracted_circuit.ports).length, 8);
});
test('four stages accept mixed controlled/passive blocks and actuator length boundaries', async () => {
  const run = await runtime.run({
    device: 'mzi_cascade',
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
  });
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.equal((await runtime.verifyRun(run.run_id)).status, 'passed_with_limitations');
});
