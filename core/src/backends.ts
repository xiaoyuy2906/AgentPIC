import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { primitiveModels } from './generic.js';
import {
  CheckResultSchema,
  LayoutResultSchema,
  SimulationResultSchema,
  TuningResultSchema,
  type TuningResult,
  type ResolvedTuningVariable,
  type EngineeringIR,
  type LayoutResult,
  type SimulationResult,
  type CheckResult,
} from './contracts.js';
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export interface ScientificBackend {
  layout(ir: EngineeringIR, directory: string): Promise<LayoutResult>;
  simulate(ir: EngineeringIR): Promise<SimulationResult>;
  optimize?(ir: EngineeringIR, variables: ResolvedTuningVariable[]): Promise<TuningResult>;
  verifySimulation(ir: EngineeringIR, simulation: SimulationResult): Promise<CheckResult[]>;
  verifyTuning?(ir: EngineeringIR, tuning: TuningResult): Promise<CheckResult[]>;
  verifyGeometry(
    ir: EngineeringIR,
    layout: LayoutResult,
    directory: string,
  ): Promise<CheckResult[]>;
  versions(): Promise<Record<string, string>>;
}
/** This is the sole process boundary; no backend-owned object crosses it. */
export function pythonRequest(request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // uv sync prepares this environment once. Never mutate it during concurrent calculations.
    const executable = path.resolve(
      projectRoot,
      process.env.UV_PROJECT_ENVIRONMENT ?? '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
    const child = spawn(executable, ['-m', 'agentpic.worker'], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      finished = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Scientific backend timed out after 120 seconds'));
    }, 120000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 32 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-12000);
    });
    child.on('error', (error) => {
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      if (finished) return;
      try {
        const data = JSON.parse(stdout);
        if (code !== 0 || !data.ok) throw new Error(data.error ?? `Backend exited ${code}`);
        resolve(data.result);
      } catch (error) {
        reject(new Error(`${error instanceof Error ? error.message : error}\n${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
export class PythonBackend implements ScientificBackend {
  async optimize(ir: EngineeringIR, variables: ResolvedTuningVariable[]) {
    return TuningResultSchema.parse(await pythonRequest({ operation: 'optimize', ir, variables }));
  }
  async layout(ir: EngineeringIR, directory: string) {
    return LayoutResultSchema.parse(await pythonRequest({ operation: 'layout', ir, directory }));
  }
  async simulate(ir: EngineeringIR) {
    return SimulationResultSchema.parse(await pythonRequest({ operation: 'simulate', ir }));
  }
  async verifyTuning(ir: EngineeringIR, tuning: TuningResult) {
    return z
      .array(CheckResultSchema)
      .parse(await pythonRequest({ operation: 'verify_tuning', ir, tuning }));
  }
  async verifySimulation(ir: EngineeringIR, simulation: SimulationResult) {
    return z
      .array(CheckResultSchema)
      .parse(await pythonRequest({ operation: 'verify_simulation', ir, simulation }));
  }
  async verifyGeometry(ir: EngineeringIR, layout: LayoutResult, directory: string) {
    return z
      .array(CheckResultSchema)
      .parse(await pythonRequest({ operation: 'verify_geometry', ir, layout, directory }));
  }
  async versions() {
    return z.record(z.string(), z.string()).parse(await pythonRequest({ operation: 'versions' }));
  }
}
export const capabilities = () => ({
  schema_version: '2.0',
  core: 'typescript',
  contracts: 'zod-generated-json-schema',
  devices: ['mzi', 'mzi_cascade', 'ring_add_drop', 'circuit'],
  generic_circuit: {
    compilation: 'implemented',
    simulation: 'implemented',
    verification: 'implemented',
    models: primitiveModels,
    max_instances: 32,
    max_optical_ports: 16,
    max_sweep_points: 1001,
    layout: 'not_implemented',
    target_tuning: 'not_implemented',
    model_calibration: 'not_performed',
  },
  feedback_networks: {
    add_drop_ring: 'implemented',
    spectral_sampling_verification: 'implemented',
    geometry_to_coupling_calibration: 'not_performed',
  },
  platforms: ['sin'],
  technology: 'sin_demo_v1',
  circuit: { backend: 'sax', status: 'implemented' },
  layout: { backend: 'gdsfactory', status: 'implemented' },
  hierarchy: { compilation: 'implemented', cascade_layout: 'implemented' },
  phase_control: {
    target_tuning: {
      status: 'implemented',
      backend: 'scipy_least_squares+sax',
      max_variables: 4,
      max_targets: 16,
      max_evaluations: 512,
      global_optimality: false,
    },
    optical_phase: 'implemented',
    metal_geometry: 'implemented',
    electrical_to_phase_calibration: 'not_performed',
    electrical_solver: 'not_implemented',
  },
  electromagnetic: { fdtdx: 'not_implemented', fem: 'not_implemented', eme: 'not_implemented' },
  foundry_signoff: false,
  physical_model_calibration: 'not_performed',
});
