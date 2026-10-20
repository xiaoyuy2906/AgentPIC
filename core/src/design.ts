/** Design-input semantics. Engine code never names a device family; designs are data. */
import { check } from './check.js';
import { flattenCircuit } from './hierarchy.js';
import { canonical } from './json.js';
import { circuitAtPoint } from './tuning.js';
import type { Circuit, CheckResult, DesignSpec, EngineeringIR, Endpoint } from './contracts.js';

/** Resolve the submitted circuit into one flat netlist plus a source path for every instance. */
export function sourceCircuit(spec: DesignSpec) {
  if ('definitions' in spec.circuit) {
    const flat = flattenCircuit(spec.circuit);
    return { netlist: flat.circuit, hierarchy: spec.circuit, instance_paths: flat.instance_paths };
  }
  return {
    netlist: spec.circuit,
    hierarchy: null,
    instance_paths: Object.fromEntries(spec.circuit.instances.map((i) => [i.name, [i.name]])),
  };
}
/** Layout plans and constraints address instances by "module/instance" source paths. */
export const pathIndex = (ir: EngineeringIR) =>
  new Map(Object.entries(ir.instance_paths).map(([name, path]) => [path.join('/'), name]));
const label = (ir: EngineeringIR, name: string) => ir.instance_paths[name]?.join('/') ?? name;
const key = (e: Endpoint) => `${e.instance},${e.port}`;
const portDomain = (circuit: Circuit, e: Endpoint) =>
  circuit.instances.find((i) => i.name === e.instance)?.ports.find((p) => p.name === e.port)
    ?.domain;
export const opticalPorts = (circuit: Circuit) =>
  Object.entries(circuit.ports)
    .filter(([, e]) => portDomain(circuit, e) === 'optical')
    .map(([name]) => name);
const topology = (circuit: Circuit, ignoreLengths: boolean) => ({
  instances: circuit.instances
    .map((i) => ({ ...i, length_um: ignoreLengths ? null : i.length_um }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  connections: circuit.connections.map((e) => [key(e.a), key(e.b)].sort().join('|')).sort(),
  ports: circuit.ports,
});

function sourceIntent(ir: EngineeringIR): CheckResult {
  try {
    const source = sourceCircuit(ir.specification);
    const resolved = ir.layout_resolved;
    return check(
      'source_intent_consistency',
      canonical(topology(ir.netlist, resolved)) ===
        canonical(topology(circuitAtPoint(source.netlist, ir.operating_point), resolved)) &&
        canonical(ir.hierarchy) === canonical(source.hierarchy) &&
        canonical(ir.instance_paths) === canonical(source.instance_paths) &&
        (resolved
          ? ir.specification.layout !== null && ir.length_source === 'layout'
          : ir.length_source === 'specification'),
      'Netlist, hierarchy and source paths equal the submitted circuit, apart from measured lengths and the applied operating point.',
    );
  } catch (error) {
    return check('source_intent_consistency', false, String(error));
  }
}

function layoutPlan(ir: EngineeringIR): CheckResult[] {
  const plan = ir.specification.layout;
  if (!plan) return [];
  const problems: string[] = [];
  const index = pathIndex(ir);
  const instances = new Map(ir.netlist.instances.map((i) => [i.name, i]));
  const resolve = (path: string) => {
    const name = index.get(path);
    if (!name) problems.push(`unknown instance path ${path}`);
    return name;
  };
  const placed = new Map(
    Object.entries(plan.placements).flatMap(([path, p]) => {
      const name = resolve(path);
      return name ? [[name, p] as const] : [];
    }),
  );
  const routed = new Set(Object.keys(plan.routes).flatMap((path) => resolve(path) ?? []));
  for (const i of ir.netlist.instances)
    if (Number(placed.has(i.name)) + Number(routed.has(i.name)) !== 1)
      problems.push(`${label(ir, i.name)} must be placed or routed exactly once`);
  const neighbour = new Map<string, Endpoint>();
  for (const e of ir.netlist.connections) {
    neighbour.set(key(e.a), e.b);
    neighbour.set(key(e.b), e.a);
  }
  for (const name of routed) {
    if (instances.get(name)?.kind === 'ideal_coupler')
      problems.push(`${label(ir, name)} has fixed geometry and must be placed`);
    for (const port of ['o1', 'o2'])
      if (!placed.has(neighbour.get(`${name},${port}`)?.instance ?? ''))
        problems.push(`${label(ir, name)}.${port} must connect to a placed instance`);
  }
  const anchors = new Map<string, string>();
  for (const [name, p] of placed) {
    if ((p.anchor === null) !== (p.port === null))
      problems.push(`${label(ir, name)} anchor and port must be given together`);
    if (p.port && !instances.get(name)?.ports.some((q) => q.name === p.port))
      problems.push(`${label(ir, name)} has no port ${p.port}`);
    if (!p.anchor) continue;
    const target = index.get(p.anchor.instance);
    if (!target || !placed.has(target))
      problems.push(`${label(ir, name)} anchor ${p.anchor.instance} is not placed`);
    else if (!instances.get(target)!.ports.some((q) => q.name === p.anchor!.port))
      problems.push(`${label(ir, name)} anchor port ${p.anchor.port} does not exist`);
    else anchors.set(name, target);
  }
  for (const start of anchors.keys()) {
    const seen = new Set<string>();
    for (let n: string | undefined = start; n !== undefined; n = anchors.get(n)) {
      if (seen.has(n)) {
        problems.push(`${label(ir, start)} has a cyclic placement anchor`);
        break;
      }
      seen.add(n);
    }
  }
  for (const c of plan.constraints)
    for (const path of c.kind === 'length' ? [c.instance] : [c.a, c.b]) {
      const name = index.get(path);
      if (!name || instances.get(name)!.kind === 'ideal_coupler')
        problems.push(`constraint path ${path} must name a waveguide or phase shifter`);
    }
  return [
    check(
      'layout_plan',
      problems.length === 0,
      'Every instance is placed or routed once; routes join placed ports; anchors and constraints resolve.',
      { problems },
    ),
  ];
}

export function designChecks(ir: EngineeringIR): CheckResult[] {
  const spec = ir.specification;
  const optical = opticalPorts(ir.netlist).sort();
  return [
    sourceIntent(ir),
    check(
      'port_order',
      new Set(spec.port_order).size === spec.port_order.length &&
        canonical([...spec.port_order].sort()) === canonical(optical),
      'Explicit S-matrix order contains every external optical port exactly once.',
    ),
    check(
      'primitive_parameters',
      ir.netlist.instances.every(
        (i) =>
          i.ports.every((p) => p.direction === 'bidirectional') &&
          (i.kind !== 'ideal_coupler' || i.length_um === null),
      ),
      'Ideal models require bidirectional ports; zero-delay couplers do not accept propagation lengths.',
    ),
    ...layoutPlan(ir),
    ...(spec.measurements.length
      ? [
          check(
            'measurement_references',
            spec.measurements.every(
              (m) => optical.includes(m.input_port) && optical.includes(m.output_port),
            ),
            'Spectral measurements refer to external optical ports.',
          ),
        ]
      : []),
  ];
}
