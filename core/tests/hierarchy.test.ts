import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitHierarchySchema, CircuitSchema, type CircuitHierarchy } from '../src/contracts.js';
import { flattenCircuit, HierarchyError, instanceName } from '../src/hierarchy.js';
import { mziCircuit } from '../../designs/templates.js';

const endpoint = (instance: string, port: string) => ({ instance, port });
const edge = (a: string, ap: string, b: string, bp: string) => ({
  a: endpoint(a, ap),
  b: endpoint(b, bp),
});
const sample = (): CircuitHierarchy => {
  const mzi = CircuitSchema.parse(mziCircuit(10));
  return CircuitHierarchySchema.parse({
    top: 'cascade',
    definitions: [
      {
        name: 'mzi',
        primitives: mzi.instances,
        modules: [],
        connections: mzi.connections,
        ports: mzi.ports,
      },
      {
        name: 'cascade',
        primitives: [
          { ...mzi.instances[2], name: 'link0', length_um: 100 },
          { ...mzi.instances[2], name: 'link1', length_um: 100 },
        ],
        modules: [
          { name: 'first', definition: 'mzi' },
          { name: 'second', definition: 'mzi' },
        ],
        connections: [
          edge('first', 'out0', 'link0', 'o1'),
          edge('link0', 'o2', 'second', 'in0'),
          edge('first', 'out1', 'link1', 'o1'),
          edge('link1', 'o2', 'second', 'in1'),
        ],
        ports: {
          in0: endpoint('first', 'in0'),
          in1: endpoint('first', 'in1'),
          out0: endpoint('second', 'out0'),
          out1: endpoint('second', 'out1'),
        },
      },
    ],
  });
};
test('two reused modules flatten to distinct primitives with traceable aliases', () => {
  const hierarchy = sample();
  const before = structuredClone(hierarchy);
  const result = flattenCircuit(hierarchy);
  assert.equal(result.circuit.instances.length, 10);
  assert.equal(result.circuit.connections.length, 12);
  assert.deepEqual(Object.keys(result.circuit.ports), ['in0', 'in1', 'out0', 'out1']);
  assert.deepEqual(result.instance_paths[result.circuit.ports.in0.instance], ['first', 'splitter']);
  assert.equal(new Set(result.circuit.instances.map((i) => i.name)).size, 10);
  assert.deepEqual(hierarchy, before);
  assert.deepEqual(flattenCircuit(JSON.parse(JSON.stringify(hierarchy))), result);
  hierarchy.definitions.reverse();
  assert.deepEqual(flattenCircuit(hierarchy), result);
});
test('nested module port aliases resolve to the correct primitive', () => {
  const h = sample();
  const wrapper = {
    name: 'wrapper',
    primitives: [],
    modules: [{ name: 'inner', definition: 'mzi' }],
    connections: [],
    ports: Object.fromEntries(['in0', 'in1', 'out0', 'out1'].map((p) => [p, endpoint('inner', p)])),
  };
  h.definitions.push(wrapper);
  h.definitions[1].modules[0].definition = 'wrapper';
  const result = flattenCircuit(h);
  assert.deepEqual(result.instance_paths[result.circuit.ports.in0.instance], [
    'first',
    'inner',
    'splitter',
  ]);
});
test('flattened names cannot collide through underscores or encoded-looking user names', () => {
  const paths = [['a_b', 'c'], ['a', 'b_c'], ['a', 'b', 'c'], ['n1_a_n1_b_n1_c']];
  assert.equal(new Set(paths.map(instanceName)).size, paths.length);
});
const mutations: Record<string, [string, (h: CircuitHierarchy) => void]> = {
  missing_top: [
    'missing_top',
    (h) => {
      h.top = 'missing';
    },
  ],
  duplicate_definition: [
    'duplicate_definition',
    (h) => {
      h.definitions.push(h.definitions[0]);
    },
  ],
  missing_module: [
    'missing_definition',
    (h) => {
      h.definitions[1].modules[0].definition = 'missing';
    },
  ],
  recursion: [
    'recursive_definition',
    (h) => {
      h.definitions[1].modules[0].definition = 'cascade';
    },
  ],
  shared_namespace: [
    'duplicate_instance',
    (h) => {
      h.definitions[1].primitives[0].name = 'first';
    },
  ],
  missing_alias: [
    'missing_endpoint',
    (h) => {
      h.definitions[1].ports.in0.port = 'unknown';
    },
  ],
  duplicate_alias: [
    'port_occupancy',
    (h) => {
      h.definitions[1].ports.extra = h.definitions[1].ports.in0;
    },
  ],
  dangling_link: [
    'port_occupancy',
    (h) => {
      h.definitions[1].connections.pop();
    },
  ],
  wrong_domain: [
    'incompatible_ports',
    (h) => {
      h.definitions[1].primitives[0].ports[0].domain = 'electrical';
    },
  ],
  disconnected: [
    'disconnected_circuit',
    (h) => {
      h.definitions[1].primitives.push({ ...h.definitions[1].primitives[0], name: 'isolated' });
      h.definitions[1].ports.extra_in = endpoint('isolated', 'o1');
      h.definitions[1].ports.extra_out = endpoint('isolated', 'o2');
    },
  ],
};
for (const [name, [code, mutate]] of Object.entries(mutations))
  test(`hierarchy semantics reject ${name}`, () => {
    const h = sample();
    mutate(h);
    assert.ok(CircuitHierarchySchema.safeParse(h).success);
    assert.throws(
      () => flattenCircuit(h),
      (error: unknown) => error instanceof HierarchyError && error.code === code,
    );
  });
test('hierarchy expansion has a finite primitive budget', () => {
  const primitive = CircuitSchema.parse(mziCircuit(10)).instances[2];
  const definitions: CircuitHierarchy['definitions'] = [
    {
      name: 'level0',
      primitives: [primitive],
      modules: [],
      connections: [],
      ports: { in0: endpoint(primitive.name, 'o1'), out0: endpoint(primitive.name, 'o2') },
    },
  ];
  for (let level = 1; level <= 15; level++)
    definitions.push({
      name: `level${level}`,
      primitives: [],
      modules: [
        { name: 'left', definition: `level${level - 1}` },
        { name: 'right', definition: `level${level - 1}` },
      ],
      connections: [edge('left', 'out0', 'right', 'in0')],
      ports: { in0: endpoint('left', 'in0'), out0: endpoint('right', 'out0') },
    });
  assert.throws(() => flattenCircuit({ top: 'level15', definitions }), /hierarchy_limit/);
});

test('HTTP flattens a hierarchy and reports structured semantic errors', async () => {
  const { createAPI } = await import('../src/api.js');
  const server = createAPI();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/circuits/flatten`;
  try {
    const hierarchy = sample();
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(hierarchy) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), flattenCircuit(hierarchy));
    hierarchy.definitions[1].modules[0].definition = 'missing';
    const rejected = await fetch(url, { method: 'POST', body: JSON.stringify(hierarchy) });
    assert.equal(rejected.status, 422);
    assert.equal(((await rejected.json()) as { code: string }).code, 'missing_definition');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('MCP exposes the same hierarchy contract and neutral flattened circuit', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { projectRoot } = await import('../src/backends.js');
  const client = new Client({ name: 'hierarchy-test', version: '1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'core/src/cli.ts', 'mcp'],
    cwd: projectRoot,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: 'flatten_circuit',
      arguments: { hierarchy: sample() },
    });
    assert.ok(!response.isError, JSON.stringify(response));
    assert.deepEqual(response.structuredContent, flattenCircuit(sample()));
  } finally {
    await client.close();
  }
});
