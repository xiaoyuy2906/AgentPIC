import type { Circuit, EngineeringIR, CheckResult, ResolvedTuningVariable } from './contracts.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function sampleIndex(ir: EngineeringIR, wavelength: number): number {
  const s = ir.specification;
  const index = Math.round(
    ((wavelength - s.wavelength_nm + s.sweep_span_nm / 2) * (s.sweep_points - 1)) / s.sweep_span_nm,
  );
  const actual =
    s.wavelength_nm - s.sweep_span_nm / 2 + (index * s.sweep_span_nm) / (s.sweep_points - 1);
  if (index < 0 || index >= s.sweep_points || Math.abs(actual - wavelength) > 1e-9)
    throw new Error('Tuning target wavelength must be on the exported sweep grid.');
  return index;
}
export function resolveVariables(ir: EngineeringIR): ResolvedTuningVariable[] {
  const tuning = ir.specification.tuning;
  if (!tuning) throw new Error('No tuning request.');
  const variables = tuning.variables.map((v) => {
    const instance = ir.netlist.instances.find((i) =>
      same(ir.instance_paths[i.name] ?? [i.name], v.instance_path),
    );
    if (!instance || instance.kind !== 'phase_shifter' || !instance.phase_control)
      throw new Error(
        `Tuning path is not a controlled phase shifter: ${v.instance_path.join('/')}`,
      );
    if (!(v.min_phase_rad < v.max_phase_rad))
      throw new Error('Tuning phase bounds must be ordered.');
    return {
      instance: instance.name,
      min_phase_rad: v.min_phase_rad,
      max_phase_rad: v.max_phase_rad,
    };
  });
  if (new Set(variables.map((v) => v.instance)).size !== variables.length)
    throw new Error('Tuning variables must be unique.');
  return variables;
}
export function validateControls(
  variables: ResolvedTuningVariable[],
  controls: Record<string, number>,
) {
  if (!same(Object.keys(controls).sort(), variables.map((v) => v.instance).sort()))
    throw new Error('Operating point must contain exactly the selected phase variables.');
  for (const v of variables) {
    const p = controls[v.instance];
    if (!Number.isFinite(p) || p < v.min_phase_rad || p > v.max_phase_rad)
      throw new Error(`Phase outside requested bounds: ${v.instance}`);
  }
}
/** Used for recipe comparison; semantic checks separately constrain the allowed keys/bounds. */
export function circuitAtPoint(circuit: Circuit, point: Record<string, number> | null): Circuit {
  const result = structuredClone(circuit);
  if (point)
    for (const i of result.instances)
      if (i.phase_control && Object.hasOwn(point, i.name))
        i.phase_control.phase_rad = point[i.name];
  return result;
}
export function applyOperatingPoint(
  ir: EngineeringIR,
  controls: Record<string, number>,
): EngineeringIR {
  validateControls(resolveVariables(ir), controls);
  return {
    ...structuredClone(ir),
    netlist: circuitAtPoint(ir.netlist, controls),
    operating_point: { ...controls },
  };
}
export function tuningSemantics(ir: EngineeringIR): CheckResult[] {
  if (!ir.specification.tuning && !ir.operating_point) return [];
  try {
    const request = ir.specification.tuning;
    if (!request) throw new Error('Operating point requires a tuning request.');
    const variables = resolveVariables(ir);
    const current = Object.fromEntries(
      variables.map((v) => [
        v.instance,
        ir.netlist.instances.find((i) => i.name === v.instance)!.phase_control!.phase_rad,
      ]),
    );
    validateControls(variables, current);
    if (ir.operating_point) {
      validateControls(variables, ir.operating_point);
      if (variables.some((v) => current[v.instance] !== ir.operating_point![v.instance]))
        throw new Error('Applied phase differs from the operating point.');
    }
    const keys = new Set<string>();
    for (const target of request.targets) {
      sampleIndex(ir, target.wavelength_nm);
      const key = JSON.stringify([target.input_port, target.output_port, target.wavelength_nm]);
      if (keys.has(key)) throw new Error('Tuning targets must be unique.');
      keys.add(key);
      for (const port of [target.input_port, target.output_port]) {
        const ep = ir.netlist.ports[port];
        const domain =
          ep &&
          ir.netlist.instances
            .find((i) => i.name === ep.instance)
            ?.ports.find((p) => p.name === ep.port)?.domain;
        if (domain !== 'optical')
          throw new Error(`Tuning target must refer to an external optical port: ${port}`);
      }
    }
    return [
      {
        id: 'tuning_semantics',
        status: 'pass',
        detail: 'Targets, phase paths, bounds and operating point are consistent.',
        evidence: {},
      },
    ];
  } catch (error) {
    return [{ id: 'tuning_semantics', status: 'fail', detail: String(error), evidence: {} }];
  }
}
