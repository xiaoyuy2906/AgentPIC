/** Closed-form acceptance references; never imported by the production compiler/backend. */
import {
  CircuitSchema,
  DesignSpecSchema,
  type EngineeringIR,
  type SimulationResult,
} from '../core/src/contracts.js';
import { componentMode } from '../core/src/pdk.js';

/**
 * Returns null when a flat circuit has no closed form here (only chains and single couplers).
 * `resolved` is the simulated IR: measured lengths when the design has a layout, and the PDK
 * whose waveguide mode model the closed form must use.
 */
export function genericBenchmark(
  input: unknown,
  result: SimulationResult,
  resolved: EngineeringIR,
) {
  const parsed = DesignSpecSchema.parse(input);
  const circuit = CircuitSchema.safeParse(parsed.circuit);
  if (!circuit.success) return null;
  const spec = { ...parsed, circuit: resolved.netlist };
  const mode = componentMode(resolved.technology, 'waveguide')!;
  const [n0, ng, wl0] = [mode.effective_index, mode.group_index, mode.reference_wavelength_um];
  const chain = spec.circuit.instances.every((i) => i.kind === 'waveguide');
  const coupler =
    spec.circuit.instances.length === 1 && spec.circuit.instances[0].kind === 'ideal_coupler';
  if (!chain && !coupler) return null;
  if (JSON.stringify(result.ports) !== JSON.stringify(spec.port_order))
    throw new Error('Port order changed');
  if (chain && result.ports.length !== 2)
    throw new Error('Chain reference requires two external ports');
  const length = spec.circuit.instances.reduce((sum, i) => sum + (i.length_um ?? 0), 0);
  let maxError = 0;
  for (const [k, wavelength] of result.wavelength_nm.entries()) {
    const wl = wavelength / 1000;
    const phase = (2 * Math.PI * (n0 + ((n0 - ng) * (wl - wl0)) / wl0) * length) / wl;
    for (const [i, output] of spec.port_order.entries())
      for (const [j, incoming] of spec.port_order.entries()) {
        let real = 0,
          imag = 0;
        if (chain && i !== j) {
          real = Math.cos(phase);
          imag = Math.sin(phase);
        }
        if (coupler) {
          const pair = [spec.circuit.ports[output].port, spec.circuit.ports[incoming].port]
            .sort()
            .join(',');
          const ratio = spec.circuit.instances[0].coupling_ratio!;
          if (['o1,o4', 'o2,o3'].includes(pair)) real = Math.sqrt(1 - ratio);
          if (['o1,o3', 'o2,o4'].includes(pair)) imag = Math.sqrt(ratio);
        }
        maxError = Math.max(
          maxError,
          Math.hypot(result.s_real[k][i][j] - real, result.s_imag[k][i][j] - imag),
        );
      }
  }
  if (!(maxError < 1e-9)) throw new Error(`Closed-form complex amplitude error: ${maxError}`);
  return {
    status: 'pass',
    reference: chain
      ? 'exp(i beta sum(lengths)) with zero reflection'
      : 'sqrt(1-k) through and i sqrt(k) cross',
    ports: spec.port_order,
    matrix_shape: [result.wavelength_nm.length, spec.port_order.length, spec.port_order.length],
    max_complex_error: maxError,
    tolerance: 1e-9,
    physical_calibration: 'not_performed',
  };
}
