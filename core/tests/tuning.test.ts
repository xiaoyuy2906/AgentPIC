import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile, validateIR } from '../src/compiler.js';
import {
  DesignSpecSchema,
  EngineeringIRSchema,
  type EngineeringIR,
  type RunResult,
  type TuningResult,
} from '../src/contracts.js';
import { Runtime } from '../src/runtime.js';
import { PythonBackend, projectRoot } from '../src/backends.js';
import { simulateCircuit, verifyArtifacts } from '../src/verification.js';
import { resolveVariables } from '../src/tuning.js';

const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const spec = DesignSpecSchema.parse(await json('examples/target_mzi_1550.json'));
const root = await mkdtemp(path.join(tmpdir(), 'agentpic-target-'));
const runtime = new Runtime(root);
let full: RunResult;
const mutate = (fn: (s: typeof spec) => void) => {
  const s = structuredClone(spec);
  fn(s);
  return s;
};

test('targets reject invalid paths, domains, sampling, duplicates, bounds and units before execution', () => {
  const changes = [
    (s: typeof spec) => {
      s.tuning!.variables[0].instance_path = ['missing'];
    },
    (s: typeof spec) => {
      s.tuning!.variables[0].instance_path = ['bottom_arm'];
    },
    (s: typeof spec) => {
      s.tuning!.targets[0].output_port = 'phase_e1';
    },
    (s: typeof spec) => {
      s.tuning!.targets[0].wavelength_nm = 1550.01;
    },
    (s: typeof spec) => {
      s.tuning!.targets[0].wavelength_nm = 1600;
    },
    (s: typeof spec) => {
      s.tuning!.targets.push(s.tuning!.targets[0]);
    },
    (s: typeof spec) => {
      s.tuning!.variables.push(s.tuning!.variables[0]);
    },
    (s: typeof spec) => {
      s.tuning!.variables[0].max_phase_rad = 0;
    },
    (s: typeof spec) => {
      s.tuning!.variables[0].min_phase_rad = 1;
    },
    (s: typeof spec) => {
      s.tuning!.targets[0].power = 1.1;
    },
    (s: typeof spec) => {
      s.tuning!.power_tolerance = 1e-10;
    },
    (s: typeof spec) => {
      s.tuning!.max_evaluations = 513;
    },
    (s: typeof spec) => {
      s.tuning!.targets[0].wavelength_nm = 1.55;
    },
  ];
  for (const change of changes) assert.throws(() => compile(mutate(change)));
  assert.throws(() => compile({ ...spec, tuning: { ...spec.tuning, voltage: 1 } }));
  const invalid = compile(spec);
  invalid.operating_point = { bottom_arm: 1 };
  assert.throws(() => validateIR(invalid));
});
for (const power of [0, 0.2, 0.5, 0.8, 1])
  test(`target power ${power} is solved from a stationary initial phase and independently checked`, async () => {
    const input = compile(
      mutate((s) => {
        s.tuning!.targets[0].power = power;
        s.tuning!.power_tolerance = 1e-9;
      }),
    );
    const result = await simulateCircuit(input);
    assert.equal(
      result.verification.status,
      'passed_with_limitations',
      JSON.stringify(result.verification),
    );
    assert.equal(result.tuning!.status, 'target_met');
    assert.ok(result.tuning!.evaluations <= spec.tuning!.max_evaluations);
    assert.equal(result.tuning!.evaluation_trace.length, result.tuning!.evaluations);
    const phase = result.ir.operating_point!.top_arm;
    assert.ok(Math.abs(Math.sin(phase / 2) ** 2 - power) <= 1e-9);
    assert.ok(Math.abs(result.simulation.transmission_out0![100] - power) <= 1e-9);
    assert.equal(result.ir.length_source, 'specification');
    assert.equal(input.operating_point, null);
    assert.deepEqual(result.ir.specification, input.specification);
    assert.equal(
      result.verification.checks.find((c) => c.id === 'tuning_trace_reference')?.status,
      'pass',
    );
  });
