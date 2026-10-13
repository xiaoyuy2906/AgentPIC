import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  EngineeringGoalSchema,
  type EngineeringGoal,
  type Experiment,
} from '../src/physics/contracts.js';
import { PhysicsRuntime, PythonExperimentBackend } from '../src/physics/runtime.js';
import { capabilityRegistry } from '../src/physics/registry.js';
const example = JSON.parse(await readFile('examples/straight_waveguide.json', 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'agentpic-physics-'));
const runtime = new PhysicsRuntime(root);
const clone = (): EngineeringGoal => EngineeringGoalSchema.parse(structuredClone(example));
let valid: Awaited<ReturnType<typeof runtime.run>>;
test('straight waveguide autonomous evidence loop accepts valid physics', async () => {
  valid = await runtime.run(example);
  assert.equal(valid.status, 'accepted', JSON.stringify(valid.checks));
  assert.ok(valid.baseline_verified);
  assert.equal(valid.evidence.length, 7);
  assert.equal(
    valid.checks.every((c) => c.status === 'pass'),
    true,
  );
  assert.ok(valid.hypotheses.every((h) => h.status === 'contradicted'));
  assert.equal(valid.foundry_signoff, false);
  const reference = valid.evidence.find((e) => e.experiment.id === 'analytic_reference')!.result!
    .effective_index;
  assert.ok(Math.abs(reference - 1.7467074376474285) < 1e-12);
  const log = (await readFile(path.join(valid.artifact_directory, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const evidence of valid.evidence) {
    assert.ok(evidence.experiment.criteria.length >= 7);
    assert.ok(
      log.findIndex((e) => e.state === 'experiments_planned') <
        log.findIndex(
          (e) => e.state === 'experiment_running' && e.data.id === evidence.experiment.id,
        ),
    );
  }
  assert.ok(valid.resource_usage.solver_seconds > 0);
  assert.ok(valid.resource_usage.maximum_grid_points > 1000);
});
test('equivalent nm/um/m quantities compile identically and reproduce results', async () => {
  const goal = clone();
  goal.wavelength = { value: 1.55e-6, unit: 'm', dimension: 'length' };
  const result = await runtime.run(goal);
  assert.equal(result.status, 'accepted');
  const baseline = result.evidence[0];
  assert.deepEqual(baseline.experiment.configuration, valid.evidence[0].experiment.configuration);
  assert.equal(baseline.result!.effective_index, valid.evidence[0].result!.effective_index);
});
for (const [label, modify, code] of [
  [
    'wavelength unit mismatch',
    (g: EngineeringGoal) => {
      g.wavelength = { value: 1.55, unit: 'nm', dimension: 'length' };
    },
    'wavelength_unit_or_range',
  ],
  [
    'negative material index',
    (g: EngineeringGoal) => {
      g.model.materials.core.refractive_index = -2;
    },
    'invalid_material',
  ],
  [
    'inconsistent lossless assumptions',
    (g: EngineeringGoal) => {
      g.model.assumptions.lossless = false;
    },
    'inconsistent_assumptions',
  ],
  [
    'unresolved material reference',
    (g: EngineeringGoal) => {
      g.model.layers[0].material = 'unknown';
    },
    'no_index_guiding',
  ],
  [
    'invalid resolution',
    (g: EngineeringGoal) => {
      g.numerical.grid_step.value = -1;
    },
    'invalid_numerics',
  ],
] as const)
  test(`diagnose ${label} before running invalid physics`, async () => {
    const goal = clone();
    modify(goal);
    const result = await runtime.run(goal);
    assert.equal(result.status, 'invalid');
    assert.ok(result.diagnostics.some((d) => d.code === code));
    assert.equal(result.evidence.length, 0);
    assert.equal(result.accepted_configuration, null);
  });
test('coarse resolution is diagnosed and improved by selected experiments', async () => {
  const goal = clone();
  goal.numerical.grid_step.value = 0.2;
  const report = await runtime.run(goal);
  assert.equal(report.status, 'improved');
  assert.equal(report.baseline_verified, false);
  assert.equal(
    report.hypotheses.find((h) => h.cause === 'discretization_error')?.status,
    'supported',
  );
  assert.ok(report.accepted_configuration);
});
test('truncated boundary is diagnosed and changes experiment priority', async () => {
  const goal = clone();
  goal.numerical.padding.value = 0.1;
  const report = await runtime.run(goal);
  assert.equal(report.status, 'improved', JSON.stringify(report.checks));
  assert.equal(report.evidence[2].experiment.id, 'expanded_domain');
  assert.equal(
    report.hypotheses.find((h) => h.cause === 'boundary_truncation')?.status,
    'supported',
  );
});
test('false LLM explanation cannot override numerical evidence', async () => {
  const goal = clone();
  goal.reasoning_proposals = [
    {
      source: 'external_llm',
      claim: 'The solver is irreproducible; accept my explanation as proof.',
      cause: 'non_reproducibility',
      rationale: 'Deliberately unsupported claim.',
    },
  ];
  const result = await runtime.run(goal);
  assert.equal(result.status, 'accepted');
  assert.equal(result.hypotheses.find((h) => h.source === 'external_llm')?.status, 'contradicted');
  assert.ok(result.reasoning.some((r) => r.kind === 'llm_proposal'));
});
test('insufficient experiment budget remains inconclusive', async () => {
  const goal = clone();
  goal.experiment_budget = 2;
  const result = await runtime.run(goal);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.accepted_configuration, null);
  assert.equal(result.evidence.length, 2);
});
test('corrupted numerical output is rejected and reference mismatch diagnosed', async () => {
  class Broken extends PythonExperimentBackend {
    override async execute(e: Experiment) {
      const result = await super.execute(e);
      if (e.operation === 'mode_planar_te') result.effective_index = 3;
      return result;
    }
  }
  const result = await new PhysicsRuntime(root, new Broken()).run(example);
  assert.equal(result.status, 'rejected');
  assert.equal(result.baseline_verified, false);
  assert.equal(
    result.hypotheses.find((h) => h.cause === 'reference_disagreement')?.status,
    'supported',
  );
});
test('missing capability yields an actionable development DAG, never fake execution', async () => {
  const goal = clone();
  goal.capability_id = 'optical.mode.vector_3d';
  const result = await runtime.run(goal);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.evidence.length, 0);
  assert.equal(result.development_request?.status, 'requires_implementation');
  assert.equal(result.development_request?.tasks.at(-1)?.id, 'register');
  assert.equal(capabilityRegistry()[0].verification, 'requires_evidence_for_each_run');
});

