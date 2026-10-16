import {
  CircuitSchema,
  type Circuit,
  type RingSpec,
  type EngineeringIR,
  type CheckResult,
  type LayoutResult,
} from '../contracts.js';
import { canonical } from '../json.js';
import { circuitAtPoint } from '../tuning.js';

/** MMI-coupled feedback ring: two return paths connect the internal coupler lanes. */
export function ringCircuit(spec: RingSpec, radius = 50): Circuit {
  const ports = (names: string[]) =>
    names.map((name) => ({ name, domain: 'optical', direction: 'bidirectional' }));
  const endpoint = (instance: string, port: string) => ({ instance, port });
  const connection = (a: string, ap: string, b: string, bp: string) => ({
    a: endpoint(a, ap),
    b: endpoint(b, bp),
  });
  // Two quarter circles replace four radius-length straight sections. MMI inner lanes lie ±1.25 µm from each center.
  const length = spec.loop_height_um - 2.5 + 2 * spec.side_extension_um + (Math.PI - 4) * radius;
  return CircuitSchema.parse({
    instances: [
      ...['top_coupler', 'bottom_coupler'].map((name, i) => ({
        name,
        kind: 'ideal_coupler',
        ports: ports(['o1', 'o2', 'o3', 'o4']),
        coupling_ratio: spec.coupling_ratios[i],
      })),
      {
        name: 'right_return',
        kind: spec.phase_control ? 'phase_shifter' : 'waveguide',
        ports: [
          ...ports(['o1', 'o2']),
          ...(spec.phase_control
            ? ['e1', 'e2'].map((name) => ({
                name,
                domain: 'electrical',
                direction: 'bidirectional',
              }))
            : []),
        ],
        length_um: length,
        phase_control: spec.phase_control,
      },
      { name: 'left_return', kind: 'waveguide', ports: ports(['o1', 'o2']), length_um: length },
    ],
    connections: [
      connection('top_coupler', 'o4', 'right_return', 'o1'),
      connection('right_return', 'o2', 'bottom_coupler', 'o1'),
      connection('bottom_coupler', 'o4', 'left_return', 'o1'),
      connection('left_return', 'o2', 'top_coupler', 'o1'),
    ],
    ports: {
      in0: endpoint('top_coupler', 'o2'),
      in1: endpoint('bottom_coupler', 'o2'),
      out0: endpoint('top_coupler', 'o3'),
      out1: endpoint('bottom_coupler', 'o3'),
      ...(spec.phase_control
        ? { phase_e1: endpoint('right_return', 'e1'), phase_e2: endpoint('right_return', 'e2') }
        : {}),
    },
  });
}
export function ringStructureChecks(ir: EngineeringIR): CheckResult[] {
  const spec = ir.specification;
  if (spec.device !== 'ring_add_drop') return [];
  const normalize = (c: Circuit) => ({
    instances: c.instances
      .map((i) => ({ ...i, length_um: ir.layout_resolved ? null : i.length_um }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    connections: c.connections
      .map((e) => [`${e.a.instance},${e.a.port}`, `${e.b.instance},${e.b.port}`].sort().join('|'))
      .sort(),
    ports: c.ports,
  });
  const matches =
    ir.hierarchy === null &&
    ir.assembly === null &&
    Object.keys(ir.instance_paths).length === 0 &&
    canonical(normalize(ir.netlist)) ===
      canonical(
        normalize(
          circuitAtPoint(ringCircuit(spec, ir.technology.bend_radius_um), ir.operating_point),
        ),
      );
  const fits =
    spec.loop_height_um - 2.5 >= 2 * ir.technology.bend_radius_um &&
    spec.side_extension_um >=
      ir.technology.bend_radius_um + (spec.phase_control?.active_length_um ?? 0);
  return [
    {
      id: 'ring_intent_consistency',
      status: matches ? 'pass' : 'fail',
      detail:
        'Feedback topology, coupler ratios and controlled phase match the ring specification.',
      evidence: {},
    },
    {
      id: 'ring_geometry_feasibility',
      status: fits ? 'pass' : 'fail',
      detail: 'Requested return paths fit the PDK bends and optional actuator.',
      evidence: {},
    },
  ];
}

export function ringPhysicalChecks(ir: EngineeringIR, layout: LayoutResult): CheckResult[] {
  const spec = ir.specification;
  if (spec.device !== 'ring_add_drop') return [];
  const center = (name: string) => {
    const ports = Object.values(layout.ports[name] ?? {});
    return ports.reduce((sum, p) => sum + p.center_um[1], 0) / ports.length;
  };
  const right = layout.centerlines_um.right_return ?? [];
  const left = layout.centerlines_um.left_return ?? [];
  const error = Math.max(
    Math.abs(center('top_coupler') - center('bottom_coupler') - spec.loop_height_um),
    Math.abs(Math.max(...right.map((p) => p[0])) - (right[0]?.[0] ?? NaN) - spec.side_extension_um),
    Math.abs((left[0]?.[0] ?? NaN) - Math.min(...left.map((p) => p[0])) - spec.side_extension_um),
  );
  return [
    {
      id: 'requested_ring_dimensions',
      status: error <= 0.001 ? 'pass' : 'fail',
      detail:
        'Coupler center spacing and both return-path extensions match requested physical dimensions.',
      evidence: {
        maximum_error_um: error,
        modeled_round_trip_length_um:
          (layout.lengths_um.right_return ?? 0) + (layout.lengths_um.left_return ?? 0),
      },
    },
  ];
}
