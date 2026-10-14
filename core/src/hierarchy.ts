import {
  CircuitHierarchySchema,
  FlattenedCircuitSchema,
  type CircuitDefinition,
  type Circuit,
  type Endpoint,
  type FlattenedCircuit,
} from './contracts.js';

export class HierarchyError extends Error {
  constructor(
    readonly code: string,
    readonly location: string,
    detail: string,
  ) {
    super(`${code} at ${location}: ${detail}`);
  }
}
const fail = (code: string, location: string, detail: string): never => {
  throw new HierarchyError(code, location, detail);
};
// Length-prefixed segments avoid collisions between user names and hierarchy separators.
export const instanceName = (segments: string[]) =>
  segments.map((segment) => `n${segment.length}_${segment}`).join('_');

/** Flatten module aliases into a solver-neutral primitive circuit, retaining source paths. */
export function flattenCircuit(input: unknown): FlattenedCircuit {
  const hierarchy = CircuitHierarchySchema.parse(input);
  const definitions = new Map(hierarchy.definitions.map((d) => [d.name, d]));
  if (definitions.size !== hierarchy.definitions.length)
    fail('duplicate_definition', hierarchy.top, 'Definition names must be unique.');
  if (!definitions.has(hierarchy.top))
    fail('missing_top', hierarchy.top, 'Unknown top definition.');

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string, depth: number) => {
    if (depth > 32) fail('hierarchy_limit', name, 'Maximum module depth is 32.');
    if (visiting.has(name))
      fail('recursive_definition', name, 'Module definitions must be acyclic.');
    if (visited.has(name)) return;
    const definition = definitions.get(name);
    if (!definition) fail('missing_definition', name, 'Referenced module is not defined.');
    visiting.add(name);
    for (const module of definition!.modules) visit(module.definition, depth + 1);
    visiting.delete(name);
    visited.add(name);
  };
  for (const definition of definitions.values()) visit(definition.name, 0);

  for (const definition of definitions.values()) {
    const available = new Set<string>();
    const instanceNames = new Set<string>();
    for (const instance of [...definition.primitives, ...definition.modules]) {
      if (instanceNames.has(instance.name))
        fail('duplicate_instance', definition.name, instance.name);
      instanceNames.add(instance.name);
      const ports =
        'definition' in instance
          ? Object.keys(definitions.get(instance.definition)!.ports)
          : instance.ports.map((p) => p.name);
      if (new Set(ports).size !== ports.length)
        fail('duplicate_port', `${definition.name}/${instance.name}`, 'Port names must be unique.');
      for (const port of ports) available.add(`${instance.name},${port}`);
    }
    if (instanceNames.size === 0)
      fail('empty_definition', definition.name, 'No circuit instances.');
    const uses = new Map<string, number>();
    const use = (endpoint: Endpoint) => {
      const key = `${endpoint.instance},${endpoint.port}`;
      if (!available.has(key)) fail('missing_endpoint', definition.name, key);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    };
    for (const connection of definition.connections) {
      use(connection.a);
      use(connection.b);
    }
    for (const endpoint of Object.values(definition.ports)) use(endpoint);
    for (const key of available)
      if (uses.get(key) !== 1)
        fail('port_occupancy', definition.name, `${key} must occur exactly once.`);
  }

  const circuit: Circuit = { instances: [], connections: [], ports: {} };
  const instancePaths: Record<string, string[]> = {};
  const expand = (definition: CircuitDefinition, prefix: string[]): Record<string, Endpoint> => {
    if (prefix.length > 32) fail('hierarchy_limit', definition.name, 'Maximum module depth is 32.');
    const aliases = new Map<string, Record<string, Endpoint>>();
    for (const primitive of definition.primitives) {
      if (circuit.instances.length >= 10000)
        fail('hierarchy_limit', definition.name, 'Maximum expanded primitive count is 10000.');
      const segments = [...prefix, primitive.name],
        name = instanceName(segments);
      circuit.instances.push({ ...structuredClone(primitive), name });
      instancePaths[name] = segments;
      aliases.set(
        primitive.name,
        Object.fromEntries(primitive.ports.map((p) => [p.name, { instance: name, port: p.name }])),
      );
    }
    for (const module of definition.modules)
      aliases.set(
        module.name,
        expand(definitions.get(module.definition)!, [...prefix, module.name]),
      );
    const resolve = (endpoint: Endpoint) => aliases.get(endpoint.instance)![endpoint.port];
    circuit.connections.push(
      ...definition.connections.map((e) => ({ a: resolve(e.a), b: resolve(e.b) })),
    );
    return Object.fromEntries(
      Object.entries(definition.ports).map(([name, endpoint]) => [name, resolve(endpoint)]),
    );
  };
  circuit.ports = expand(definitions.get(hierarchy.top)!, []);
  const ports = new Map(
    circuit.instances.flatMap((i) => i.ports.map((p) => [`${i.name},${p.name}`, p] as const)),
  );
  const graph = new Map(circuit.instances.map((i) => [i.name, new Set<string>()]));
  for (const edge of circuit.connections) {
    const a = ports.get(`${edge.a.instance},${edge.a.port}`)!;
    const b = ports.get(`${edge.b.instance},${edge.b.port}`)!;
    if (a.domain !== b.domain || (a.direction === b.direction && a.direction !== 'bidirectional'))
      fail('incompatible_ports', hierarchy.top, 'Connected port domains or directions disagree.');
    if (edge.a.instance === edge.b.instance && edge.a.port === edge.b.port)
      fail('self_connection', hierarchy.top, 'An endpoint cannot connect to itself.');
    graph.get(edge.a.instance)!.add(edge.b.instance);
    graph.get(edge.b.instance)!.add(edge.a.instance);
  }
  const seen = new Set<string>(),
    pending = [circuit.instances[0].name];
  while (pending.length) {
    const name = pending.pop()!;
    if (!seen.has(name)) {
      seen.add(name);
      pending.push(...graph.get(name)!);
    }
  }
  if (seen.size !== circuit.instances.length)
    fail(
      'disconnected_circuit',
      hierarchy.top,
      'The expanded circuit must form one connected graph.',
    );
  return FlattenedCircuitSchema.parse({
    schema_version: '1.0',
    top: hierarchy.top,
    circuit,
    instance_paths: instancePaths,
  });
}