test('full target design uses measured lengths and preserves exact optical and metal polygons', async () => {
  full = await runtime.run(spec);
  assert.equal(full.status, 'completed', JSON.stringify(full));
  const verified = await runtime.verifyRun(full.run_id);
  assert.equal(verified.status, 'passed_with_limitations', JSON.stringify(verified));
  const ir = EngineeringIRSchema.parse(
    await json(path.join(full.artifact_directory, 'engineering_ir.json')),
  );
  const before = await json(path.join(full.artifact_directory, 'pre-tuning-ir.json'));
  assert.equal(before.operating_point, null);
  assert.equal(ir.length_source, 'layout');
  assert.ok(
    before.netlist.instances.find((i: { name: string }) => i.name === 'top_arm').length_um !== 800,
  );
  assert.deepEqual(
    ir.netlist.instances.map((i) => i.length_um),
    before.netlist.instances.map((i: { length_um: number | null }) => i.length_um),
  );
  const fixed = await runtime.run({ ...spec, tuning: null });
  assert.equal(fixed.status, 'completed');
  const python = path.resolve(
    projectRoot,
    process.env.UV_PROJECT_ENVIRONMENT ?? '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
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
    path.join(full.artifact_directory, 'design.gds'),
    path.join(fixed.artifact_directory, 'design.gds'),
  ]);
});
test('trace, target, fixed-state and selected-control corruption fail without relying on artifact hashes', async () => {
  const faults: Record<string, string> = {
    trace: 'tuning_trace_reference',
    budget: 'tuning_search_evidence',
    status: 'tuning_search_evidence',
    prediction: 'tuning_prediction_agreement',
    phase: 'tuning_semantics',
    target: 'tuning_source_intent',
    before: 'tuning_state_preservation',
    bounds: 'tuning_evidence_validation',
  };
  for (const [fault, check] of Object.entries(faults)) {
    const dir = path.join(root, `corrupt-${fault}`);
    await cp(full.artifact_directory, dir, { recursive: true });
    const file = path.join(
      dir,
      fault === 'phase' || fault === 'target'
        ? 'engineering_ir.json'
        : fault === 'before'
          ? 'pre-tuning-ir.json'
          : 'tuning.json',
    );
    const data = await json(file);
    if (fault === 'trace') data.evaluation_trace[0].powers[0] = 0.3;
    if (fault === 'budget') data.evaluations += 1;
    if (fault === 'status') data.status = 'budget_exhausted';
    if (fault === 'prediction') data.predicted_powers[0] = 0.1;
    if (fault === 'phase') data.operating_point.top_arm += 0.1;
    if (fault === 'target') data.specification.tuning.targets[0].power = 0.1;
    if (fault === 'before')
      data.netlist.instances.find((i: { name: string }) => i.name === 'bottom_arm').length_um += 10;
    if (fault === 'bounds') data.controls.top_arm = -1;
    await writeFile(file, JSON.stringify(data));
    const verified = await verifyArtifacts(dir);
    assert.equal(verified.status, 'failed', fault);
    assert.equal(
      verified.checks.find((c) => c.id === check)?.status,
      'fail',
      `${fault}: ${JSON.stringify(verified)}`,
    );
  }
});
test('hard budget failure retains best candidate, GDS, final simulation and independent failed report', async () => {
  const run = await runtime.run(
    mutate((s) => {
      s.tuning!.max_evaluations = 1;
    }),
  );
  assert.equal(run.status, 'failed');
  assert.equal(run.verification_status, 'failed');
  assert.equal(run.error, null);
  const result = await json(path.join(run.artifact_directory, 'tuning.json'));
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.evaluations, 1);
  assert.equal(result.evaluation_trace.length, 1);
  assert.ok(run.artifacts.some((a) => a.name === 'design.gds'));
  assert.ok(run.artifacts.some((a) => a.name === 'simulation.json'));
  const verified = await runtime.verifyRun(run.run_id);
  assert.equal(verified.checks.find((c) => c.id === 'optical_targets')?.status, 'fail');
  assert.equal(verified.checks.find((c) => c.id === 'tuning_search_evidence')?.status, 'pass');
  // Even internally consistent fabricated solver success cannot override final S or reference replay.
  result.status = 'target_met';
  result.maximum_error = 0;
  result.predicted_powers = [0.8];
  result.evaluation_trace[0].powers = [0.8];
  await writeFile(path.join(run.artifact_directory, 'tuning.json'), JSON.stringify(result));
  const forged = await verifyArtifacts(run.artifact_directory);
  for (const id of ['optical_targets', 'tuning_trace_reference', 'tuning_prediction_agreement'])
    assert.equal(forged.checks.find((c) => c.id === id)?.status, 'fail', id);
});
test('incompatible powers and bounded unreachable requests never pass on optimizer convergence', async () => {
  for (const s of [
    mutate((s) => {
      s.tuning!.targets.push({ ...s.tuning!.targets[0], output_port: 'out1', power: 0.8 });
    }),
    mutate((s) => {
      s.tuning!.variables[0].max_phase_rad = 0.1;
    }),
  ]) {
    const result = await simulateCircuit(compile(s));
    assert.equal(result.verification.status, 'failed');
    assert.notEqual(result.tuning!.status, 'target_met');
    assert.ok(result.tuning!.evaluations <= s.tuning!.max_evaluations);
    assert.equal(
      result.verification.checks.find((c) => c.id === 'tuning_search_evidence')?.status,
      'pass',
    );
  }
});
test('backend exception or out-of-bound result fails the tuning task and retains prior artifacts', async () => {
  class Broken extends PythonBackend {
    constructor(readonly fault: string) {
      super();
    }
    override async optimize(ir: EngineeringIR): Promise<TuningResult> {
      if (this.fault === 'exception') throw new Error('Injected optimizer failure');
      const result = await super.optimize(ir, resolveVariables(ir));
      return { ...result, controls: { top_arm: -1 } };
    }
  }
  for (const fault of ['exception', 'bounds']) {
    const run = await new Runtime(root, new Broken(fault)).run(spec);
    assert.equal(run.status, 'failed');
    assert.ok(run.error);
    const tasks = (await json(path.join(run.artifact_directory, 'workflow.json'))).tasks;
    assert.equal(tasks.find((t: { name: string }) => t.name === 'tune').state, 'failed');
    assert.equal(tasks.find((t: { name: string }) => t.name === 'simulate').state, 'blocked');
    assert.ok(run.artifacts.some((a) => a.name === 'pre-tuning-ir.json'));
  }
});
test('multiple cascade variables, inputs and wavelengths complete real HTTP/MCP with identical evidence', async () => {
  const output = path.join(root, 'acceptance');
  await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/acceptance.ts',
      '--specification',
      'examples/target_cascade_1550.json',
      '--output',
      output,
    ],
    { cwd: projectRoot, maxBuffer: 1024 * 1024 },
  );
  const accepted = await json(path.join(output, 'acceptance.json'));
  assert.equal(accepted.status, 'passed_with_limitations');
  assert.ok(accepted.transport_artifacts_identical.includes('tuning.json'));
  assert.ok(accepted.transport_artifacts_identical.includes('pre-tuning-ir.json'));
  const result = await json(path.join(accepted.http_artifact_directory, 'tuning.json'));
  assert.equal(Object.keys(result.controls).length, 2);
  assert.equal(result.predicted_powers.length, 3);
  assert.equal(result.status, 'target_met');
  const circuit = await json(path.join(output, 'circuit-only.json'));
  assert.equal(circuit.ir.length_source, 'specification');
  assert.equal(circuit.tuning.status, 'target_met');
});
test('four-variable, sixteen-target workflow supports the declared maximum and signed phase bounds', async () => {
  const ports = ['in0', 'in1', 'out0', 'out1'];
  const stages = ['a', 'b', 'c', 'd'].map((name) => ({
    name,
    delta_length_um: 0,
    phase_control: { phase_rad: 0 },
  }));
  const targets = ports.flatMap((input_port, i) =>
    ports.map((output_port, o) => ({
      input_port,
      output_port,
      wavelength_nm: 1550,
      power: i < 2 === o < 2 ? 0 : i % 2 === o % 2 ? 0.7 : 0.3,
    })),
  );
  const run = await runtime.run({
    device: 'mzi_cascade',
    stages,
    tuning: {
      targets,
      variables: stages.map((s) => ({
        instance_path: [s.name, 'top_arm'],
        min_phase_rad: -2 * Math.PI,
        max_phase_rad: 2 * Math.PI,
      })),
      max_evaluations: 512,
      power_tolerance: 1e-8,
    },
  });
  assert.equal(run.status, 'completed', JSON.stringify(run));
  const result = await json(path.join(run.artifact_directory, 'tuning.json'));
  assert.equal(Object.keys(result.controls).length, 4);
  assert.equal(result.predicted_powers.length, 16);
  assert.equal((await runtime.verifyRun(run.run_id)).status, 'passed_with_limitations');
});
test('unselected phase and original hierarchical intent stay fixed while a selected phase is optimized', async () => {
  const cascade = await json('examples/target_cascade_1550.json');
  cascade.stages[1].phase_control.phase_rad = 0.37;
  cascade.tuning.variables = cascade.tuning.variables.slice(0, 1);
  cascade.tuning.targets = cascade.tuning.targets.slice(0, 2);
  const ir = compile(cascade);
  const result = await simulateCircuit(ir);
  assert.equal(
    result.verification.status,
    'passed_with_limitations',
    JSON.stringify(result.verification),
  );
  assert.deepEqual(result.ir.hierarchy, ir.hierarchy);
  const unselected = result.ir.netlist.instances.find(
    (i) => result.ir.instance_paths[i.name]?.[0] === 'second' && i.kind === 'phase_shifter',
  )!;
  assert.equal(unselected.phase_control!.phase_rad, 0.37);
  assert.equal(Object.keys(result.ir.operating_point!).length, 1);
  const bad = structuredClone(result.ir);
  bad.netlist.instances.find((i) => i.name === unselected.name)!.phase_control!.phase_rad = 0;
  assert.throws(() => validateIR(bad));
});
