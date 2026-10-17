import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile, validateIR, canonical } from '../src/compiler.js';
import {
  GenericCircuitSpecSchema,
  type GenericCircuitSpec,
  type SimulationResult,
  type EngineeringIR,
} from '../src/contracts.js';
import { simulateCircuit, verifyArtifacts, readJSON } from '../src/verification.js';
import { Runtime, writeJSON } from '../src/runtime.js';
import { PythonBackend } from '../src/backends.js';
import { genericBenchmark } from '../../scripts/generic-benchmark.js';
import { flattenCircuit } from '../src/hierarchy.js';

const example = async (name: string) =>
  GenericCircuitSpecSchema.parse(
    JSON.parse(await readFile(`examples/generic_${name}_1550.json`, 'utf8')),
  );
const chain = await example('chain'),
  coupler = await example('coupler');
const backend = new PythonBackend();
const results = new Map<string, { ir: EngineeringIR; simulation: SimulationResult }>();

for (const [name, spec] of [
  ['chain', chain],
  ['coupler', coupler],
] as const) {
  test(`generic ${name}: real SAX, explicit port order, closed-form amplitudes and independent physics`, async () => {
    const ir = compile(JSON.parse(canonical(spec)));
    assert.deepEqual(ir.netlist, spec.circuit);
    assert.deepEqual(
      ir.workflow.map((t) => t.name),
      ['compile', 'simulate', 'verify', 'manifest'],
    );
    const result = await simulateCircuit(ir);
    assert.equal(
      result.verification.status,
      'passed_with_limitations',
      JSON.stringify(result.verification),
    );
    assert.equal(result.simulation.backend, 'sax');
    assert.deepEqual(result.simulation.ports, spec.port_order);
    assert.equal(result.simulation.input_port, null);
    assert.equal(result.simulation.transmission_out0, null);
    assert.equal(genericBenchmark(spec, result.simulation).status, 'pass');
    for (const id of [
      'independent_circuit_agreement',
      'reciprocity',
      'passivity',
      'lossless_power_balance',
    ])
      assert.equal(result.verification.checks.find((c) => c.id === id)?.status, 'pass');
    for (const id of [
      'layout_generation',
      'layout_verification',
      'electromagnetic_calibration',
      'measurement_validation',
      'foundry_signoff',
    ])
      assert.equal(result.verification.checks.find((c) => c.id === id)?.status, 'not_run');
    results.set(name, result);
  });
}

const invalid: [string, (s: GenericCircuitSpec) => void][] = [
  [
    'unknown endpoint',
    (s) => {
      s.circuit.connections[0].a.port = 'missing';
    },
  ],
  [
    'double occupied endpoint',
    (s) => {
      s.circuit.ports.ReceiveA = s.circuit.ports.LaunchB;
    },
  ],
  [
    'unoccupied port',
    (s) => {
      s.circuit.connections.pop();
    },
  ],
  [
    'self connection',
    (s) => {
      s.circuit.connections[0].b = s.circuit.connections[0].a;
    },
  ],
  [
    'incompatible domain',
    (s) => {
      s.circuit.instances[0].ports[1].domain = 'electrical';
    },
  ],
  [
    'unidirectional primitive',
    (s) => {
      s.circuit.instances[0].ports[0].direction = 'input';
    },
  ],
  [
    'duplicate component',
    (s) => {
      s.circuit.instances[1].name = s.circuit.instances[0].name;
    },
  ],
  [
    'duplicate port',
    (s) => {
      s.circuit.instances[0].ports[1].name = 'o1';
    },
  ],
  [
    'unknown model',
    (s) => {
      s.models.waveguide = 'unknown';
    },
  ],
  [
    'missing model',
    (s) => {
      delete s.models.waveguide;
    },
  ],
  [
    'unused model',
    (s) => {
      s.models.other = 'unknown';
    },
  ],
  [
    'missing port order',
    (s) => {
      s.port_order.pop();
    },
  ],
  [
    'duplicate port order',
    (s) => {
      s.port_order.push(s.port_order[0]);
    },
  ],
  [
    'unknown external name',
    (s) => {
      s.port_order[0] = 'missing';
    },
  ],
  [
    'invalid external name',
    (s) => {
      s.circuit.ports['bad,name'] = s.circuit.ports.LaunchB;
    },
  ],
  [
    'even sweep',
    (s) => {
      s.sweep_points = 4;
    },
  ],
  [
    'unsupported sweep size',
    (s) => {
      s.sweep_points = 1003;
    },
  ],
  [
    'missing propagation length',
    (s) => {
      s.circuit.instances[0].length_um = null;
    },
  ],
  [
    'disconnected graph',
    (s) => {
      const edge = s.circuit.connections.pop()!;
      s.circuit.ports.extraA = edge.a;
      s.circuit.ports.extraB = edge.b;
      s.port_order.push('extraA', 'extraB');
    },
  ],
];
for (const [name, mutate] of invalid)
  test(`generic rejects ${name} before scientific execution`, () => {
    const spec = structuredClone(chain);
    mutate(spec);
    assert.throws(() => compile(spec));
  });

