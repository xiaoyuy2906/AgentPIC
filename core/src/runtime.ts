import {
  mkdir,
  writeFile,
  rename,
  readFile,
  readdir,
  appendFile,
  stat,
  realpath,
  lstat,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { compile, backannotate, canonical, sha256, validateIR } from './compiler.js';
import { applyOperatingPoint, resolveVariables } from './tuning.js';
import {
  RunResultSchema,
  TuningResultSchema,
  type EngineeringIR,
  type LayoutResult,
  type RunResult,
  type VerificationReport,
} from './contracts.js';
import { PythonBackend, projectRoot, type ScientificBackend } from './backends.js';
import { readJSON, verifyArtifacts, controlSettings } from './verification.js';
export async function writeJSON(file: string, data: unknown) {
  await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n');
  await rename(`${file}.tmp`, file);
}
async function sourceHash() {
  const files: string[] = [];
  async function visit(dir: string) {
    for (const item of await readdir(path.join(projectRoot, dir), { withFileTypes: true })) {
      const p = path.join(dir, item.name);
      if (item.isDirectory() && item.name !== '__pycache__') await visit(p);
      else if (item.isFile() && /\.(ts|py)$/.test(item.name)) files.push(p);
    }
  }
  await visit('core/src');
  await visit('src/agentpic');
  return sha256(
    (
      await Promise.all(
        files.sort().map(async (f) => `${f}\n${await readFile(path.join(projectRoot, f), 'utf8')}`),
      )
    ).join('\n'),
  );
}
export async function provenance(backend: ScientificBackend) {
  let git_commit: string | null = null,
    git_dirty: boolean | null = null;
  try {
    git_commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    git_dirty = !!execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
  } catch {}
  return {
    core: 'typescript',
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    python_packages: await backend.versions(),
    source_sha256: await sourceHash(),
    uv_lock_sha256: sha256(await readFile(path.join(projectRoot, 'uv.lock'))),
    npm_lock_sha256: sha256(await readFile(path.join(projectRoot, 'package-lock.json'))),
    schema_sha256: sha256(await readFile(path.join(projectRoot, 'schemas/contracts.schema.json'))),
    git_commit,
    git_dirty,
  };
}
export class Runtime {
  readonly runsDir: string;
  constructor(
    runsDir = process.env.AGENTPIC_RUNS_DIR ?? 'runs',
    readonly backend: ScientificBackend = new PythonBackend(),
  ) {
    this.runsDir = path.resolve(runsDir);
  }
  async run(input: unknown): Promise<RunResult> {
    let ir: EngineeringIR = compile(input);
    const runID = `${ir.design_id}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const directory = path.join(this.runsDir, runID);
    await mkdir(directory, { recursive: true });
    const tasks = ir.workflow.map((task) => ({
      ...task,
      state: 'pending',
      elapsed_seconds: undefined as number | undefined,
      error: undefined as string | undefined,
    }));
    let layout: LayoutResult,
      verification: VerificationReport | undefined,
      error: string | null = null;
    const event = async (name: string, state: string, detail?: string, elapsed?: number) => {
      const task = tasks.find((t) => t.name === name)!;
      task.state = state;
      task.error = detail;
      task.elapsed_seconds = elapsed;
      await writeJSON(path.join(directory, 'workflow.json'), { tasks });
      await appendFile(
        path.join(directory, 'events.jsonl'),
        JSON.stringify({ task: name, state, time: new Date().toISOString(), error: detail }) + '\n',
      );
    };
    const handlers: Record<string, () => Promise<void>> = {
      compile: async () => {
        await writeJSON(path.join(directory, 'specification.json'), ir.specification);
        await writeJSON(path.join(directory, 'compiled_ir.json'), ir);
        if (ir.specification.device === 'circuit') {
          await writeJSON(path.join(directory, 'engineering_ir.json'), ir);
          await writeJSON(path.join(directory, 'netlist.json'), ir.netlist);
        }
        if (Object.keys(controlSettings(ir)).length)
          await writeJSON(path.join(directory, 'controls.json'), controlSettings(ir));
        if (ir.hierarchy) {
          await writeJSON(path.join(directory, 'hierarchy.json'), ir.hierarchy);
          await writeJSON(path.join(directory, 'instance-paths.json'), ir.instance_paths);
          await writeJSON(path.join(directory, 'assembly.json'), ir.assembly);
        }
      },
      layout: async () => {
        layout = await this.backend.layout(ir, directory);
        await writeJSON(path.join(directory, 'layout.json'), layout);
      },
      backannotate: async () => {
        ir = backannotate(ir, layout);
        await writeJSON(path.join(directory, 'engineering_ir.json'), ir);
        await writeJSON(path.join(directory, 'netlist.json'), ir.netlist);
      },
      tune: async () => {
        await writeJSON(path.join(directory, 'pre-tuning-ir.json'), ir);
        if (!this.backend.optimize) throw new Error('Backend does not support target tuning');
        const result = await this.backend.optimize(ir, resolveVariables(ir));
        await writeJSON(path.join(directory, 'tuning.json'), result);
        ir = validateIR(applyOperatingPoint(ir, TuningResultSchema.parse(result).controls));
        await writeJSON(path.join(directory, 'engineering_ir.json'), ir);
        await writeJSON(path.join(directory, 'netlist.json'), ir.netlist);
        await writeJSON(path.join(directory, 'controls.json'), controlSettings(ir));
      },
      simulate: async () => {
        const simulation = await this.backend.simulate(ir);
        await writeJSON(path.join(directory, 'simulation.json'), simulation);
        await writeFile(
          path.join(directory, 'spectrum.csv'),
          ir.specification.device === 'circuit'
            ? 'wavelength_nm,output_port,input_port,real,imag\n' +
                simulation.wavelength_nm
                  .flatMap((w, k) =>
                    simulation.ports.flatMap((output, i) =>
                      simulation.ports.map(
                        (input, j) =>
                          `${w},${output},${input},${simulation.s_real[k][i][j]},${simulation.s_imag[k][i][j]}`,
                      ),
                    ),
                  )
                  .join('\n') +
                '\n'
            : 'wavelength_nm,transmission_out0,transmission_out1\n' +
                simulation.wavelength_nm
                  .map(
                    (w, i) =>
                      `${w},${simulation.transmission_out0![i]},${simulation.transmission_out1![i]}`,
                  )
                  .join('\n') +
                '\n',
        );
      },
      verify: async () => {
        verification = await verifyArtifacts(directory, this.backend);
        await writeJSON(path.join(directory, 'verification.json'), verification);
      },
      manifest: async () => {
        await writeJSON(path.join(directory, 'provenance.json'), await provenance(this.backend));
      },
    };
    while (tasks.some((t) => t.state === 'pending')) {
      const task = tasks.find(
        (t) =>
          t.state === 'pending' &&
          t.depends_on.every((d) => tasks.find((x) => x.name === d)?.state === 'completed'),
      );
      if (!task) throw new Error('No runnable task in validated workflow');
      const start = performance.now();
      await event(task.name, 'running');
      try {
        await handlers[task.name]();
        await event(task.name, 'completed', undefined, (performance.now() - start) / 1000);
      } catch (exc) {
        error = String(exc);
        await event(task.name, 'failed', error);
        for (const pending of tasks.filter((t) => t.state === 'pending'))
          await event(pending.name, 'blocked', `Upstream ${task.name} failed`);
        break;
      }
    }
    const artifacts: RunResult['artifacts'] = [];
    const media: Record<string, string> = {
      '.json': 'application/json',
      '.jsonl': 'application/x-ndjson',
      '.csv': 'text/csv',
      '.svg': 'image/svg+xml',
      '.gds': 'application/octet-stream',
    };
    for (const name of (await readdir(directory)).sort()) {
      const data = await readFile(path.join(directory, name));
      artifacts.push({
        name,
        sha256: sha256(data),
        size_bytes: data.length,
        media_type: media[path.extname(name)] ?? 'application/octet-stream',
      });
    }
    const result = RunResultSchema.parse({
      run_id: runID,
      design_id: ir.design_id,
      artifact_directory: directory,
      status: !error && verification?.status === 'passed_with_limitations' ? 'completed' : 'failed',
      verification_status: verification?.status ?? 'not_run',
      artifacts,
      error,
    });
    await writeJSON(path.join(directory, 'manifest.json'), {
      schema_version: '2.0',
      run_id: runID,
      design_id: ir.design_id,
      status: result.status,
      requested_outputs: ir.specification.outputs,
      artifacts,
      foundry_signoff: false,
    });
    await writeJSON(path.join(directory, 'run.json'), result);
    return result;
  }
  async directory(id: string) {
    if (!/^[0-9a-f]{16}-[0-9a-f]{12}$/.test(id)) throw new Error('Unknown run');
    const dir = path.join(this.runsDir, id);
    if ((await lstat(dir)).isSymbolicLink()) throw new Error('Unknown run');
    await stat(path.join(dir, 'run.json'));
    return dir;
  }
  async getRun(id: string) {
    return RunResultSchema.parse(await readJSON(path.join(await this.directory(id), 'run.json')));
  }
  async artifactPath(id: string, name: string) {
    const dir = await this.directory(id);
    const allowed = new Set((await this.getRun(id)).artifacts.map((a) => a.name));
    allowed.add('manifest.json');
    allowed.add('run.json');
    const file = path.join(dir, name);
    if (
      !allowed.has(name) ||
      path.basename(name) !== name ||
      path.dirname(await realpath(file)) !== (await realpath(dir))
    )
      throw new Error('Unknown artifact');
    return file;
  }
  async verifyRun(id: string) {
    const run = await this.getRun(id);
    return verifyArtifacts(await this.directory(id), this.backend, run.artifacts);
  }
}
