import { PDKSchema, type EngineeringIR, type CheckResult } from './contracts.js';
import { canonical } from './json.js';

export const primitiveModels = {
  waveguide: 'ideal_sin_waveguide_v1',
  ideal_coupler: 'ideal_coupler_v1',
  phase_shifter: 'ideal_phase_shifter_v1',
} as const;

export function genericChecks(ir: EngineeringIR): CheckResult[] {
  const spec = ir.specification;
  if (spec.device !== 'circuit') return [];
  const optical = Object.entries(ir.netlist.ports)
    .filter(
      ([, ep]) =>
        ir.netlist.instances
          .find((i) => i.name === ep.instance)
          ?.ports.find((p) => p.name === ep.port)?.domain === 'optical',
    )
    .map(([name]) => name)
    .sort();
  const kinds = [...new Set(ir.netlist.instances.map((i) => i.kind))].sort();
  const checks: [string, boolean, string][] = [
    [
      'generic_primitive_parameters',
      ir.netlist.instances.every(
        (i) =>
          i.ports.every((p) => p.direction === 'bidirectional') &&
          (i.kind !== 'ideal_coupler' || i.length_um === null),
      ),
      'Ideal models require bidirectional ports; zero-delay couplers do not accept propagation lengths.',
    ],
    [
      'generic_model_references',
      canonical(Object.keys(spec.models).sort()) === canonical(kinds) &&
        kinds.every((kind) => spec.models[kind] === primitiveModels[kind]) &&
        canonical(ir.technology) === canonical(PDKSchema.parse({})),
      'Every used primitive kind references the supported, uncalibrated model version.',
    ],
    [
      'generic_port_order',
      new Set(spec.port_order).size === spec.port_order.length &&
        canonical([...spec.port_order].sort()) === canonical(optical),
      'Explicit S-matrix order contains every external optical port exactly once.',
    ],
    [
      'generic_source_intent',
      canonical(ir.netlist) === canonical(spec.circuit) &&
        ir.hierarchy === null &&
        ir.assembly === null &&
        ir.operating_point === null &&
        !ir.layout_resolved &&
        ir.length_source === 'specification' &&
        Object.keys(ir.instance_paths).length === 0,
      'Generic simulation retains the supplied circuit and lengths; no layout is claimed.',
    ],
  ];
  return checks.map(([id, ok, detail]) => ({
    id,
    status: ok ? 'pass' : 'fail',
    detail,
    evidence: {},
  }));
}

export const genericLayoutChecks = (): CheckResult[] => [
  {
    id: 'layout_generation',
    status: 'not_run',
    detail:
      'Generic circuit placement/routing and GDS export are unsupported. No GDS was generated.',
    evidence: {},
  },
  {
    id: 'layout_verification',
    status: 'not_run',
    detail:
      'No physical layout, extracted connectivity, DRC or measured path lengths are available.',
    evidence: {},
  },
];
