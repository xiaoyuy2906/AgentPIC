import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, validateIR, canonical, SemanticError } from '../src/compiler.js';
import { EngineeringIRSchema } from '../src/contracts.js';
import { openAPI } from '../src/api.js';
import { designs, mzi, type DesignInput } from '../../designs/templates.js';

const base = designs.mzi;
const edit = (design: DesignInput, change: (d: any) => void) => {
  const copy = structuredClone(design);
  change(copy);
  return copy;
};
const failing = (ir: ReturnType<typeof compile>) => {
  try {
    validateIR(ir);
  } catch (error) {
    assert.ok(error instanceof SemanticError);
    return error.checks.filter((c) => c.status === 'fail').map((c) => c.id);
  }
  return [];
};

for (const [label, change] of [
  ['unknown device field', (d: any) => (d.device = 'mzi')],
  ['unknown platform', (d: any) => (d.platform = 'silicon')],
  ['missing name', (d: any) => delete d.name],
  ['NaN wavelength', (d: any) => (d.wavelength_nm = NaN)],
  ['zero wavelength', (d: any) => (d.wavelength_nm = 0)],
  ['two samples', (d: any) => (d.sweep_points = 2)],
  ['even samples', (d: any) => (d.sweep_points = 100)],
  ['no outputs', (d: any) => (d.outputs = [])],
  ['duplicate outputs', (d: any) => (d.outputs = ['gds', 'gds'])],
  ['unsupported output', (d: any) => (d.outputs = ['signoff'])],
  ['missing optical port in order', (d: any) => d.port_order.pop()],
  ['duplicate port order', (d: any) => (d.port_order[3] = 'in0')],
  ['electrical port in order', (d: any) => (d.port_order = ['in0', 'in1', 'out0', 'phase_e1'])],
  [
    'unknown measurement port',
    (d: any) =>
      (d.measurements = [{ kind: 'resonances', input_port: 'in0', output_port: 'nowhere' }]),
  ],
] as const)
  test(`reject specification with ${label}`, () =>
    assert.throws(() => compile(edit(base, change))));

test('canonical compilation has stable IDs and native Component/Port/PDK contracts', () => {
  const ir = compile(base);
  assert.equal(ir.design_id, compile(JSON.parse(canonical(base))).design_id);
  assert.notEqual(ir.design_id, compile(mzi({ delta_length_um: 11 })).design_id);
  assert.equal(canonical(ir), canonical(JSON.parse(JSON.stringify(ir))));
  assert.equal(ir.netlist.instances.length, 4);
  assert.equal(ir.technology.name, 'sin_demo_v1');
  assert.equal(ir.netlist.instances[0].ports[0].domain, 'optical');
  assert.equal(ir.length_source, 'specification');
  assert.deepEqual(ir.instance_paths.top_arm, ['top_arm']);
  assert.deepEqual(
    ir.workflow.map((t) => t.name),
    ['compile', 'layout', 'backannotate', 'simulate', 'verify', 'manifest'],
  );
});
test('a hierarchical design flattens with source paths and keeps its module definitions', () => {
  const ir = compile(designs.mzi_cascade);
  assert.equal(ir.netlist.instances.length, 10);
  assert.equal(ir.netlist.connections.length, 12);
  assert.equal(Object.keys(ir.instance_paths).length, 10);
  assert.ok(ir.hierarchy);
  assert.ok(Object.values(ir.instance_paths).some((p) => p.join('/') === 'second/top_arm'));
});
test('a design without a layout plan skips layout and backannotation', () => {
  assert.deepEqual(
    compile(designs.coupler).workflow.map((t) => t.name),
    ['compile', 'simulate', 'verify', 'manifest'],
  );
});

