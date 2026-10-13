import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, validateIR, canonical, SemanticError } from '../src/compiler.js';
import { EngineeringIRSchema } from '../src/contracts.js';
import { openAPI } from '../src/api.js';

for (const input of [
  { device: 'nanobeam' },
  { platform: 'silicon' },
  { wavelength_nm: NaN },
  { wavelength_nm: 0 },
  { sweep_points: 2 },
  { sweep_points: 100 },
  { outputs: [] },
  { outputs: ['gds', 'gds'] },
  { outputs: ['signoff'] },
  { delta_length_um: 1000 },
  { pdk: 'fake' },
]) {
  test(`reject unsupported specification ${JSON.stringify(input)}`, () =>
    assert.throws(() => compile(input)));
}
test('canonical compilation has normalized stable IDs and native Component/Port/PDK contracts', () => {
  const ir = compile({});
  assert.equal(
    ir.design_id,
    compile({
      device: 'mzi',
      platform: 'sin',
      wavelength_nm: 1550,
      outputs: ['netlist', 'simulation', 'gds', 'verification'],
    }).design_id,
  );
  assert.equal(canonical(ir), canonical(JSON.parse(JSON.stringify(ir))));
  assert.equal(ir.netlist.instances.length, 4);
  assert.equal(ir.technology.name, 'sin_demo_v1');
  assert.equal(ir.netlist.instances[0].ports[0].domain, 'optical');
  assert.equal(ir.length_source, 'specification');
});
const mutations: Record<string, (ir: ReturnType<typeof compile>) => void> = {
  missing_port: (ir) => {
    ir.netlist.connections[0].a.port = 'missing';
  },
  unknown_component: (ir) => {
    ir.netlist.connections[0].a.instance = 'unknown';
  },
  duplicate_component: (ir) => {
    ir.netlist.instances[1].name = ir.netlist.instances[0].name;
  },
  double_occupancy: (ir) => {
    ir.netlist.connections.push(ir.netlist.connections[0]);
  },
  dangling_port: (ir) => {
    ir.netlist.connections.pop();
  },
  incompatible_domain: (ir) => {
    ir.netlist.instances[2].ports[0].domain = 'electrical';
  },
  incompatible_direction: (ir) => {
    ir.netlist.instances[0].ports[2].direction = 'input';
    ir.netlist.instances[2].ports[0].direction = 'input';
  },
  duplicate_port: (ir) => {
    ir.netlist.instances[0].ports[1].name = 'o1';
  },
  missing_parameter: (ir) => {
    ir.netlist.instances[2].length_um = null;
  },
  pdk_violation: (ir) => {
    ir.technology.width_um = 0.1;
  },
  task_cycle: (ir) => {
    ir.workflow[0].depends_on = ['manifest'];
  },
  unknown_dependency: (ir) => {
    ir.workflow[0].depends_on = ['unknown'];
  },
  disconnected: (ir) => {
    ir.netlist.connections = [];
    ir.netlist.ports = Object.fromEntries(
      ir.netlist.instances.flatMap((i) =>
        i.ports.map((p) => [`${i.name}_${p.name}`, { instance: i.name, port: p.name }]),
      ),
    );
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`schema accepts but semantic validation rejects ${name}`, () => {
    const ir = compile({});
    mutate(ir);
    assert.equal(EngineeringIRSchema.safeParse(ir).success, true);
    assert.throws(() => validateIR(ir), SemanticError);
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
