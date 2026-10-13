import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compile, canonical } from '../src/compiler.js';
import { Runtime } from '../src/runtime.js';
import { PythonBackend, projectRoot, pythonRequest } from '../src/backends.js';
import { verifyArtifacts, simulateCircuit, readJSON } from '../src/verification.js';
import { createAPI } from '../src/api.js';
import type { RunResult } from '../src/contracts.js';
const spec = {
  device: 'mzi',
  platform: 'sin',
  wavelength_nm: 1550,
  outputs: ['netlist', 'simulation', 'gds', 'verification'],
};
const root = await mkdtemp(path.join(tmpdir(), 'agentpic-ts-'));
const runtime = new Runtime(root);
let run: RunResult;

test('MZI specification → TS IR → semantic validation → JSON → Python SAX → result', async () => {
  const ir = JSON.parse(canonical(compile(spec)));
  const result = await simulateCircuit(ir);
  assert.equal(result.verification.status, 'passed_with_limitations');
  assert.equal(result.ir.length_source, 'specification');
  const t = result.simulation.transmission_out0[100];
  assert.ok(Math.abs(t - Math.sin((Math.PI * 1.8 * 10) / 1.55) ** 2) < 1e-9);
  assert.ok(!('sax_netlist' in result.simulation));
});
test('reserved EM adapters do not claim execution', async () => {
  await assert.rejects(() => pythonRequest({ operation: 'fdtdx' }), /not implemented/);
});
test('scientific requests use the prepared environment without interpreter resolution or sync', async () => {
  const before = await pythonRequest({ operation: 'versions' });
  const previous = process.env.UV_PYTHON;
  process.env.UV_PYTHON = 'invalid-interpreter-selector';
  try {
    assert.deepEqual(await pythonRequest({ operation: 'versions' }), before);
  } finally {
    if (previous === undefined) delete process.env.UV_PYTHON;
    else process.env.UV_PYTHON = previous;
  }
});
test('full TS runtime creates real GDS and passes independent checks', async () => {
  run = await runtime.run(spec);
  assert.equal(run.status, 'completed', run.error ?? JSON.stringify(run));
  const report = await runtime.verifyRun(run.run_id);
  assert.equal(report.status, 'passed_with_limitations');
  assert.equal(report.checks.filter((c) => c.status === 'not_run').length, 3);
  assert.ok(report.checks.filter((c) => c.status === 'pass').length >= 27);
  const data = await readFile(await runtime.artifactPath(run.run_id, 'design.gds'));
  assert.equal(data.subarray(0, 4).toString('hex'), '00060002');
  const layout = (await readJSON(path.join(run.artifact_directory, 'layout.json'))) as {
    delta_length_um: number;
    extracted_circuit: unknown;
  };
  assert.ok(Math.abs(layout.delta_length_um - 10) < 0.002);
  assert.ok(layout.extracted_circuit);
  const provenance = (await readJSON(path.join(run.artifact_directory, 'provenance.json'))) as {
    core: string;
    schema_sha256: string;
  };
  assert.equal(provenance.core, 'typescript');
  assert.equal(provenance.schema_sha256.length, 64);
});
test('same input reproduces GDS and circuit JSON across isolated backend processes', async () => {
  const second = await runtime.run(spec);
  assert.equal(second.status, 'completed', JSON.stringify(second));
  for (const name of [
    'design.gds',
    'engineering_ir.json',
    'netlist.json',
    'layout.json',
    'simulation.json',
  ])
    assert.equal(
      run.artifacts.find((a) => a.name === name)?.sha256,
      second.artifacts.find((a) => a.name === name)?.sha256,
      name,
    );
});
test('backend failure persists and blocks downstream tasks', async () => {
  class Broken extends PythonBackend {
    override async simulate(): Promise<never> {
      throw new Error('injected failure');
    }
  }
  const failed = await new Runtime(root, new Broken()).run(spec);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /injected failure/);
  const workflow = (await readJSON(path.join(failed.artifact_directory, 'workflow.json'))) as {
    tasks: { name: string; state: string }[];
  };
  assert.equal(workflow.tasks.find((t) => t.name === 'verify')?.state, 'blocked');
});
test('corrupted simulation, topology, GDS and inventory cannot pass verification', async () => {
  for (const kind of ['simulation', 'topology', 'gds', 'missing']) {
    const dir = path.join(root, `corrupt-${kind}`);
    await cp(run.artifact_directory, dir, { recursive: true });
    if (kind === 'simulation') {
      const file = path.join(dir, 'simulation.json');
      const s = JSON.parse(await readFile(file, 'utf8'));
      s.s_real[100][2][0] += 0.2;
      await writeFile(file, JSON.stringify(s));
    }
    if (kind === 'topology') {
      const file = path.join(dir, 'layout.json');
      const l = JSON.parse(await readFile(file, 'utf8'));
      l.extracted_circuit.connections.pop();
      await writeFile(file, JSON.stringify(l));
    }
    if (kind === 'gds') await writeFile(path.join(dir, 'design.gds'), 'broken GDS');
    if (kind === 'missing') await unlink(path.join(dir, 'spectrum.csv'));
    const report = await verifyArtifacts(
      dir,
      runtime.backend,
      kind === 'missing' ? run.artifacts : undefined,
    );
    assert.equal(report.status, 'failed', kind);
  }
});
test('artifact traversal is rejected', async () => {
  await assert.rejects(() => runtime.artifactPath(run.run_id, '../../uv.lock'));
  await assert.rejects(() => runtime.getRun('../'));
});
test('real HTTP API reuses TS compiler and completes design', async () => {
  const server = createAPI(new Runtime(root));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${url}/v1/designs`, {
      method: 'POST',
      body: JSON.stringify(spec),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as RunResult;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const gds = await fetch(`${url}/v1/runs/${result.run_id}/artifacts/design.gds`);
    assert.equal(
      Buffer.from(await gds.arrayBuffer())
        .subarray(0, 4)
        .toString('hex'),
      '00060002',
    );
    const invalid = await fetch(`${url}/v1/compile`, {
      method: 'POST',
      body: JSON.stringify({ sweep_points: 4 }),
    });
    assert.equal(invalid.status, 422);
    const missing = await fetch(`${url}/v1/runs/unknown`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('real MCP stdio tools use TS contract and retrieve binary GDS', async () => {
  const client = new Client({ name: 'acceptance', version: '1.0' });
  const transport = new StdioClientTransport({
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    command: process.execPath,
    args: ['--import', 'tsx', 'core/src/cli.ts', 'mcp', '--runs-dir', root],
    cwd: projectRoot,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'validate_circuit'));
    assert.ok(tools.tools.find((t) => t.name === 'compile_pic')?.outputSchema);
    assert.ok(tools.tools.find((t) => t.name === 'design_pic')?.outputSchema);
    const compiled = await client.callTool({
      name: 'compile_pic',
      arguments: { specification: spec },
    });
    assert.equal(compiled.isError, undefined);
    assert.equal(canonical(compiled.structuredContent), canonical(compile(spec)));
    const response = await client.callTool({
      name: 'design_pic',
      arguments: { specification: spec },
    });
    assert.ok(!response.isError, JSON.stringify(response));
    const result = response.structuredContent as RunResult;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const resource = await client.readResource({
      uri: `agentpic://runs/${result.run_id}/design.gds`,
    });
    assert.ok('blob' in resource.contents[0]);
    assert.equal(
      Buffer.from(String(resource.contents[0].blob), 'base64').subarray(0, 4).toString('hex'),
      '00060002',
    );
    const invalid = await client.callTool({
      name: 'compile_pic',
      arguments: { specification: { sweep_points: 4 } },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});
