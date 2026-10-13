import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CheckResultSchema,
  LayoutResultSchema,
  SimulationResultSchema,
  type EngineeringIR,
  type LayoutResult,
  type SimulationResult,
  type CheckResult,
} from './contracts.js';
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export interface ScientificBackend {
  layout(ir: EngineeringIR, directory: string): Promise<LayoutResult>;
  simulate(ir: EngineeringIR): Promise<SimulationResult>;
  verifySimulation(ir: EngineeringIR, simulation: SimulationResult): Promise<CheckResult[]>;
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
    const process = spawn('uv', ['run', '--locked', 'python', '-m', 'agentpic.worker'], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      finished = false;
    const timer = setTimeout(() => {
      process.kill('SIGKILL');
      reject(new Error('Scientific backend timed out after 120 seconds'));
    }, 120000);
    process.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 32 * 1024 * 1024) process.kill('SIGKILL');
    });
    process.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-12000);
    });
    process.on('error', (error) => {
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    process.stdin.on('error', () => {});
    process.on('close', (code) => {
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
    process.stdin.end(JSON.stringify(request));
  });
}
export class PythonBackend implements ScientificBackend {
  async layout(ir: EngineeringIR, directory: string) {
    return LayoutResultSchema.parse(await pythonRequest({ operation: 'layout', ir, directory }));
  }
  async simulate(ir: EngineeringIR) {
    return SimulationResultSchema.parse(await pythonRequest({ operation: 'simulate', ir }));
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
  devices: ['mzi'],
  platforms: ['sin'],
  technology: 'sin_demo_v1',
  circuit: { backend: 'sax', status: 'implemented' },
  layout: { backend: 'gdsfactory', status: 'implemented' },
  electromagnetic: { fdtdx: 'not_implemented', fem: 'not_implemented', eme: 'not_implemented' },
  foundry_signoff: false,
  physical_model_calibration: 'not_performed',
});