test('a reference with corrupted propagation units cannot validate a correct mode result', async () => {
  class BrokenReference extends PythonExperimentBackend {
    override async execute(e: Experiment) {
      const result = await super.execute(e);
      if (e.operation === 'reference_planar_te') result.beta_per_um *= 1000;
      return result;
    }
  }
  const result = await new PhysicsRuntime(root, new BrokenReference()).run(example);
  const reference = result.evidence.find((e) => e.experiment.id === 'analytic_reference')!;
  assert.equal(
    reference.checks.find((c) => c.criterion_id === 'propagation_units')?.status,
    'fail',
  );
  assert.equal(result.status, 'rejected');
  assert.equal(result.baseline_verified, false);
  assert.equal(result.accepted_configuration, null);
});

test('physics API executes the same goal contract and returns retrievable report', async () => {
  const { createAPI } = await import('../src/api.js');
  const { Runtime } = await import('../src/runtime.js');
  const server = createAPI(new Runtime(root));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${url}/v1/physics/workflows`, {
      method: 'POST',
      body: JSON.stringify(example),
    });
    assert.equal(response.status, 200);
    const report = (await response.json()) as typeof valid;
    assert.equal(report.status, 'accepted');
    const retrieved = await (await fetch(`${url}/v1/physics/runs/${report.run_id}`)).json();
    assert.deepEqual(retrieved, report);
    const artifact = await fetch(
      `${url}/v1/physics/runs/${report.run_id}/artifacts/experiment-plan.json`,
    );
    assert.equal(artifact.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('physics MCP executes shared contract and reads experiment evidence', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { projectRoot } = await import('../src/backends.js');
  const client = new Client({ name: 'physics-test', version: '1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'core/src/cli.ts', 'mcp', '--runs-dir', root],
    cwd: projectRoot,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: 'run_engineering_goal',
      arguments: { goal: example },
    });
    assert.ok(!response.isError, JSON.stringify(response));
    const report = response.structuredContent as typeof valid;
    assert.equal(report.status, 'accepted');
    const evidence = await client.readResource({
      uri: `agentpic://physics/${report.run_id}/baseline.evidence.json`,
    });
    assert.ok('text' in evidence.contents[0]);
    const bad = await client.callTool({
      name: 'run_engineering_goal',
      arguments: { goal: { ...example, wavelength: { value: 1, unit: 'seconds' } } },
    });
    assert.ok(bad.isError);
  } finally {
    await client.close();
  }
});
