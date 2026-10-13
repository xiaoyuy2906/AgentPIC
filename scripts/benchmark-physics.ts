import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PhysicsRuntime } from '../core/src/physics/runtime.js';
import { EngineeringGoalSchema, type EngineeringGoal } from '../core/src/physics/contracts.js';
import { capabilityRegistry } from '../core/src/physics/registry.js';
import { writeJSON } from '../core/src/runtime.js';
import { sha256 } from '../core/src/compiler.js';
const index = process.argv.indexOf('--output'),
  output = path.resolve(index < 0 ? 'runs/physics-benchmarks' : process.argv[index + 1]);
await mkdir(output, { recursive: true });
const registry = JSON.parse(await readFile('benchmarks/registry.json', 'utf8')) as {
  benchmarks: {
    id: string;
    expected_status: string;
    expected_diagnostic?: string;
    expected_hypothesis?: string;
    checks?: string[];
  }[];
};
const original = JSON.parse(await readFile('examples/straight_waveguide.json', 'utf8'));
const mutations: Record<string, (g: EngineeringGoal) => void> = {
  valid_straight_waveguide: () => {},
  wrong_wavelength_units: (g) => {
    g.wavelength.value = 1.55;
  },
  invalid_material: (g) => {
    g.model.materials.core.refractive_index = -2;
  },
  inconsistent_assumptions: (g) => {
    g.model.assumptions.lossless = false;
  },
  coarse_resolution: (g) => {
    g.numerical.grid_step.value = 0.2;
  },
  truncated_domain: (g) => {
    g.numerical.padding.value = 0.1;
  },
  equivalent_units: (g) => {
    g.wavelength = { value: 1.55e-6, unit: 'm', dimension: 'length' };
  },
  insufficient_budget: (g) => {
    g.experiment_budget = 2;
  },
};
// Record expected outcomes and fixed criteria before starting any benchmark.
await writeJSON(path.join(output, 'benchmark-plan.json'), registry);
await writeJSON(path.join(output, 'capability-registry.json'), capabilityRegistry());
const runtime = new PhysicsRuntime(path.join(output, 'runs'));
const results = [];
for (const benchmark of registry.benchmarks) {
  const goal = EngineeringGoalSchema.parse(structuredClone(original));
  mutations[benchmark.id](goal);
  const report = await runtime.run(goal);
  const evaluations = [
    ...report.checks,
    ...(report.evidence.find((e) => e.experiment.id === 'baseline')?.checks ?? []),
  ];
  const missingChecks = (benchmark.checks ?? []).filter(
    (id) => !evaluations.some((check) => check.criterion_id === id && check.status === 'pass'),
  );
  const passed =
    report.status === benchmark.expected_status &&
    missingChecks.length === 0 &&
    (!benchmark.expected_diagnostic ||
      report.diagnostics.some((d) => d.code === benchmark.expected_diagnostic)) &&
    (!benchmark.expected_hypothesis ||
      report.hypotheses.some(
        (h) => h.cause === benchmark.expected_hypothesis && h.status === 'supported',
      ));
  const file = path.join(report.artifact_directory, 'physics-report.json');
  results.push({
    id: benchmark.id,
    passed,
    expected_status: benchmark.expected_status,
    actual_status: report.status,
    missing_passing_checks: missingChecks,
    report: file,
    sha256: sha256(await readFile(file)),
    resource_usage: report.resource_usage,
  });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${benchmark.id}: ${report.status}`);
}
const passed = results.every((r) => r.passed);
await writeJSON(path.join(output, 'benchmark-results.json'), {
  schema_version: '1.0',
  status: passed ? 'verified' : 'failed',
  capability_id: 'optical.mode.planar_te',
  benchmark_registry_sha256: sha256(await readFile('benchmarks/registry.json')),
  results,
});
if (!passed) process.exitCode = 1;
