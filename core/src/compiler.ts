import { canonical } from './json.js';
import { check } from './check.js';
import { designChecks, sourceCircuit } from './design.js';
import { tuningSemantics } from './tuning.js';
import { loadPDK, pdkChecks, uncalibratedSources } from './pdk.js';
import { createHash } from 'node:crypto';
import {
  DesignSpecSchema,
  EngineeringIRSchema,
  type EngineeringIR,
  type PDK,
  type Endpoint,
  type CheckResult,
  type LayoutResult,
} from './contracts.js';
export { canonical } from './json.js';
export { check } from './check.js';
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const endpointKey = (e: Endpoint) => `${e.instance},${e.port}` as const;
export class SemanticError extends Error {
  constructor(public checks: CheckResult[]) {
    super(
      checks
        .filter((c) => c.status === 'fail')
        .map((c) => {
          const problems = c.evidence.problems;
          return `${c.id}: ${c.detail}${Array.isArray(problems) && problems.length ? ` [${problems.join('; ')}]` : ''}`;
        })
        .join('; '),
    );
  }
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
    ...designChecks(ir),
    ...tuningSemantics(ir),
    check(
      'specification_semantics',
      spec.sweep_points % 2 === 1 && new Set(spec.outputs).size === spec.outputs.length,
      'Unique outputs and odd sampling, so the sweep centre is a sample.',
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
    ...pdkChecks(ir),
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
  const physical = s.layout !== null;
  let technology: PDK;
  try {
    technology = loadPDK(s.pdk);
  } catch (error) {
    throw new SemanticError([check('pdk_reference', false, `Cannot load PDK ${s.pdk}: ${error}`)]);
  }
  return validateIR({
    // The PDK content is part of the identity: the same circuit on a changed process differs.
    design_id: sha256(canonical({ specification: s, technology })).slice(0, 16),
    specification: s,
    technology,
    ...sourceCircuit(s),
    workflow: [
      { name: 'compile', depends_on: [], backend: 'core' },
      ...(physical
        ? [
            { name: 'layout', depends_on: ['compile'], backend: 'layout' },
            { name: 'backannotate', depends_on: ['layout'], backend: 'core' },
          ]
        : []),
      ...(s.tuning
        ? [
            {
              name: 'tune',
              depends_on: [physical ? 'backannotate' : 'compile'],
              backend: 'optimization',
            },
          ]
        : []),
      {
        name: 'simulate',
        depends_on: [s.tuning ? 'tune' : physical ? 'backannotate' : 'compile'],
        backend: 'circuit',
      },
      {
        name: 'verify',
        depends_on: physical ? ['simulate', 'layout'] : ['simulate'],
        backend: 'verification',
      },
      { name: 'manifest', depends_on: ['verify'], backend: 'core' },
    ],
    assumptions: [
      ...(technology.foundry ? [] : [`${technology.name} is not a foundry PDK; no signoff.`]),
      ...uncalibratedSources(technology),
      'Bend loss, taper phase and coupler dispersion omitted; coupler internal delay and phase are zero.',
      physical
        ? 'Circuit-only compilation uses nominal path lengths; the layout flow backannotates measured lengths.'
        : 'No layout plan: simulation uses supplied path lengths and claims no physical layout.',
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
