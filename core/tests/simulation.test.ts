/**
 * Circuit simulation and independent numerical verification. Device closed forms live here as
 * golden references; the engine itself only knows generic network elimination.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, canonical } from '../src/compiler.js';
import { PythonBackend } from '../src/backends.js';
import { simulateCircuit } from '../src/verification.js';
import { designs, mzi, cascade, ring, type DesignInput } from '../../designs/templates.js';
import { genericBenchmark } from '../../scripts/generic-benchmark.js';
import { checked, neff, ng, power, wl0 } from './helpers.js';

const backend = new PythonBackend();
const center = 100;

test('MZI arm imbalance follows the closed-form power law at the reference wavelength', async () => {
  for (const delta of [10, -15, 0]) {
    const result = await simulateCircuit(compile(mzi({ delta_length_um: delta })));
    assert.equal(result.verification.status, 'passed_with_limitations');
    assert.equal(result.ir.length_source, 'specification');
    const expected = Math.sin((Math.PI * neff * delta) / wl0) ** 2;
    assert.ok(Math.abs(power(result.simulation, 'out0', 'in0', center) - expected) < 1e-9);
  }
});
for (const phase of [0, Math.PI / 2, Math.PI, 2 * Math.PI, -Math.PI / 2])
  test(`balanced MZI phase ${phase.toFixed(3)} follows the phase power law at every sample`, async () => {
    const result = await simulateCircuit(
      compile(
        mzi({ delta_length_um: 0, phase_control: { phase_rad: phase, active_length_um: 100 } }),
      ),
    );
    assert.equal(result.verification.status, 'passed_with_limitations');
    assert.deepEqual(result.simulation.ports, ['in0', 'in1', 'out0', 'out1']);
    result.simulation.wavelength_nm.forEach((w, n) => {
      const expected = Math.sin((phase * 1550) / w / 2) ** 2;
      assert.ok(Math.abs(power(result.simulation, 'out0', 'in0', n) - expected) < 1e-9);
    });
    assert.equal(checked(result.verification, 'phase_actuation_calibration')?.status, 'not_run');
  });
test('two-stage cascade satisfies the independent power identity', async () => {
  const result = await simulateCircuit(compile(designs.mzi_cascade));
  assert.equal(result.verification.status, 'passed_with_limitations');
  const expected = Math.cos((Math.PI * neff * (20 - 10)) / wl0) ** 2;
  assert.ok(Math.abs(power(result.simulation, 'out0', 'in0', center) - expected) < 1e-9);
});
for (const ratios of [
  [0.5, 0.5],
  [0.3, 0.6],
  [0.8, 0.8],
] as [number, number][])
  test(`ring drop and through powers at resonance follow the feedback formula for ${ratios}`, async () => {
    const nominal = compile(ring({ coupling_ratios: ratios }));
    const length = nominal.netlist.instances.reduce((s, i) => s + (i.length_um ?? 0), 0);
    const cycles = (neff * length) / wl0;
    const phase = 2 * Math.PI * (Math.round(cycles) - cycles);
    const result = await simulateCircuit(
      compile(
        ring({
          coupling_ratios: ratios,
          phase_control: { phase_rad: phase, active_length_um: 100 },
        }),
      ),
    );
    assert.equal(
      result.verification.status,
      'passed_with_limitations',
      JSON.stringify(result.verification),
    );
    const [k1, k2] = ratios;
    const drop = (k1 * k2) / (1 - Math.sqrt((1 - k1) * (1 - k2))) ** 2;
    assert.ok(Math.abs(power(result.simulation, 'out1', 'in0', 500) - drop) < 1e-9);
    assert.ok(Math.abs(power(result.simulation, 'out0', 'in0', 500) - (1 - drop)) < 1e-9);
    const resonances = checked(result.verification, 'resonances_in0_to_out1')!;
    assert.equal(resonances.status, 'pass');
    // The theoretical free spectral range λ²/(ng L) bounds the measured peak spacing.
    const fsr = (wl0 * 1000) ** 2 / (ng * length * 1000);
    for (const spacing of resonances.evidence.spacing_nm as number[])
      assert.ok(Math.abs(spacing - fsr) < 0.01, `${spacing} vs ${fsr}`);
  });
for (const name of ['waveguide_chain', 'coupler'] as const)
  test(`flat ${name} circuit-only simulation matches its closed form with an explicit port order`, async () => {
    const spec = designs[name];
    const ir = compile(JSON.parse(canonical(spec)));
    assert.equal(
      ir.workflow.some((t) => t.name === 'layout'),
      spec.layout != null,
    );
    const result = await simulateCircuit(ir);
    assert.equal(
      result.verification.status,
      'passed_with_limitations',
      JSON.stringify(result.verification),
    );
    assert.deepEqual(result.simulation.ports, spec.port_order);
    assert.equal(genericBenchmark(spec, result.simulation, result.ir)?.status, 'pass');
    for (const id of [
      'independent_circuit_agreement',
      'reciprocity',
      'passivity',
      'lossless_power_balance',
      'spectral_sampling',
    ])
      assert.equal(checked(result.verification, id)?.status, 'pass', id);
    for (const id of ['layout_generation', 'layout_verification', 'electromagnetic_calibration'])
      assert.equal(checked(result.verification, id)?.status, 'not_run', id);
  });
test('a phase shifter keeps its electrical terminals outside the optical matrix', async () => {
  const spec = structuredClone(designs.waveguide_chain) as any;
  const last = spec.circuit.instances[2];
  last.kind = 'phase_shifter';
  last.phase_control = { phase_rad: 0.7, active_length_um: 20 };
  last.ports.push({ name: 'e1', domain: 'electrical' }, { name: 'e2', domain: 'electrical' });
  spec.circuit.ports.heaterPlus = { instance: last.name, port: 'e1' };
  spec.circuit.ports.heaterMinus = { instance: last.name, port: 'e2' };
  const result = await simulateCircuit(compile(spec));
  assert.equal(result.verification.status, 'passed_with_limitations');
  assert.deepEqual(result.simulation.ports, spec.port_order);
  const phase = (2 * Math.PI * neff * 126.75) / wl0 + 0.7;
  assert.ok(
    Math.hypot(
      result.simulation.s_real[center][0][1] - Math.cos(phase),
      result.simulation.s_imag[center][0][1] - Math.sin(phase),
    ) < 1e-9,
  );
});

const failsOnly = async (design: DesignInput, id: string) => {
  const result = await simulateCircuit(compile(design));
  assert.equal(result.verification.status, 'failed');
  assert.equal(checked(result.verification, 'independent_circuit_agreement')?.status, 'pass');
  assert.equal(
    checked(result.verification, id)?.status,
    'fail',
    JSON.stringify(result.verification),
  );
  return result;
};
test('an undersampled spectrum fails although every sampled S-parameter is correct', async () => {
  const result = await failsOnly(ring({ sweep_points: 21 }), 'spectral_sampling');
  assert.ok(
    (checked(result.verification, 'spectral_sampling')!.evidence
      .maximum_interpolation_error as number) >
      1 / 400,
  );
});
test('a clipped window fails the declared resonance measurement', async () => {
  await failsOnly(ring({ sweep_span_nm: 0.1, sweep_points: 101 }), 'resonances_in0_to_out1');
});
test('narrow weakly coupled resonances need, and pass with, an explicitly refined grid', async () => {
  const weak = { coupling_ratios: [0.05, 0.05] as [number, number], sweep_span_nm: 2.4 };
  await failsOnly(ring(weak), 'spectral_sampling');
  const refined = await simulateCircuit(compile(ring({ ...weak, sweep_points: 5001 })));
  assert.equal(
    refined.verification.status,
    'passed_with_limitations',
    JSON.stringify(refined.verification),
  );
});
test('larger rings have proportionally smaller measured resonance spacing', async () => {
  const spacing = async (loop_height_um: number, side_extension_um: number) => {
    const result = await simulateCircuit(compile(ring({ loop_height_um, side_extension_um })));
    assert.equal(result.verification.status, 'passed_with_limitations');
    return (
      checked(result.verification, 'resonances_in0_to_out1')!.evidence.spacing_nm as number[]
    )[0];
  };
  assert.ok((await spacing(600, 500)) < (await spacing(200, 150)));
});
test('independent verification rejects corrupted phase, gain, dimensions and port order', async () => {
  const result = await simulateCircuit(compile(designs.coupler));
  for (const kind of ['phase', 'gain', 'dimensions', 'order']) {
    const sim = structuredClone(result.simulation);
    if (kind === 'phase') sim.s_imag[center][0][1] *= -1;
    if (kind === 'gain') sim.s_real[center][0][0] = 2;
    if (kind === 'dimensions') sim.s_real[center].pop();
    if (kind === 'order') sim.ports.reverse();
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
test('cascades of up to four stages simulate without new engine code', async () => {
  const result = await simulateCircuit(
    compile(
      cascade({
        stages: [-15, 0, 10, 25].map((delta_length_um, i) => ({
          name: `stage${i}`,
          delta_length_um,
        })),
        link_length_um: 50,
      }),
    ),
  );
  assert.equal(result.verification.status, 'passed_with_limitations');
});
