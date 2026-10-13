import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import {
  DesignSpecSchema,
  EngineeringIRSchema,
  RunResultSchema,
  VerificationReportSchema,
  CircuitSimulationSchema,
} from './contracts.js';
import { compile, validateIR } from './compiler.js';
import { PhysicsRuntime } from './physics/runtime.js';
import { capabilityRegistry } from './physics/registry.js';
import {
  CapabilityRegistrySchema,
  EngineeringGoalSchema,
  PhysicsReportSchema,
} from './physics/contracts.js';
import { Runtime } from './runtime.js';
import { simulateCircuit } from './verification.js';
import { capabilities } from './backends.js';
const structured = (value: object) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});
export function createMCP(runtime = new Runtime()) {
  const server = new McpServer(
    { name: 'AgentPIC', version: '0.2.0' },
    {
      instructions:
        'TypeScript engineering core; Python scientific backends. Always inspect verification and not_run checks. No foundry signoff.',
    },
  );
  server.registerTool(
    'get_capabilities',
    { description: 'Discover supported devices and backends.' },
    async () => structured(capabilities()),
  );
  server.registerTool(
    'get_design_schema',
    { description: 'Read the Zod-generated input JSON Schema.' },
    async () => structured(z.toJSONSchema(DesignSpecSchema, { io: 'input' })),
  );
  server.registerTool(
    'compile_pic',
    {
      description: 'Compile intent to typed, semantically valid engineering JSON.',
      inputSchema: { specification: DesignSpecSchema },
      outputSchema: EngineeringIRSchema.shape,
    },
    async ({ specification }) => structured(compile(specification)),
  );
  server.registerTool(
    'validate_circuit',
    {
      description: 'Check IR structure, port references, compatibility and topology.',
      inputSchema: { ir: EngineeringIRSchema },
      outputSchema: EngineeringIRSchema.shape,
    },
    async ({ ir }) => structured(validateIR(ir)),
  );
  server.registerTool(
    'simulate_circuit',
    {
      description: 'Run circuit-only SAX simulation from standard Engineering IR.',
      inputSchema: { ir: EngineeringIRSchema },
      outputSchema: CircuitSimulationSchema.shape,
    },
    async ({ ir }) => structured(await simulateCircuit(ir, runtime.backend)),
  );
  server.registerTool(
    'design_pic',
    {
      description: 'Run complete layout, SAX and verification workflow.',
      inputSchema: { specification: DesignSpecSchema },
      outputSchema: RunResultSchema.shape,
    },
    async ({ specification }) => structured(await runtime.run(specification)),
  );
  server.registerTool(
    'get_run',
    {
      description: 'Retrieve persisted run status and artifact inventory.',
      inputSchema: { run_id: z.string() },
      outputSchema: RunResultSchema.shape,
    },
    async ({ run_id }) => structured(await runtime.getRun(run_id)),
  );
  server.registerTool(
    'verify_run',
    {
      description: 'Reverify serialized artifacts, geometry and integrity.',
      inputSchema: { run_id: z.string() },
      outputSchema: VerificationReportSchema.shape,
    },
    async ({ run_id }) => structured(await runtime.verifyRun(run_id)),
  );
  const physics = new PhysicsRuntime(runtime.runsDir);
  server.registerTool(
    'run_engineering_goal',
    {
      description:
        'Run a physics reasoning and verification loop with predeclared criteria, experiments and evidence.',
      inputSchema: { goal: EngineeringGoalSchema },
      outputSchema: PhysicsReportSchema.shape,
    },
    async ({ goal }) => structured(await physics.run(goal)),
  );
  server.registerTool(
    'get_engineering_capabilities',
    {
      description:
        'Discover implemented experiment policies; verification requires reproducible run evidence.',
      outputSchema: CapabilityRegistrySchema.shape,
    },
    async () => structured({ capabilities: capabilityRegistry() }),
  );
  server.registerTool(
    'get_physics_run',
    {
      description: 'Retrieve a persisted engineering verification report.',
      inputSchema: { run_id: z.string() },
      outputSchema: PhysicsReportSchema.shape,
    },
    async ({ run_id }) => structured(await physics.getReport(run_id)),
  );
  server.registerResource(
    'physics_artifact',
    new ResourceTemplate('agentpic://physics/{run_id}/{name}', { list: undefined }),
    {
      description:
        'Read versioned experiment plans, numerical evidence, reports and reproducibility manifests.',
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: await readFile(
            await physics.artifactPath(String(variables.run_id), String(variables.name)),
            'utf8',
          ),
        },
      ],
    }),
  );
  server.registerResource(
    'artifact',
    new ResourceTemplate('agentpic://runs/{run_id}/{name}', { list: undefined }),
    { description: 'Read a known artifact; binary files are base64 encoded.' },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/octet-stream',
          blob: (
            await readFile(
              await runtime.artifactPath(String(variables.run_id), String(variables.name)),
            )
          ).toString('base64'),
        },
      ],
    }),
  );
  return server;
}
export async function serveMCP(runtime = new Runtime()) {
  await createMCP(runtime).connect(new StdioServerTransport());
}
