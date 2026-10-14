import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Contracts } from './contracts.js';
import { compile, validateIR, SemanticError } from './compiler.js';
import { flattenCircuit, HierarchyError } from './hierarchy.js';
import { capabilities } from './backends.js';
import { PhysicsRuntime } from './physics/runtime.js';
import { capabilityRegistry } from './physics/registry.js';
import { Runtime } from './runtime.js';
import { simulateCircuit } from './verification.js';
export function openAPI() {
  const bundle = z.toJSONSchema(z.strictObject(Contracts), { io: 'input' });
  const schemas = JSON.parse(
    JSON.stringify(bundle.$defs).replaceAll('#/$defs/', '#/components/schemas/'),
  );
  const response = (name: string) => ({
    '200': {
      description: 'Structured result; inspect engineering status',
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } },
    },
    '422': { description: 'Invalid structure or engineering semantics' },
  });
  const post = (input: string, output: string, description: string) => ({
    post: {
      description,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${input}` } } },
      },
      responses: response(output),
    },
  });
  const id = { name: 'run_id', in: 'path', required: true, schema: { type: 'string' } };
  return {
    openapi: '3.1.0',
    info: { title: 'AgentPIC TypeScript Core', version: '0.2.0' },
    paths: {
      '/v1/circuits/flatten': post(
        'CircuitHierarchy',
        'FlattenedCircuit',
        'Validate and flatten module hierarchy with traceable primitive paths',
      ),
      '/v1/physics/capabilities': { get: { responses: response('CapabilityRegistry') } },
      '/v1/physics/runs/{run_id}': {
        get: { parameters: [id], responses: response('PhysicsReport') },
      },
      '/v1/physics/runs/{run_id}/artifacts/{name}': {
        get: {
          parameters: [
            id,
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Versioned JSON experiment artifact' },
            '404': { description: 'Unknown artifact' },
          },
        },
      },
      '/v1/physics/workflows': post(
        'EngineeringGoal',
        'PhysicsReport',
        'Execute an evidence-driven physics investigation',
      ),
      '/v1/compile': post(
        'DesignSpec',
        'EngineeringIR',
        'Compile MZI intent to validated Engineering IR',
      ),
      '/v1/validate': post(
        'EngineeringIR',
        'EngineeringIR',
        'Validate structure, ports, connections and topology',
      ),
      '/v1/simulations': {
        post: {
          description: 'Circuit-only SAX simulation and numerical verification',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/EngineeringIR' } },
            },
          },
          responses: {
            '200': {
              description: 'IR, simulation, verification',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ir', 'simulation', 'verification'],
                    properties: {
                      ir: { $ref: '#/components/schemas/EngineeringIR' },
                      simulation: { $ref: '#/components/schemas/SimulationResult' },
                      verification: { $ref: '#/components/schemas/VerificationReport' },
                    },
                  },
                },
              },
            },
            '422': { description: 'Invalid IR' },
          },
        },
      },
      '/v1/designs': post('DesignSpec', 'RunResult', 'Execute layout, simulation and verification'),
      '/v1/capabilities': { get: { responses: { '200': { description: 'Capability registry' } } } },
      '/v1/runs/{run_id}': { get: { parameters: [id], responses: response('RunResult') } },
      '/v1/runs/{run_id}/verify': {
        post: { parameters: [id], responses: response('VerificationReport') },
      },
      '/v1/runs/{run_id}/artifacts/{name}': {
        get: {
          parameters: [
            id,
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Binary or text artifact' },
            '404': { description: 'Unknown artifact' },
          },
        },
      },
    },
    components: { schemas },
  };
}
export function createAPI(runtime = new Runtime()) {
  const physics = new PhysicsRuntime(runtime.runsDir);
  return createServer(async (req, res) => {
    const json = (code: number, data: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/v1/capabilities')
        return json(200, capabilities());
      if (req.method === 'GET' && url.pathname === '/v1/physics/capabilities')
        return json(200, { capabilities: capabilityRegistry() });
      if (req.method === 'GET' && url.pathname === '/openapi.json') return json(200, openAPI());
      if (
        req.method === 'POST' &&
        [
          '/v1/compile',
          '/v1/circuits/flatten',
          '/v1/validate',
          '/v1/designs',
          '/v1/simulations',
          '/v1/physics/workflows',
        ].includes(url.pathname)
      ) {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1024 * 1024) return json(413, { error: 'Request exceeds 1 MiB' });
        }
        const value = JSON.parse(body);
        if (url.pathname === '/v1/circuits/flatten') return json(200, flattenCircuit(value));
        if (url.pathname === '/v1/physics/workflows') return json(200, await physics.run(value));
        if (url.pathname === '/v1/compile') return json(200, compile(value));
        if (url.pathname === '/v1/validate') return json(200, validateIR(value));
        if (url.pathname === '/v1/simulations')
          return json(200, await simulateCircuit(value, runtime.backend));
        return json(200, await runtime.run(value));
      }
      const physical = /^\/v1\/physics\/runs\/([^/]+)(?:\/artifacts\/([^/]+))?$/.exec(url.pathname);
      if (physical && req.method === 'GET') {
        try {
          if (physical[2]) {
            const file = await physics.artifactPath(physical[1], decodeURIComponent(physical[2]));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(await readFile(file));
            return;
          }
          return json(200, await physics.getReport(physical[1]));
        } catch {
          return json(404, { error: 'Unknown physics run or artifact' });
        }
      }
      const match = /^\/v1\/runs\/([^/]+)(?:\/(verify|artifacts)(?:\/([^/]+))?)?$/.exec(
        url.pathname,
      );
      if (match) {
        const [, id, operation, name] = match;
        try {
          if (req.method === 'GET' && !operation) return json(200, await runtime.getRun(id));
          if (req.method === 'POST' && operation === 'verify')
            return json(200, await runtime.verifyRun(id));
          if (req.method === 'GET' && operation === 'artifacts' && name) {
            const file = await runtime.artifactPath(id, decodeURIComponent(name));
            res.writeHead(200, {
              'Content-Type': name.endsWith('.json')
                ? 'application/json'
                : 'application/octet-stream',
            });
            res.end(await readFile(file));
            return;
          }
        } catch {
          return json(404, { error: 'Unknown run or artifact' });
        }
      }
      json(404, { error: 'Unknown endpoint' });
    } catch (error) {
      json(
        error instanceof z.ZodError ||
          error instanceof HierarchyError ||
          error instanceof SemanticError ||
          error instanceof SyntaxError
          ? 422
          : 500,
        {
          error: String(error),
          ...(error instanceof HierarchyError
            ? { code: error.code, location: error.location }
            : {}),
          ...(error instanceof SemanticError ? { checks: error.checks } : {}),
        },
      );
    }
  });
}