test('generic IR rejects changed model assumptions and false layout claims', () => {
  const ir = compile(chain);
  ir.technology.effective_index = 2;
  assert.throws(() => validateIR(ir));
  const resolved = compile(chain);
  resolved.layout_resolved = true;
  assert.throws(() => validateIR(resolved));
  const withLength = structuredClone(coupler);
  withLength.circuit.instances[0].length_um = 10;
  assert.throws(() => compile(withLength));
});

test('generic phase shifter preserves electrical terminals outside the optical matrix', async () => {
  const spec = structuredClone(chain);
  const last = spec.circuit.instances[2];
  last.kind = 'phase_shifter';
  last.phase_control = { phase_rad: 0.7, active_length_um: 20 };
  last.ports.push(
    { name: 'e1', domain: 'electrical', direction: 'bidirectional' },
    { name: 'e2', domain: 'electrical', direction: 'bidirectional' },
  );
  spec.circuit.ports.heaterPlus = { instance: last.name, port: 'e1' };
  spec.circuit.ports.heaterMinus = { instance: last.name, port: 'e2' };
  spec.models.phase_shifter = 'ideal_phase_shifter_v1';
  const result = await simulateCircuit(compile(spec));
  assert.equal(result.verification.status, 'passed_with_limitations');
  assert.deepEqual(result.simulation.ports, spec.port_order);
  const phase = (2 * Math.PI * 1.8 * 126.75) / 1.55 + 0.7;
  assert.ok(
    Math.hypot(
      result.simulation.s_real[100][0][1] - Math.cos(phase),
      result.simulation.s_imag[100][0][1] - Math.sin(phase),
    ) < 1e-9,
  );
  assert.equal(
    result.verification.checks.find((c) => c.id === 'phase_actuation_calibration')?.status,
    'not_run',
  );
});

test('existing hierarchy flattening feeds generic simulation without a recipe', async () => {
  const hierarchy = JSON.parse(await readFile('examples/cascaded_mzi.hierarchy.json', 'utf8'));
  const flat = flattenCircuit(hierarchy);
  const ir = compile({
    ...chain,
    circuit: flat.circuit,
    models: { waveguide: 'ideal_sin_waveguide_v1', ideal_coupler: 'ideal_coupler_v1' },
    port_order: ['out1', 'in1', 'out0', 'in0'],
  });
  assert.equal((await simulateCircuit(ir)).verification.status, 'passed_with_limitations');
});

test('independent verification rejects corrupted phase, gain, dimensions and port order', async () => {
  const result = results.get('coupler')!;
  for (const kind of ['phase', 'gain', 'dimensions', 'order', 'summary']) {
    const sim = structuredClone(result.simulation);
    if (kind === 'phase') sim.s_imag[100][0][1] *= -1;
    if (kind === 'gain') sim.s_real[100][0][0] = 2;
    if (kind === 'dimensions') sim.s_real[100].pop();
    if (kind === 'order') sim.ports.reverse();
    if (kind === 'summary') sim.input_port = 'in0';
    const checks = await backend.verifySimulation(result.ir, sim);
    assert.ok(
      checks.some((c) => c.status === 'fail'),
      kind,
    );
    if (kind === 'phase')
      assert.equal(checks.find((c) => c.id === 'independent_circuit_agreement')?.status, 'fail');
    if (kind === 'gain') assert.equal(checks.find((c) => c.id === 'passivity')?.status, 'fail');
  }
});

test('persisted generic run has no layout/GDS and detects source and artifact tampering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentpic-generic-'));
  const runtime = new Runtime(root);
  const run = await runtime.run(coupler);
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.equal((await runtime.verifyRun(run.run_id)).status, 'passed_with_limitations');
  assert.ok(
    !(await readdir(run.artifact_directory)).some((f) => f.endsWith('.gds') || f === 'layout.json'),
  );
  await assert.rejects(() => backend.layout(compile(coupler), root), /not implemented/);
  for (const filename of [
    'netlist.json',
    'compiled_ir.json',
    'specification.json',
    'simulation.json',
  ]) {
    const dir = path.join(root, filename);
    await cp(run.artifact_directory, dir, { recursive: true });
    const value = (await readJSON(path.join(dir, filename))) as Record<string, unknown>;
    value.corrupted = true;
    await writeJSON(path.join(dir, filename), value);
    assert.equal((await verifyArtifacts(dir, backend)).status, 'failed', filename);
  }
  await writeJSON(path.join(run.artifact_directory, 'provenance.json'), { corrupted: true });
  assert.equal(
    (await runtime.verifyRun(run.run_id)).checks.find((c) => c.id === 'artifact_integrity')?.status,
    'fail',
  );
});
