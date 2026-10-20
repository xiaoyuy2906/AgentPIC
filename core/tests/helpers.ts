/** Shared test utilities: temporary runtimes, artifact corruption and independent GDS reads. */
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Runtime } from '../src/runtime.js';
import { projectRoot } from '../src/backends.js';
import type { SimulationResult, VerificationReport } from '../src/contracts.js';
import { componentMode, loadPDK } from '../src/pdk.js';

export const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
export const python = path.resolve(
  projectRoot,
  process.env.UV_PROJECT_ENVIRONMENT ?? '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
export async function tempRuntime(label: string) {
  const root = await mkdtemp(path.join(tmpdir(), `agentpic-${label}-`));
  return { root, runtime: new Runtime(root) };
}
export const checked = (report: VerificationReport, id: string) =>
  report.checks.find((c) => c.id === id);
/** |S[output, input]|² at one sample of an exported simulation. */
export function power(sim: SimulationResult, output: string, input: string, sample: number) {
  const i = sim.ports.indexOf(output),
    j = sim.ports.indexOf(input);
  return sim.s_real[sample][i][j] ** 2 + sim.s_imag[sample][i][j] ** 2;
}
/** Copy a run directory and apply one edit to a JSON artifact. */
export async function corruptCopy(
  source: string,
  target: string,
  file: string,
  edit: (data: any) => void,
) {
  await cp(source, target, { recursive: true });
  const data = await json(path.join(target, file));
  edit(data);
  await writeFile(path.join(target, file), JSON.stringify(data));
}
/** Run a KLayout snippet with sys.argv = [script, ...args]. */
export const klayout = (script: string, ...args: string[]) =>
  execFileSync(python, ['-c', `import sys, klayout.db as k\n${script}`, ...args]);
/** Core and heater polygons of two GDS files are identical regardless of cell names. */
export const assertSameGeometry = (a: string, b: string) =>
  klayout(
    `a,b=k.Layout(),k.Layout(); a.read(sys.argv[1]); b.read(sys.argv[2])
assert a.dbu == b.dbu
for layer in [(1,0),(2,0)]:
 r=k.Region(a.top_cell().begin_shapes_rec(a.find_layer(*layer))).merged()
 s=k.Region(b.top_cell().begin_shapes_rec(b.find_layer(*layer))).merged()
 assert not r.is_empty() and (r ^ s).is_empty(), layer`,
    a,
    b,
  );
/** Execute the HTTP + MCP acceptance script for one design file. */
export async function acceptance(design: string, output: string) {
  await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'scripts/acceptance.ts', '--specification', design, '--output', output],
    { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024 },
  );
  return json(path.join(output, 'acceptance.json'));
}
/** Waveguide mode model of the default PDK; golden references must use the same values. */
export const strip = componentMode(loadPDK('sin_demo_v1'), 'waveguide')!;
export const neff = strip.effective_index,
  ng = strip.group_index,
  wl0 = strip.reference_wavelength_um;
