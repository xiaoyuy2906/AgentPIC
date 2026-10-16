import { circuitAtPoint } from './tuning.js';
import {
  CircuitHierarchySchema,
  AssemblyPlanSchema,
  type CascadeSpec,
  type Circuit,
  type EngineeringIR,
  type CheckResult,
  type Endpoint,
} from './contracts.js';
import { flattenCircuit, instanceName } from './hierarchy.js';
import { mziCircuit } from './cells/mzi.js';

const endpoint = (instance: string, port: string): Endpoint => ({ instance, port });
const edge = (a: string, ap: string, b: string, bp: string) => ({
  a: endpoint(a, ap),
  b: endpoint(b, bp),
});

/** A design recipe composes reusable blocks through the generic hierarchy compiler. */
export function compileCascade(spec: CascadeSpec) {
  const definitions = spec.stages.map((stage, i) => {
    const circuit = mziCircuit(stage.delta_length_um, stage.phase_control);
    return {
      name: `definition${i}`,
      primitives: circuit.instances,
      modules: [],
      connections: circuit.connections,
      ports: circuit.ports,
    };
  });
  const primitives: Circuit['instances'] = [],
    connections: Circuit['connections'] = [];
  const links = [];
  for (let i = 0; i < spec.stages.length - 1; i++)
    for (let port = 0; port < 2; port++) {
      const name = `interconnect_${i}_${port}`,
        from = spec.stages[i].name,
        to = spec.stages[i + 1].name;
      primitives.push({ ...mziCircuit(0).instances[2], name, length_um: spec.link_length_um });
      connections.push(edge(from, `out${port}`, name, 'o1'), edge(name, 'o2', to, `in${port}`));
      links.push({
        instance: instanceName([name]),
        a: endpoint(from, `out${port}`),
        b: endpoint(to, `in${port}`),
      });
    }
  const hierarchy = CircuitHierarchySchema.parse({
    top: 'assembly',
    definitions: [
      ...definitions,
      {
        name: 'assembly',
        primitives,
        connections,
        modules: spec.stages.map((stage, i) => ({
          name: stage.name,
          definition: `definition${i}`,
        })),
        ports: {
          in0: endpoint(spec.stages[0].name, 'in0'),
          in1: endpoint(spec.stages[0].name, 'in1'),
          out0: endpoint(spec.stages.at(-1)!.name, 'out0'),
          out1: endpoint(spec.stages.at(-1)!.name, 'out1'),
          ...Object.fromEntries(
            spec.stages.flatMap((stage) =>
              stage.phase_control
                ? ['e1', 'e2'].map((port) => [
                    instanceName([stage.name, port]),
                    endpoint(stage.name, `phase_${port}`),
                  ])
                : [],
            ),
          ),
        },
      },
    ],
  });
  const flat = flattenCircuit(hierarchy);
  const assembly = AssemblyPlanSchema.parse({
    arrangement: 'series',
    link_length_um: spec.link_length_um,
    links,
    blocks: spec.stages.map((stage) => ({
      name: stage.name,
      cell: 'mzi',
      delta_length_um: stage.delta_length_um,
      primitives: Object.fromEntries(
        ['splitter', 'combiner', 'top_arm', 'bottom_arm'].map((name) => [
          name,
          instanceName([stage.name, name]),
        ]),
      ),
    })),
  });
  return { netlist: flat.circuit, hierarchy, instance_paths: flat.instance_paths, assembly };
}

const normalized = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(normalized).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + normalized(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
};
const topology = (circuit: Circuit, ignoreLengths: boolean) => ({
  instances: circuit.instances
    .map((i) => ({ ...i, length_um: ignoreLengths ? null : i.length_um }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  connections: circuit.connections
    .map((e) => [`${e.a.instance},${e.a.port}`, `${e.b.instance},${e.b.port}`].sort().join('|'))
    .sort(),
  ports: circuit.ports,
});

export function cascadeStructureCheck(ir: EngineeringIR): CheckResult[] {
  if (ir.specification.device !== 'mzi_cascade') {
    const emptyHierarchy =
      ir.hierarchy === null && ir.assembly === null && Object.keys(ir.instance_paths).length === 0;
    if (!emptyHierarchy)
      return [
        {
          id: 'hierarchy_intent_consistency',
          status: 'fail',
          detail: 'A single-MZI specification cannot carry a different assembly or hierarchy.',
          evidence: {},
        },
      ];
    if (
      ir.specification.phase_control ||
      ir.netlist.instances.some((i) => i.phase_control || i.kind === 'phase_shifter')
    ) {
      const expected = mziCircuit(ir.specification.delta_length_um, ir.specification.phase_control);
      return [
        {
          id: 'phase_intent_consistency',
          status:
            normalized(topology(ir.netlist, ir.layout_resolved)) ===
            normalized(topology(circuitAtPoint(expected, ir.operating_point), ir.layout_resolved))
              ? 'pass'
              : 'fail',
          detail: 'Controlled circuit and electrical terminals match the declared phase intent.',
          evidence: {},
        },
      ];
    }
    return [];
  }
  try {
    const expected = compileCascade(ir.specification);
    const matches =
      normalized(ir.hierarchy) === normalized(expected.hierarchy) &&
      normalized(ir.instance_paths) === normalized(expected.instance_paths) &&
      normalized(ir.assembly) === normalized(expected.assembly) &&
      normalized(topology(ir.netlist, ir.layout_resolved)) ===
        normalized(
          topology(circuitAtPoint(expected.netlist, ir.operating_point), ir.layout_resolved),
        );
    return [
      {
        id: 'hierarchy_intent_consistency',
        status: matches ? 'pass' : 'fail',
        detail:
          'Hierarchy, primitive paths, physical assembly and flattened circuit agree with the declared stage intent.',
        evidence: {},
      },
    ];
  } catch (error) {
    return [
      { id: 'hierarchy_intent_consistency', status: 'fail', detail: String(error), evidence: {} },
    ];
  }
}
