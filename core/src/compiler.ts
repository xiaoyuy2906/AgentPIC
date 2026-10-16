import { tuningSemantics } from './tuning.js';
import { mziCircuit } from './cells/mzi.js';
import { compileCascade, cascadeStructureCheck } from './cascade.js';
import { createHash } from 'node:crypto';
import {
  DesignSpecSchema,
  EngineeringIRSchema,
  PDKSchema,
  type EngineeringIR,
  type Endpoint,
  type CheckResult,
  type LayoutResult,
} from './contracts.js';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const endpointKey = (e: Endpoint) => `${e.instance},${e.port}` as const;
export class SemanticError extends Error {
  constructor(public checks: CheckResult[]) {
    super(
      checks
        .filter((c) => c.status === 'fail')
        .map((c) => `${c.id}: ${c.detail}`)
        .join('; '),
    );
  }
}
export function check(
  id: string,
  ok: boolean,
  detail: string,
  evidence: Record<string, unknown> = {},
): CheckResult {
  return { id, status: ok ? 'pass' : 'fail', detail, evidence };
}
/** Structural schema validation never replaces these engineering rules. */
export function semanticChecks(ir: EngineeringIR): CheckResult[] {
  const c = ir.netlist,
    spec = ir.specification;
  const instances = new Map(c.instances.map((i) => [i.name, i]));
  const ports = new Map(
    c.instances.flatMap((i) => i.ports.map((p) => [`${i.name},${p.name}`, p] as const)),
  );
  const counts = new Map<string, number>();
  const adjacency = new Map(c.instances.map((i) => [i.name, new Set<string>()]));
  let endpointsValid = true,
    compatible = true;
  for (const edge of c.connections) {
    const a = endpointKey(edge.a),
      b = endpointKey(edge.b);
    const ap = ports.get(a),
      bp = ports.get(b);
    endpointsValid &&= !!ap && !!bp && a !== b;
    if (ap && bp)
      compatible &&=
        ap.domain === bp.domain &&
        !(ap.direction === bp.direction && ap.direction !== 'bidirectional');
    for (const key of [a, b]) counts.set(key, (counts.get(key) ?? 0) + 1);
    adjacency.get(edge.a.instance)?.add(edge.b.instance);
    adjacency.get(edge.b.instance)?.add(edge.a.instance);
  }
  for (const endpoint of Object.values(c.ports)) {
    const key = endpointKey(endpoint);
    endpointsValid &&= ports.has(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Set<string>(),
    pending = [c.instances[0]?.name];
  while (pending.length) {
    const node = pending.pop();
    if (node && !seen.has(node)) {
      seen.add(node);
      pending.push(...(adjacency.get(node) ?? []));
    }
  }
  const tasks = new Map(ir.workflow.map((t) => [t.name, t]));
  const completed = new Set<string>();
  for (let n = 0; n < tasks.size; n++)
    for (const t of tasks.values())
      if (t.depends_on.every((d) => completed.has(d))) completed.add(t.name);
  return [
    ...cascadeStructureCheck(ir),
    ...tuningSemantics(ir),
    check(
      'specification_semantics',
      spec.sweep_points % 2 === 1 &&
        new Set(spec.outputs).size === spec.outputs.length &&
        spec.wavelength_nm - spec.sweep_span_nm / 2 >= 1450 &&
        spec.wavelength_nm + spec.sweep_span_nm / 2 <= 1650,
      'Unique outputs, odd sampling and supported wavelength interval.',
    ),
    check(
      'unique_components_and_ports',
      instances.size === c.instances.length &&
        ports.size === c.instances.reduce((n, i) => n + i.ports.length, 0),
      'Component names and ports must be unique.',
    ),
    check(
      'endpoint_references',
      endpointsValid,
      'Every endpoint refers to an existing component port; self-connections are rejected.',
    ),
    check('port_compatibility', compatible, 'Connected domains and directions must be compatible.'),
    check(
      'port_occupancy',
      [...ports.keys()].every((k) => counts.get(k) === 1) && counts.size === ports.size,
      'Every port must occur exactly once as an internal connection or external port.',
    ),
    check(
      'connected_topology',
      seen.size === instances.size,
      'The complete circuit graph must be connected.',
    ),
    check(
      'component_models',
      c.instances.every(
        (i) =>
          ir.technology.supported_components.includes(i.kind) &&
          (i.kind === 'phase_shifter'
            ? i.length_um !== null &&
              i.coupling_ratio === null &&
              i.phase_control !== null &&
              canonical(i.ports.map((p) => `${p.name}:${p.domain}`).sort()) ===
                canonical(['e1:electrical', 'e2:electrical', 'o1:optical', 'o2:optical'])
            : i.phase_control === null &&
              i.ports.every((p) => p.domain === 'optical') &&
              (i.kind === 'waveguide'
                ? i.length_um !== null &&
                  i.coupling_ratio === null &&
                  i.ports
                    .map((p) => p.name)
                    .sort()
                    .join(',') === 'o1,o2'
                : i.coupling_ratio !== null &&
                  i.ports
                    .map((p) => p.name)
                    .sort()
                    .join(',') === 'o1,o2,o3,o4')),
      ),
      'Component parameters and named ports must match the declared model and PDK support.',
    ),
    check(
      'pdk_geometry',
      ir.technology.width_um >= ir.technology.minimum_width_um &&
        canonical(ir.technology.heater_layer) !== canonical(ir.technology.core_layer) &&
        ir.technology.heater_width_um >= ir.technology.minimum_width_um,
      'Core width must satisfy the declared PDK minimum width.',
    ),
    check(
      'workflow_dependencies',
      tasks.size === ir.workflow.length && completed.size === tasks.size,
      'Workflow task names are unique and dependencies form a valid DAG.',
    ),
  ];
}
export function validateIR(input: unknown): EngineeringIR {
  const ir = EngineeringIRSchema.parse(input);
  const checks = semanticChecks(ir);
  if (checks.some((c) => c.status === 'fail')) throw new SemanticError(checks);
  return ir;
}
export function compile(input: unknown): EngineeringIR {
  const s = DesignSpecSchema.parse(input);
  const circuit =
    s.device === 'mzi'
      ? { netlist: mziCircuit(s.delta_length_um, s.phase_control) }
      : compileCascade(s);
  return validateIR({
    design_id: sha256(canonical(s)).slice(0, 16),
    specification: s,
    technology: PDKSchema.parse({}),
    ...circuit,
    workflow: [
      { name: 'compile', depends_on: [], backend: 'core' },
      { name: 'layout', depends_on: ['compile'], backend: 'layout' },
      { name: 'backannotate', depends_on: ['layout'], backend: 'core' },
      ...(s.tuning
        ? [{ name: 'tune', depends_on: ['backannotate'], backend: 'optimization' }]
        : []),
      { name: 'simulate', depends_on: [s.tuning ? 'tune' : 'backannotate'], backend: 'circuit' },
      { name: 'verify', depends_on: ['simulate', 'layout'], backend: 'verification' },
      { name: 'manifest', depends_on: ['verify'], backend: 'core' },
    ],
    assumptions: [
      'Illustrative SiN PDK; no foundry signoff.',
      'Ideal reciprocal 50:50 compact couplers; MMI polygons are not EM calibrated.',
      'Assumed neff=1.8 and ng=1.9 at 1550 nm; zero loss.',
      'Bend loss, taper phase and coupler dispersion omitted.',
      'Circuit-only compilation uses nominal 800 µm base arm; full layout flow backannotates measured lengths.',
    ],
  });
}
export function backannotate(input: EngineeringIR, layout: LayoutResult): EngineeringIR {
  const ir = structuredClone(input);
  for (const instance of ir.netlist.instances)
    if (instance.kind !== 'ideal_coupler') instance.length_um = layout.lengths_um[instance.name];
  ir.layout_resolved = true;
  ir.length_source = 'layout';
  return validateIR(ir);
}