const mutations: Record<string, [(ir: ReturnType<typeof compile>) => void, string]> = {
  missing_port: [(ir) => (ir.netlist.connections[0].a.port = 'missing'), 'endpoint_references'],
  unknown_component: [
    (ir) => (ir.netlist.connections[0].a.instance = 'unknown'),
    'endpoint_references',
  ],
  duplicate_component: [
    (ir) => (ir.netlist.instances[1].name = ir.netlist.instances[0].name),
    'unique_components_and_ports',
  ],
  double_occupancy: [
    (ir) => ir.netlist.connections.push(ir.netlist.connections[0]),
    'port_occupancy',
  ],
  dangling_port: [(ir) => ir.netlist.connections.pop(), 'port_occupancy'],
  incompatible_domain: [
    (ir) => (ir.netlist.instances[2].ports[0].domain = 'electrical'),
    'port_compatibility',
  ],
  incompatible_direction: [
    (ir) => {
      ir.netlist.instances[0].ports[2].direction = 'input';
      ir.netlist.instances[2].ports[0].direction = 'input';
    },
    'port_compatibility',
  ],
  duplicate_port: [
    (ir) => (ir.netlist.instances[0].ports[1].name = 'o1'),
    'unique_components_and_ports',
  ],
  missing_parameter: [(ir) => (ir.netlist.instances[2].length_um = null), 'component_models'],
  pdk_violation: [(ir) => (ir.technology.width_um = 0.1), 'pdk_geometry'],
  task_cycle: [(ir) => (ir.workflow[0].depends_on = ['manifest']), 'workflow_dependencies'],
  unknown_dependency: [(ir) => (ir.workflow[0].depends_on = ['unknown']), 'workflow_dependencies'],
  changed_ratio: [
    (ir) => (ir.netlist.instances[0].coupling_ratio = 0.4),
    'source_intent_consistency',
  ],
  false_layout_claim: [(ir) => (ir.layout_resolved = true), 'source_intent_consistency'],
  forged_source_path: [(ir) => (ir.instance_paths.top_arm = ['fake']), 'source_intent_consistency'],
  disconnected: [
    (ir) => {
      ir.netlist.connections = [];
      ir.netlist.ports = Object.fromEntries(
        ir.netlist.instances.flatMap((i) =>
          i.ports.map((p) => [`${i.name}_${p.name}`, { instance: i.name, port: p.name }]),
        ),
      );
    },
    'connected_topology',
  ],
};
for (const [name, [mutate, id]] of Object.entries(mutations))
  test(`schema accepts but semantic validation rejects ${name}`, () => {
    const ir = compile(base);
    mutate(ir);
    assert.equal(EngineeringIRSchema.safeParse(ir).success, true);
    assert.ok(failing(ir).includes(id), `${name}: ${failing(ir)}`);
  });

for (const [label, change] of [
  ['an unknown instance path', (d: any) => (d.layout.routes.nowhere = { steps: [] })],
  ['an instance neither placed nor routed', (d: any) => delete d.layout.routes.top_arm],
  ['an instance placed and routed', (d: any) => (d.layout.placements.top_arm = {})],
  [
    'a routed coupler',
    (d: any) => {
      d.layout.routes.combiner = { steps: [] };
      delete d.layout.placements.combiner;
    },
  ],
  ['an anchor without its own port', (d: any) => (d.layout.placements.combiner.port = null)],
  ['an anchor to a missing port', (d: any) => (d.layout.placements.combiner.anchor.port = 'o9')],
  [
    'a cyclic anchor',
    (d: any) =>
      (d.layout.placements.splitter = {
        anchor: { instance: 'combiner', port: 'o1' },
        port: 'o1',
      }),
  ],
  [
    'a constraint on a coupler',
    (d: any) => d.layout.constraints.push({ kind: 'length', instance: 'splitter', value_um: 1 }),
  ],
] as const)
  test(`layout plan rejects ${label}`, () => {
    assert.throws(() => compile(edit(base, change)), /layout_plan/);
  });
test('layout plan rejects a route whose end is not a placed instance', () => {
  const chain = edit(designs.waveguide_chain, (d) => {
    d.layout = { placements: { first: {}, third: { x_um: 100 } }, routes: { second: {} } };
  });
  compile(chain);
  const external = edit(chain, (d) => {
    d.layout.routes = { first: {} };
    d.layout.placements = { second: {}, third: { x_um: 100 } };
  });
  assert.throws(() => compile(external), /first\.o1 must connect to a placed instance/);
});

test('OpenAPI local schema references resolve', () => {
  const api = openAPI() as unknown as Record<string, unknown>;
  const walk = (obj: unknown) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/')) {
        let target: unknown = api;
        for (const part of value.slice(2).split('/'))
          target = (target as Record<string, unknown>)?.[part];
        assert.ok(target, `Unresolved ${value}`);
      } else walk(value);
    }
  };
  walk(api);
});
