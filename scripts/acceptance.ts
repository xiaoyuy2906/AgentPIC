/** Execute real HTTP and MCP transports against the TypeScript engineering core. */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAPI } from '../core/src/api.js';
import { Runtime, writeJSON } from '../core/src/runtime.js';
import { projectRoot } from '../core/src/backends.js';
import type { RunResult, VerificationReport } from '../core/src/contracts.js';
import { genericBenchmark } from './generic-benchmark.js';
const index = process.argv.indexOf('--output');
const output = path.resolve(index < 0 ? 'runs/acceptance' : process.argv[index + 1]);
const specIndex = process.argv.indexOf('--specification');
await mkdir(output, { recursive: true });
const specification = JSON.parse(
  await readFile(
    specIndex < 0
      ? path.join(projectRoot, 'designs/mzi.json')
      : path.resolve(process.argv[specIndex + 1]),
    'utf8',
  ),
);
await writeJSON(path.join(output, 'request.json'), specification);
const physical = specification.layout != null;
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
  const gdsResponse = await fetch(`${url}/v1/runs/${httpRun.run_id}/artifacts/design.gds`);
  if (!physical)
    expect(gdsResponse.status === 404, 'A design without layout must not expose a GDS');
  else {
    const gds = Buffer.from(await gdsResponse.arrayBuffer());
    expect(
      gds.equals(await readFile(path.join(httpRun.artifact_directory, 'design.gds'))),
      'HTTP binary GDS mismatch',
    );
  }
  expect(
    (
      await fetch(`${url}/v1/compile`, {
        method: 'POST',
        body: JSON.stringify({ ...specification, sweep_points: 4 }),
      })
    ).status === 422,
    'HTTP must reject an even sample count',
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
  const compiled = await client.callTool({ name: 'compile_pic', arguments: { specification } });
  expect(!compiled.isError, 'MCP compilation failed');
  const simulated = await client.callTool({
    name: 'simulate_circuit',
    arguments: { ir: compiled.structuredContent },
  });
  expect(
    !simulated.isError &&
      (simulated.structuredContent as { verification: VerificationReport }).verification.status ===
        'passed_with_limitations',
    'MCP circuit-only simulation failed',
  );
  await writeJSON(path.join(output, 'mcp-circuit-only.json'), simulated.structuredContent);
  const invalid = structuredClone(specification);
  invalid.port_order.push(invalid.port_order[0]);
  expect(
    (await client.callTool({ name: 'compile_pic', arguments: { specification: invalid } })).isError,
    'MCP must reject a duplicate port order',
  );
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
  const artifact = physical ? 'design.gds' : 'simulation.json';
  if (!physical) {
    expect(
      !mcpRun.artifacts.some((a) => a.name.endsWith('.gds') || a.name === 'layout.json'),
      'A design without layout must not publish physical artifacts',
    );
    expect(
      (report.structuredContent as VerificationReport).checks.some(
        (c) => c.id === 'layout_generation' && c.status === 'not_run',
      ),
      'Layout must explicitly be not_run',
    );
  }
  const resource = await client.readResource({
    uri: `agentpic://runs/${mcpRun.run_id}/${artifact}`,
  });
  expect(
    'blob' in resource.contents[0] &&
      Buffer.from(resource.contents[0].blob, 'base64').equals(
        await readFile(path.join(mcpRun.artifact_directory, artifact)),
      ),
    `MCP ${artifact} mismatch`,
  );
  await writeJSON(path.join(output, 'mcp-response.json'), mcpRun);
  await writeJSON(path.join(output, 'mcp-verification.json'), report.structuredContent);
} finally {
  await client.close();
}
const core = [
  'specification.json',
  'compiled_ir.json',
  'engineering_ir.json',
  'netlist.json',
  'simulation.json',
  'spectrum.csv',
  'verification.json',
  ...(physical ? ['design.gds', 'layout.json'] : []),
];
for (const optional of [
  'hierarchy.json',
  'instance-paths.json',
  'controls.json',
  'tuning.json',
  'pre-tuning-ir.json',
])
  if (httpRun!.artifacts.some((a) => a.name === optional)) core.push(optional);
for (const name of core)
  expect(
    httpRun!.artifacts.some((a) => a.name === name) &&
      httpRun!.artifacts.find((a) => a.name === name)?.sha256 ===
        mcpRun!.artifacts.find((a) => a.name === name)?.sha256,
    `Transport artifact differs: ${name}`,
  );
const simulation = JSON.parse(
  await readFile(path.join(httpRun!.artifact_directory, 'simulation.json'), 'utf8'),
);
const layout = physical
  ? JSON.parse(await readFile(path.join(httpRun!.artifact_directory, 'layout.json'), 'utf8'))
  : null;
const benchmark = genericBenchmark(specification, simulation);
if (benchmark) await writeJSON(path.join(output, 'independent-reference.json'), benchmark);
const counts: Record<string, number> = {};
for (const check of httpReport!.checks) counts[check.status] = (counts[check.status] ?? 0) + 1;
const middle = Math.floor(simulation.wavelength_nm.length / 2);
const summary = {
  design: specification.name,
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
  center_wavelength_nm: simulation.wavelength_nm[middle],
  ports: simulation.ports,
  // Row = output port, column = input port, |S|² at the centre wavelength.
  center_power: (simulation.s_real[middle] as number[][]).map((row, i) =>
    row.map((re, j) => re ** 2 + simulation.s_imag[middle][i][j] ** 2),
  ),
  independent_reference: benchmark,
  layout: physical ? 'executed' : 'not_run',
  lengths_um: layout?.lengths_um ?? null,
  foundry_signoff: false,
};
await writeJSON(path.join(output, 'acceptance.json'), summary);
console.log(JSON.stringify(summary, null, 2));
