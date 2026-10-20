/** Target-driven optical operating points: bounded search, budgets and independent evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { compile, validateIR } from '../src/compiler.js';
import {
  DesignSpecSchema,
  EngineeringIRSchema,
  type EngineeringIR,
  type RunResult,
  type TuningResult,
} from '../src/contracts.js';
import { Runtime } from '../src/runtime.js';
import { PythonBackend } from '../src/backends.js';
import { simulateCircuit, verifyArtifacts } from '../src/verification.js';
import { resolveVariables } from '../src/tuning.js';
import { designs, cascade } from '../../designs/templates.js';
import {
  acceptance,
  assertSameGeometry,
  checked,
  corruptCopy,
  json,
  power,
  tempRuntime,
} from './helpers.js';

const spec = DesignSpecSchema.parse(designs.mzi_target);
const { root, runtime } = await tempRuntime('target');
let full: RunResult;
const mutate = (fn: (s: typeof spec) => void) => {
  const s = structuredClone(spec);
  fn(s);
  return s;
};

test('targets reject invalid paths, domains, sampling, duplicates, bounds and units before execution', () => {
  const changes: ((s: typeof spec) => void)[] = [
    (s) => (s.tuning!.variables[0].instance_path = ['missing']),
    (s) => (s.tuning!.variables[0].instance_path = ['bottom_arm']),
    (s) => (s.tuning!.targets[0].output_port = 'phase_e1'),
    (s) => (s.tuning!.targets[0].wavelength_nm = 1550.01),
    (s) => (s.tuning!.targets[0].wavelength_nm = 1600),
    (s) => s.tuning!.targets.push(s.tuning!.targets[0]),
    (s) => s.tuning!.variables.push(s.tuning!.variables[0]),
    (s) => (s.tuning!.variables[0].max_phase_rad = 0),
    (s) => (s.tuning!.variables[0].min_phase_rad = 1),
    (s) => (s.tuning!.targets[0].power = 1.1),
    (s) => (s.tuning!.power_tolerance = 1e-10),
    (s) => (s.tuning!.max_evaluations = 513),
    (s) => (s.tuning!.targets[0].wavelength_nm = 1.55),
  ];
  for (const change of changes) assert.throws(() => compile(mutate(change)));
  assert.throws(() => compile({ ...spec, tuning: { ...spec.tuning, voltage: 1 } }));
  const invalid = compile(spec);
  invalid.operating_point = { bottom_arm: 1 };
  assert.throws(() => validateIR(invalid));
});
for (const target of [0, 0.2, 0.5, 0.8, 1])
  test(`target power ${target} is solved from a stationary initial phase and independently checked`, async () => {
    const input = compile(
      mutate((s) => {
        s.tuning!.targets[0].power = target;
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
    assert.ok(Math.abs(Math.sin(phase / 2) ** 2 - target) <= 1e-9);
    assert.ok(Math.abs(power(result.simulation, 'out0', 'in0', 100) - target) <= 1e-9);
    assert.equal(result.ir.length_source, 'specification');
    assert.equal(input.operating_point, null);
    assert.deepEqual(result.ir.specification, input.specification);
    assert.equal(checked(result.verification, 'tuning_trace_reference')?.status, 'pass');
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
  assert.notEqual(
    before.netlist.instances.find((i: { name: string }) => i.name === 'top_arm').length_um,
    800,
  );
  assert.deepEqual(
    ir.netlist.instances.map((i) => i.length_um),
    before.netlist.instances.map((i: { length_um: number | null }) => i.length_um),
  );
  const fixed = await runtime.run({ ...spec, tuning: null });
  assert.equal(fixed.status, 'completed');
  assertSameGeometry(
    path.join(full.artifact_directory, 'design.gds'),
    path.join(fixed.artifact_directory, 'design.gds'),
  );
});
test('trace, target, fixed-state and selected-control corruption fail without relying on artifact hashes', async () => {
  const faults: Record<string, [string, (d: any) => void, string]> = {
    trace: [
      'tuning.json',
      (t) => (t.evaluation_trace[0].powers[0] = 0.3),
      'tuning_trace_reference',
    ],
    budget: ['tuning.json', (t) => (t.evaluations += 1), 'tuning_search_evidence'],
    status: ['tuning.json', (t) => (t.status = 'budget_exhausted'), 'tuning_search_evidence'],
    prediction: [
      'tuning.json',
      (t) => (t.predicted_powers[0] = 0.1),
      'tuning_prediction_agreement',
    ],
    phase: ['engineering_ir.json', (ir) => (ir.operating_point.top_arm += 0.1), 'tuning_semantics'],
    target: [
      'engineering_ir.json',
      (ir) => (ir.specification.tuning.targets[0].power = 0.1),
      'workflow_state_consistency',
    ],
    before: [
      'pre-tuning-ir.json',
      (ir) =>
        (ir.netlist.instances.find((i: { name: string }) => i.name === 'bottom_arm').length_um +=
          10),
      'tuning_state_preservation',
    ],
    bounds: ['tuning.json', (t) => (t.controls.top_arm = -1), 'tuning_evidence_validation'],
  };
  for (const [fault, [file, edit, id]] of Object.entries(faults)) {
    const dir = path.join(root, `corrupt-${fault}`);
    await corruptCopy(full.artifact_directory, dir, file, edit);
    const verified = await verifyArtifacts(dir);
    assert.equal(verified.status, 'failed', fault);
    assert.equal(checked(verified, id)?.status, 'fail', `${fault}: ${id}`);
  }
});
test('hard budget failure retains best candidate, GDS, final simulation and independent failed report', async () => {
  const run = await runtime.run(mutate((s) => (s.tuning!.max_evaluations = 1)));
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
  assert.equal(checked(verified, 'optical_targets')?.status, 'fail');
  assert.equal(checked(verified, 'tuning_search_evidence')?.status, 'pass');
  // Even internally consistent fabricated solver success cannot override final S or reference replay.
  result.status = 'target_met';
  result.maximum_error = 0;
  result.predicted_powers = [0.8];
  result.evaluation_trace[0].powers = [0.8];
  await writeFile(path.join(run.artifact_directory, 'tuning.json'), JSON.stringify(result));
  const forged = await verifyArtifacts(run.artifact_directory);
  for (const id of ['optical_targets', 'tuning_trace_reference', 'tuning_prediction_agreement'])
    assert.equal(checked(forged, id)?.status, 'fail', id);
});
test('incompatible powers and bounded unreachable requests never pass on optimizer convergence', async () => {
  for (const s of [
    mutate((s) => {
      s.tuning!.targets.push({ ...s.tuning!.targets[0], output_port: 'out1', power: 0.8 });
    }),
    mutate((s) => (s.tuning!.variables[0].max_phase_rad = 0.1)),
  ]) {
    const result = await simulateCircuit(compile(s));
    assert.equal(result.verification.status, 'failed');
    assert.notEqual(result.tuning!.status, 'target_met');
    assert.ok(result.tuning!.evaluations <= s.tuning!.max_evaluations);
    assert.equal(checked(result.verification, 'tuning_search_evidence')?.status, 'pass');
  }
});
test('asymmetric ring coupling cannot be reported as unit drop transmission by tuning', async () => {
  const target = structuredClone(designs.ring_target) as any;
  target.circuit.instances[0].coupling_ratio = 0.3;
  target.circuit.instances[1].coupling_ratio = 0.6;
  const result = await simulateCircuit(compile(target));
  assert.equal(result.verification.status, 'failed');
  assert.equal(checked(result.verification, 'optical_targets')?.status, 'fail');
  assert.equal(checked(result.verification, 'independent_circuit_agreement')?.status, 'pass');
  assert.equal(checked(result.verification, 'tuning_trace_reference')?.status, 'pass');
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
for (const design of ['mzi_cascade_target', 'ring_target'])
  test(`${design} completes real HTTP/MCP acceptance with identical tuning evidence`, async () => {
    const accepted = await acceptance(`designs/${design}.json`, path.join(root, design));
    assert.equal(accepted.status, 'passed_with_limitations');
    assert.ok(accepted.transport_artifacts_identical.includes('tuning.json'));
    assert.ok(accepted.transport_artifacts_identical.includes('pre-tuning-ir.json'));
    const result = await json(path.join(accepted.http_artifact_directory, 'tuning.json'));
    assert.equal(result.status, 'target_met');
    const circuit = await json(path.join(root, design, 'circuit-only.json'));
    assert.equal(circuit.ir.length_source, 'specification');
    assert.equal(circuit.tuning.status, 'target_met');
    if (design === 'ring_target') {
      const sim = await json(path.join(accepted.http_artifact_directory, 'simulation.json'));
      const middle = Math.floor(sim.wavelength_nm.length / 2);
      assert.ok(Math.abs(power(sim, 'out1', 'in0', middle) - 1) <= 1e-6);
      const off = await runtime.run({ ...designs.ring_target, tuning: null });
      assert.equal(off.status, 'completed');
      assertSameGeometry(
        path.join(accepted.http_artifact_directory, 'design.gds'),
        path.join(off.artifact_directory, 'design.gds'),
      );
    } else {
      assert.equal(Object.keys(result.controls).length, 2);
      assert.equal(result.predicted_powers.length, 3);
    }
  });
test('four-variable, sixteen-target workflow supports the declared maximum and signed phase bounds', async () => {
  const ports = ['in0', 'in1', 'out0', 'out1'];
  const stages = ['a', 'b', 'c', 'd'].map((name) => ({
    name,
    delta_length_um: 0,
    phase_control: { phase_rad: 0, active_length_um: 100 },
  }));
  const targets = ports.flatMap((input_port, i) =>
    ports.map((output_port, o) => ({
      input_port,
      output_port,
      wavelength_nm: 1550,
      power: i < 2 === o < 2 ? 0 : i % 2 === o % 2 ? 0.7 : 0.3,
    })),
  );
  const run = await runtime.run(
    cascade({
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
    }),
  );
  assert.equal(run.status, 'completed', JSON.stringify(run));
  const result = await json(path.join(run.artifact_directory, 'tuning.json'));
  assert.equal(Object.keys(result.controls).length, 4);
  assert.equal(result.predicted_powers.length, 16);
  assert.equal((await runtime.verifyRun(run.run_id)).status, 'passed_with_limitations');
});
test('unselected phase and original hierarchical intent stay fixed while a selected phase is optimized', async () => {
  const design = structuredClone(designs.mzi_cascade_target) as any;
  design.circuit.definitions[1].primitives[2].phase_control.phase_rad = 0.37;
  design.tuning.variables = design.tuning.variables.slice(0, 1);
  design.tuning.targets = design.tuning.targets.slice(0, 2);
  const ir = compile(design);
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
