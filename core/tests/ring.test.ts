import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile, validateIR } from '../src/compiler.js';
import { RingSpecSchema, type RunResult, type VerificationReport } from '../src/contracts.js';
import { Runtime } from '../src/runtime.js';
import { simulateCircuit, verifyArtifacts } from '../src/verification.js';
import { projectRoot } from '../src/backends.js';
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const spec = RingSpecSchema.parse(await json('examples/ring_1550.json'));
const root = await mkdtemp(path.join(tmpdir(), 'agentpic-ring-'));
const runtime = new Runtime(root);
const checked = (report: VerificationReport, id: string) => report.checks.find((c) => c.id === id)!;
const python = path.resolve(
  projectRoot,
  process.env.UV_PROJECT_ENVIRONMENT ?? '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
let passive: RunResult;

test('ring recipe compiles a closed feedback cycle with traceable optical ports', () => {
  const ir = compile(spec);
  assert.equal(ir.netlist.instances.length, 4);
  assert.equal(ir.netlist.connections.length, 4);
  const degrees = new Map<string, number>();
  for (const { a, b } of ir.netlist.connections)
    for (const e of [a, b]) degrees.set(e.instance, (degrees.get(e.instance) ?? 0) + 1);
  assert.ok([...degrees.values()].every((d) => d === 2));
  assert.deepEqual(Object.keys(ir.netlist.ports), ['in0', 'in1', 'out0', 'out1']);
  assert.equal(ir.length_source, 'specification');
  for (const mutation of ['ratio', 'connection', 'port', 'phase', 'hierarchy']) {
    const bad = structuredClone(ir);
    if (mutation === 'ratio') bad.netlist.instances[0].coupling_ratio = 0.4;
    if (mutation === 'connection')
      [bad.netlist.connections[0].b, bad.netlist.connections[2].b] = [
        bad.netlist.connections[2].b,
        bad.netlist.connections[0].b,
      ];
    if (mutation === 'port')
      [bad.netlist.ports.in0, bad.netlist.ports.in1] = [
        bad.netlist.ports.in1,
        bad.netlist.ports.in0,
      ];
    if (mutation === 'phase') bad.operating_point = { right_return: 1 };
    if (mutation === 'hierarchy') bad.instance_paths = { right_return: ['fake'] };
    assert.throws(() => validateIR(bad), mutation);
  }
});
test('unsupported ring dimensions, ratios, fields and actuator fit are rejected', () => {
  for (const extra of [
    { loop_height_um: 199 },
    { side_extension_um: 501 },
    { coupling_ratios: [0, 0.5] },
    { coupling_ratios: [0.5, 0.9] },
    { coupling_ratios: [0.5] },
    { gap_um: 0.2 },
    { delta_length_um: 10 },
    { phase_control: { phase_rad: 0, active_length_um: 200 }, side_extension_um: 150 },
    { sweep_points: 10003 },
  ])
    assert.throws(() => compile({ ...spec, ...extra }));
});
for (const ratios of [
  [0.5, 0.5],
  [0.3, 0.6],
  [0.8, 0.8],
])
  test(`feedback resonance and full complex response with coupling ${ratios}`, async () => {
    const ir = compile({ ...spec, coupling_ratios: ratios });
    const length = ir.netlist.instances
      .filter((i) => i.length_um !== null)
      .reduce((s, i) => s + i.length_um!, 0);
    const cycles = (1.8 * length) / 1.55;
    const phase = 2 * Math.PI * (Math.round(cycles) - cycles);
    const result = await simulateCircuit(
      compile({ ...spec, coupling_ratios: ratios, phase_control: { phase_rad: phase } }),
    );
    assert.equal(
      result.verification.status,
      'passed_with_limitations',
      JSON.stringify(result.verification),
    );
    const expected =
      (ratios[0] * ratios[1]) / (1 - Math.sqrt((1 - ratios[0]) * (1 - ratios[1]))) ** 2;
    assert.ok(Math.abs(result.simulation.transmission_out1![500] - expected) < 1e-9);
    assert.ok(Math.abs(result.simulation.transmission_out0![500] - (1 - expected)) < 1e-9);
    assert.equal(checked(result.verification, 'analytic_ring_agreement').status, 'pass');
    assert.equal(checked(result.verification, 'resonance_sampling').status, 'pass');
    assert.equal(checked(result.verification, 'resonance_features').status, 'pass');
  });
test('passive ring produces measured return paths, GDS and independently resolved resonances', async () => {
  passive = await runtime.run(spec);
  assert.equal(passive.status, 'completed', JSON.stringify(passive));
  const report = await runtime.verifyRun(passive.run_id);
  assert.equal(report.status, 'passed_with_limitations', JSON.stringify(report));
  assert.equal(checked(report, 'requested_ring_dimensions').status, 'pass');
  const metrics = checked(report, 'resonance_features').evidence;
  assert.ok((metrics.observed_resonances_nm as number[]).length >= 2);
  assert.ok((metrics.observed_linewidths_nm as number[]).every((w) => w > 0));
  const ir = await json(path.join(passive.artifact_directory, 'engineering_ir.json'));
  assert.equal(ir.length_source, 'layout');
  assert.ok(
    ir.netlist.instances.find((i: { name: string }) => i.name === 'right_return').length_um !==
      compile(spec).netlist.instances[2].length_um,
  );
});
test('undersampled and clipped full workflows fail spectral checks despite correct sampled S-matrices', async () => {
  for (const [extra, id] of [
    [{ sweep_points: 21 }, 'resonance_sampling'],
    [{ sweep_span_nm: 0.1, sweep_points: 101 }, 'resonance_features'],
  ] as const) {
    const run = await runtime.run({ ...spec, ...extra });
    assert.equal(run.status, 'failed');
    assert.equal(run.verification_status, 'failed');
    const report = await runtime.verifyRun(run.run_id);
    assert.equal(checked(report, 'analytic_ring_agreement').status, 'pass');
    assert.equal(checked(report, id).status, 'fail');
    assert.ok(run.artifacts.some((a) => a.name === 'design.gds'));
  }
});
test('weakly coupled narrow resonances require and pass an explicitly refined sampling grid', async () => {
  const request = { ...spec, coupling_ratios: [0.05, 0.05], sweep_span_nm: 2.4 };
  const coarse = await simulateCircuit(compile(request));
  assert.equal(checked(coarse.verification, 'resonance_sampling').status, 'fail');
  const refined = await simulateCircuit(compile({ ...request, sweep_points: 5001 }));
  assert.equal(
    refined.verification.status,
    'passed_with_limitations',
    JSON.stringify(refined.verification),
  );
  assert.equal(checked(refined.verification, 'resonance_sampling').status, 'pass');
});
test('ring verification rejects feedback, length, ratio, ports, spectrum, dimensions and removed GDS return segment', async () => {
  const faults: Record<string, string> = {
    feedback: 'ring_intent_consistency',
    length: 'physical_length_backannotation',
    ratio: 'ring_intent_consistency',
    ports: 'simulation_shape_and_finiteness',
    spectrum: 'analytic_ring_agreement',
    dimensions: 'requested_ring_dimensions',
    gds: 'gds_contains_arm_centerlines',
  };
  for (const [fault, id] of Object.entries(faults)) {
    const dir = path.join(root, `corrupt-${fault}`);
    await cp(passive.artifact_directory, dir, { recursive: true });
    if (fault === 'gds')
      execFileSync(python, [
        '-c',
        `import sys, klayout.db as k
l=k.Layout();l.read(sys.argv[1]);idx=l.find_layer(1,0)
r=k.Region(l.top_cell().begin_shapes_rec(idx)).merged()
r-=k.Region(k.Box(248000,145000,252000,155000))
l.clear_layer(idx);l.top_cell().shapes(idx).insert(r);l.write(sys.argv[1])
`,
        path.join(dir, 'design.gds'),
      ]);
    else {
      const file = path.join(
        dir,
        fault === 'spectrum' || fault === 'ports'
          ? 'simulation.json'
          : fault === 'dimensions'
            ? 'layout.json'
            : 'engineering_ir.json',
      );
      const data = await json(file);
      if (fault === 'feedback')
        [data.netlist.connections[0].b, data.netlist.connections[2].b] = [
          data.netlist.connections[2].b,
          data.netlist.connections[0].b,
        ];
      if (fault === 'length')
        data.netlist.instances.find((i: { name: string }) => i.name === 'right_return').length_um +=
          1;
      if (fault === 'ratio') data.netlist.instances[0].coupling_ratio = 0.4;
      if (fault === 'ports') [data.ports[2], data.ports[3]] = [data.ports[3], data.ports[2]];
      if (fault === 'spectrum') data.s_real[500][3][0] += 0.2;
      if (fault === 'dimensions')
        data.centerlines_um.right_return[
          Math.floor(data.centerlines_um.right_return.length / 2)
        ][0] += 10;
      await writeFile(file, JSON.stringify(data));
    }
    const report = await verifyArtifacts(dir);
    assert.equal(report.status, 'failed', fault);
    assert.equal(checked(report, id)?.status, 'fail', `${fault}: ${JSON.stringify(report)}`);
  }
});
test('target-tuned feedback ring completes real HTTP/MCP and preserves core and metal geometry', async () => {
  const output = path.join(root, 'acceptance');
  await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/acceptance.ts',
      '--specification',
      'examples/target_ring_1550.json',
      '--output',
      output,
    ],
    { cwd: projectRoot, maxBuffer: 1024 * 1024 },
  );
  const accepted = await json(path.join(output, 'acceptance.json'));
  assert.equal(accepted.status, 'passed_with_limitations');
  assert.ok(Math.abs(accepted.center_transmission.out1 - 1) <= 1e-6);
  assert.ok(accepted.transport_artifacts_identical.includes('tuning.json'));
  const target = await json('examples/target_ring_1550.json');
  const off = await runtime.run({ ...target, tuning: null });
  assert.equal(off.status, 'completed');
  execFileSync(python, [
    '-c',
    `import sys, klayout.db as k
a,b=k.Layout(),k.Layout();a.read(sys.argv[1]);b.read(sys.argv[2])
assert a.dbu==b.dbu
for layer in [(1,0),(2,0)]:
 r=k.Region(a.top_cell().begin_shapes_rec(a.find_layer(*layer))).merged()
 s=k.Region(b.top_cell().begin_shapes_rec(b.find_layer(*layer))).merged()
 assert not r.is_empty() and (r^s).is_empty()
`,
    path.join(accepted.http_artifact_directory, 'design.gds'),
    path.join(off.artifact_directory, 'design.gds'),
  ]);
});
test('asymmetric coupling cannot be reported as unit drop transmission by tuning', async () => {
  const target = await json('examples/target_ring_1550.json');
  const result = await simulateCircuit(compile({ ...target, coupling_ratios: [0.3, 0.6] }));
  assert.equal(result.verification.status, 'failed');
  assert.equal(checked(result.verification, 'optical_targets').status, 'fail');
  assert.equal(checked(result.verification, 'analytic_ring_agreement').status, 'pass');
  assert.equal(checked(result.verification, 'tuning_trace_reference').status, 'pass');
});
test('physical loop and actuator boundaries preserve verification and inverse length/FSR behavior', async () => {
  const evidence = [];
  for (const [loop_height_um, side_extension_um, active_length_um, phase_rad] of [
    [200, 150, 20, -4 * Math.PI],
    [600, 500, 200, 4 * Math.PI],
  ]) {
    const run = await runtime.run({
      ...spec,
      loop_height_um,
      side_extension_um,
      phase_control: { active_length_um, phase_rad },
    });
    assert.equal(run.status, 'completed', JSON.stringify(run));
    const report = await runtime.verifyRun(run.run_id);
    assert.equal(report.status, 'passed_with_limitations', JSON.stringify(report));
    evidence.push(checked(report, 'resonance_features').evidence);
  }
  assert.ok(
    Number(evidence[1].modeled_round_trip_length_um) >
      Number(evidence[0].modeled_round_trip_length_um),
  );
  assert.ok(
    (evidence[1].observed_spacing_nm as number[])[0] <
      (evidence[0].observed_spacing_nm as number[])[0],
  );
});
