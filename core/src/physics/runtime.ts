import { mkdir, appendFile, readFile, readdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sha256, canonical } from '../compiler.js';
import { writeJSON, provenance } from '../runtime.js';
import { PythonBackend, pythonRequest } from '../backends.js';
import {
  EngineeringGoalSchema,
  PhysicalResultSchema,
  PhysicsReportSchema,
  type PhysicsReport,
  type PhysicalResult,
  type Experiment,
  type Evidence,
} from './contracts.js';
import { physicsCapabilities, developmentRequest } from './registry.js';
export interface ExperimentBackend {
  execute(experiment: Experiment): Promise<PhysicalResult>;
}
export class PythonExperimentBackend implements ExperimentBackend {
  async execute(e: Experiment) {
    return PhysicalResultSchema.parse(
      await pythonRequest({ operation: e.operation, configuration: e.configuration }),
    );
  }
}
/** Generic evidence workflow. Device-specific policies are registered plugins. */
export class PhysicsRuntime {
  constructor(
    readonly runsDir = process.env.AGENTPIC_RUNS_DIR ?? 'runs',
    readonly backend: ExperimentBackend = new PythonExperimentBackend(),
  ) {}
  async directory(id: string) {
    if (!/^physics-[0-9a-f]{16}-[0-9a-f]{12}$/.test(id)) throw new Error('Unknown physics run');
    const directory = path.resolve(this.runsDir, id);
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Unknown physics run');
    return directory;
  }
  async getReport(id: string) {
    return PhysicsReportSchema.parse(
      JSON.parse(
        await readFile(path.join(await this.directory(id), 'physics-report.json'), 'utf8'),
      ),
    );
  }
  async artifactPath(id: string, name: string) {
    const directory = await this.directory(id);
    const manifest = JSON.parse(
      await readFile(path.join(directory, 'artifact-manifest.json'), 'utf8'),
    ) as { artifacts: { name: string }[] };
    const allowed = new Set(manifest.artifacts.map((a) => a.name));
    allowed.add('artifact-manifest.json');
    const file = path.join(directory, name);
    if (
      !allowed.has(name) ||
      path.basename(name) !== name ||
      path.dirname(await realpath(file)) !== (await realpath(directory))
    )
      throw new Error('Unknown physics artifact');
    return file;
  }
  async run(input: unknown): Promise<PhysicsReport> {
    const start = performance.now();
    const hash = sha256(canonical(input)),
      id = `physics-${hash.slice(0, 16)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const directory = path.resolve(this.runsDir, id);
    await mkdir(directory, { recursive: true });
    await writeJSON(path.join(directory, 'goal.json'), input);
    const event = async (state: string, data: unknown) => {
      await appendFile(
        path.join(directory, 'events.jsonl'),
        JSON.stringify({ state, time: new Date().toISOString(), data }) + '\n',
      );
    };
    await event('goal_received', { goal_sha256: hash });
    const result: PhysicsReport = {
      schema_version: '1.0',
      run_id: id,
      goal_sha256: hash,
      status: 'invalid',
      artifact_directory: directory,
      criteria: [],
      diagnostics: [],
      evidence: [],
      hypotheses: [],
      checks: [],
      baseline_verified: false,
      accepted_configuration: null,
      development_request: null,
      reasoning: [],
      provenance: {},
      resource_usage: {
        experiments_executed: 0,
        wall_seconds: 0,
        solver_seconds: 0,
        maximum_grid_points: 0,
        peak_estimated_array_bytes: 0,
      },
      limitations: [],
      foundry_signoff: false,
    };
    const parsed = EngineeringGoalSchema.safeParse(input);
    if (!parsed.success) {
      result.diagnostics = [
        {
          code: 'invalid_goal_schema',
          message: z.prettifyError(parsed.error),
          possible_cause: 'Missing fields, invalid units/types or non-finite input.',
          suggested_action: 'Correct the goal according to the shared EngineeringGoal JSON Schema.',
        },
      ];
    } else {
      const goal = parsed.data,
        capability = physicsCapabilities.get(goal.capability_id);
      if (!capability) {
        result.status = 'unsupported';
        result.development_request = developmentRequest(goal.capability_id);
        await writeJSON(
          path.join(directory, 'development-request.json'),
          result.development_request,
        );
      } else {
        result.criteria = structuredClone(capability.criteria);
        result.limitations = capability.limitations;
        const compiled = capability.compile(goal);
        result.diagnostics = compiled.diagnostics;
        if (!compiled.configuration) {
          result.hypotheses = [
            {
              id: 'input_error',
              source: 'deterministic_physics',
              statement:
                'The supplied configuration violates the declared capability assumptions or input ranges.',
              cause: 'input_error',
              status: 'supported',
              evidence_ids: ['goal.json'],
              explanation: compiled.diagnostics.map((d) => d.message).join(' '),
            },
          ];
        } else {
          await writeJSON(path.join(directory, 'configuration.json'), compiled.configuration);
          const plan = capability.plan(compiled.configuration);
          await writeJSON(path.join(directory, 'experiment-plan.json'), {
            criteria: capability.criteria,
            experiments: plan,
            budget: goal.experiment_budget,
          });
          await event('experiments_planned', { ids: plan.map((p) => p.id) });
          while (result.evidence.length < goal.experiment_budget) {
            const selected = capability.selectNext(goal, result.evidence, plan);
            if (!selected) break;
            const { experiment, reason } = selected;
            await event('experiment_selected', { id: experiment.id, reason });
            // Criteria and hypotheses are persisted before each solver is invoked.
            await writeJSON(path.join(directory, `${experiment.id}.experiment.json`), experiment);
            await event('experiment_running', { id: experiment.id });
            const evidence: Evidence = {
              experiment,
              configuration_sha256: sha256(canonical(experiment.configuration)),
              result: null,
              checks: [],
              error: null,
            };
            try {
              evidence.result = PhysicalResultSchema.parse(await this.backend.execute(experiment));
              evidence.checks = capability.checkExperiment(experiment, evidence.result);
            } catch (error) {
              evidence.error = String(error);
            }
            result.evidence.push(evidence);
            await writeJSON(path.join(directory, `${experiment.id}.evidence.json`), evidence);
            await event(evidence.error ? 'experiment_failed' : 'experiment_completed', {
              id: experiment.id,
              error: evidence.error,
            });
            await event('hypotheses_evaluated', {
              hypotheses: capability.assess(goal, result.evidence).hypotheses,
            });
          }
          Object.assign(result, capability.assess(goal, result.evidence));
        }
      }
    }
    result.provenance = await provenance(new PythonBackend());
    result.resource_usage = {
      experiments_executed: result.evidence.length,
      wall_seconds: (performance.now() - start) / 1000,
      solver_seconds: result.evidence.reduce(
        (s, e) => s + (e.result?.diagnostics.elapsed_seconds ?? 0),
        0,
      ),
      maximum_grid_points: Math.max(
        0,
        ...result.evidence.map((e) => e.result?.diagnostics.grid_points ?? 0),
      ),
      peak_estimated_array_bytes: Math.max(
        0,
        ...result.evidence.map((e) => e.result?.diagnostics.estimated_array_bytes ?? 0),
      ),
    };
    await event('evidence_evaluated', { status: result.status });
    const verified = PhysicsReportSchema.parse(result);
    await writeJSON(path.join(directory, 'physics-report.json'), verified);
    const files = await readdir(directory);
    await writeJSON(path.join(directory, 'artifact-manifest.json'), {
      schema_version: '1.0',
      run_id: id,
      artifacts: await Promise.all(
        files.sort().map(async (name) => ({
          name,
          sha256: sha256(await readFile(path.join(directory, name))),
        })),
      ),
    });
    return verified;
  }
}
