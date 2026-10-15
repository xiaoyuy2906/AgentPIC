/** Execute real HTTP and MCP transports against the TypeScript engineering core. */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAPI } from '../core/src/api.js';
import { Runtime, writeJSON } from '../core/src/runtime.js';
import { projectRoot } from '../core/src/backends.js';
import type { RunResult, VerificationReport } from '../core/src/contracts.js';
const index = process.argv.indexOf('--output');
const output = path.resolve(index < 0 ? 'runs/acceptance' : process.argv[index + 1]);
const specIndex = process.argv.indexOf('--specification');
await mkdir(output, { recursive: true });
const specification = JSON.parse(
  await readFile(
    specIndex < 0
      ? path.join(projectRoot, 'examples/mzi_1550.json')
      : path.resolve(process.argv[specIndex + 1]),
    'utf8',
  ),
);
await writeJSON(path.join(output, 'request.json'), specification);
const runtime = new Runtime(path.join(output, 'runs'));
const server = createAPI(runtime);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
let httpRun: RunResult, httpReport: VerificationReport;
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const expect = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
try {
  const response = await fetch(`${url}/v1/designs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(specification),
  });
  expect(response.ok, 'HTTP design request failed');
  httpRun = (await response.json()) as RunResult;
  expect(httpRun.status === 'completed', JSON.stringify(httpRun));
  httpReport = (await (
    await fetch(`${url}/v1/runs/${httpRun.run_id}/verify`, { method: 'POST' })
  ).json()) as VerificationReport;
  expect(httpReport.status === 'passed_with_limitations', 'HTTP reverification failed');
  const gds = Buffer.from(
    await (await fetch(`${url}/v1/runs/${httpRun.run_id}/artifacts/design.gds`)).arrayBuffer(),
  );
  expect(
    gds.equals(await readFile(path.join(httpRun.artifact_directory, 'design.gds'))),
    'HTTP binary GDS mismatch',
  );
  await writeJSON(path.join(output, 'http-response.json'), httpRun);
  await writeJSON(path.join(output, 'http-verification.json'), httpReport);
  const ir = await (
    await fetch(`${url}/v1/compile`, { method: 'POST', body: JSON.stringify(specification) })
  ).json();
  const simulation = (await (
    await fetch(`${url}/v1/simulations`, { method: 'POST', body: JSON.stringify(ir) })
  ).json()) as { verification: VerificationReport };
  expect(
    simulation.verification.status === 'passed_with_limitations',
    'Circuit-only SAX acceptance failed',
  );
  await writeJSON(path.join(output, 'circuit-only.json'), simulation);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
const client = new Client({ name: 'AgentPIC acceptance', version: '0.2.0' });
const transport = new StdioClientTransport({
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  command: process.execPath,
  args: ['--import', 'tsx', 'core/src/cli.ts', 'mcp', '--runs-dir', runtime.runsDir],
  cwd: projectRoot,
  stderr: 'pipe',
});
let mcpRun: RunResult, toolNames: string[];
try {
  await client.connect(transport);
  toolNames = (await client.listTools()).tools.map((t) => t.name);
  const response = await client.callTool({ name: 'design_pic', arguments: { specification } });
  expect(!response.isError, 'MCP design failed');
  mcpRun = response.structuredContent as RunResult;
  expect(mcpRun.status === 'completed', JSON.stringify(mcpRun));
  const report = await client.callTool({
    name: 'verify_run',
    arguments: { run_id: mcpRun.run_id },
  });
  expect(
    (report.structuredContent as VerificationReport)?.status === 'passed_with_limitations',
    'MCP reverification failed',
  );
  const resource = await client.readResource({
    uri: `agentpic://runs/${mcpRun.run_id}/design.gds`,
  });
  expect('blob' in resource.contents[0], 'MCP did not return binary artifact');
  if ('blob' in resource.contents[0])
    expect(
      Buffer.from(resource.contents[0].blob, 'base64').equals(
        await readFile(path.join(mcpRun.artifact_directory, 'design.gds')),
      ),
      'MCP binary GDS mismatch',
    );
  await writeJSON(path.join(output, 'mcp-response.json'), mcpRun);
  await writeJSON(path.join(output, 'mcp-verification.json'), report.structuredContent);
} finally {
  await client.close();
}
const core = [
  'engineering_ir.json',
  'design.gds',
  'layout.json',
  'netlist.json',
  'simulation.json',
];
if (httpRun!.artifacts.some((a) => a.name === 'hierarchy.json'))
  core.push('hierarchy.json', 'instance-paths.json', 'assembly.json');
if (httpRun!.artifacts.some((a) => a.name === 'controls.json')) core.push('controls.json');
for (const name of core)
  expect(
    httpRun!.artifacts.find((a) => a.name === name)?.sha256 ===
      mcpRun!.artifacts.find((a) => a.name === name)?.sha256,
    `Transport artifact differs: ${name}`,
  );
const simulation = JSON.parse(
  await readFile(path.join(httpRun!.artifact_directory, 'simulation.json'), 'utf8'),
);
const layout = JSON.parse(
  await readFile(path.join(httpRun!.artifact_directory, 'layout.json'), 'utf8'),
);
const counts: Record<string, number> = {};
for (const check of httpReport!.checks) counts[check.status] = (counts[check.status] ?? 0) + 1;
const summary = {
  device: specification.device ?? 'mzi',
  status: 'passed_with_limitations',
  core: 'typescript',
  contract: 'Zod → JSON Schema → generated Pydantic',
  http_run_id: httpRun!.run_id,
  mcp_run_id: mcpRun!.run_id,
  http_artifact_directory: httpRun!.artifact_directory,
  design_id: httpRun!.design_id,
  mcp_tools: toolNames!,
  verification_counts: counts,
  transport_artifacts_identical: core,
  center_wavelength_nm: simulation.wavelength_nm[Math.floor(simulation.wavelength_nm.length / 2)],
  center_transmission: {
    out0: simulation.transmission_out0[Math.floor(simulation.wavelength_nm.length / 2)],
    out1: simulation.transmission_out1[Math.floor(simulation.wavelength_nm.length / 2)],
  },
  lengths_um: layout.lengths_um,
  foundry_signoff: false,
};
await writeJSON(path.join(output, 'acceptance.json'), summary);
console.log(JSON.stringify(summary, null, 2));
