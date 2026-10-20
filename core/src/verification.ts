import { readFile, stat, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  check,
  semanticChecks,
  endpointKey,
  canonical,
  sha256,
  validateIR,
  compile,
  backannotate,
} from './compiler.js';
import { pathIndex } from './design.js';
import { applyOperatingPoint, resolveVariables } from './tuning.js';
import { verifyTuning } from './tuning-verification.js';
import {
  EngineeringIRSchema,
  LayoutResultSchema,
  SimulationResultSchema,
  TuningResultSchema,
  type EngineeringIR,
  type LayoutResult,
  type CheckResult,
  type RunResult,
  type VerificationReport,
  VerificationReportSchema,
} from './contracts.js';
import { PythonBackend, type ScientificBackend } from './backends.js';
const limitations = [
  'Illustrative SiN PDK; no foundry signoff rule deck.',
  'Ideal compact models are mathematically checked, not EM- or measurement-calibrated.',
  'No bend loss, manufacturing variation or thermal model.',
  'Port-based connectivity with geometry checks is not full foundry LVS.',
];
export const readJSON = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as unknown;
export const controlSettings = (ir: EngineeringIR) =>
  Object.fromEntries(
    ir.netlist.instances
      .filter((i) => i.phase_control !== null)
      .map((i) => [
        i.name,
        {
          ...i.phase_control,
          reference_wavelength_um: ir.technology.reference_wavelength_um,
          electrical_mapping: 'not_calibrated',
        },
      ]),
  );
function physicalChecks(ir: EngineeringIR, layout: LayoutResult): CheckResult[] {
  const edgeKey = (e: {
    a: { instance: string; port: string };
    b: { instance: string; port: string };
  }) => [endpointKey(e.a), endpointKey(e.b)].sort().join('|');
  const actual = layout.extracted_circuit;
  const graphOK =
    canonical(ir.netlist.connections.map(edgeKey).sort()) ===
      canonical(actual.connections.map(edgeKey).sort()) &&
    canonical(ir.netlist.ports) === canonical(actual.ports) &&
    canonical(
      ir.netlist.instances
        .map((i) => [i.name, i.ports.map((p) => `${p.name}:${p.domain}`).sort()])
        .sort(),
    ) ===
      canonical(
        actual.instances
          .map((i) => [i.name, i.ports.map((p) => `${p.name}:${p.domain}`).sort()])
          .sort(),
      );
  let error = 0,
    aligned = ir.netlist.instances.every((i) =>
      i.ports.every((p) => layout.ports[i.name]?.[p.name]?.domain === p.domain),
    );
  for (const edge of ir.netlist.connections) {
    const a = layout.ports[edge.a.instance]?.[edge.a.port],
      b = layout.ports[edge.b.instance]?.[edge.b.port];
    if (!a || !b) {
      aligned = false;
      continue;
    }
    error = Math.max(
      error,
      Math.hypot(a.center_um[0] - b.center_um[0], a.center_um[1] - b.center_um[1]),
      Math.abs(a.width_um - b.width_um),
    );
    aligned &&=
      Math.abs(((((a.orientation_deg - b.orientation_deg) % 360) + 360) % 360) - 180) < 1e-6;
  }
  const lengths = Object.fromEntries(
    Object.entries(layout.centerlines_um).map(([name, p]) => [
      name,
      p.slice(1).reduce((sum, q, i) => sum + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0),
    ]),
  );
  const lengthError = Math.max(
    ...ir.netlist.instances
      .filter((i) => i.kind !== 'ideal_coupler')
      .map((i) => Math.abs(lengths[i.name] - (i.length_um ?? NaN))),
  );
  const index = pathIndex(ir);
  const length = (p: string) => lengths[index.get(p) ?? ''] ?? NaN;
  const constraints = (ir.specification.layout?.constraints ?? []).map((c) => {
    const actual = c.kind === 'length' ? length(c.instance) : length(c.a) - length(c.b);
    return { ...c, actual_um: actual, error_um: Math.abs(actual - c.value_um) };
  });
  return [
    check(
      'layout_netlist_agreement',
      graphOK,
      'Backend-neutral extracted circuit matches intended topology.',
    ),
    check(
      'physical_port_alignment',
      aligned && error <= 0.001,
      'Connected ports coincide, widths match and orientations oppose.',
      { maximum_error_um: error },
    ),
    check(
      'physical_length_backannotation',
      ir.layout_resolved && lengthError <= 0.001,
      'Independent centerline sums match simulation lengths.',
      { maximum_error_um: lengthError },
    ),
    ...(constraints.length
      ? [
          check(
            'layout_constraints',
            constraints.every((c) => c.error_um <= c.tolerance_um),
            'Measured path lengths satisfy every declared layout constraint.',
            { constraints },
          ),
        ]
      : []),
  ];
}
export const layoutNotRunChecks = (): CheckResult[] => [
  {
    id: 'layout_generation',
    status: 'not_run',
    detail: 'No layout plan was executed, so no GDS was generated.',
    evidence: {},
  },
  {
    id: 'layout_verification',
    status: 'not_run',
    detail:
      'No physical layout, extracted connectivity, DRC or measured path lengths are available.',
    evidence: {},
  },
];
export function report(designID: string, checks: CheckResult[]): VerificationReport {
  for (const [id, detail] of [
    ['electromagnetic_calibration', 'No electromagnetic solver or model calibration executed.'],
    ['measurement_validation', 'No fabricated-device measurements supplied.'],
    ['foundry_signoff', 'No foundry PDK/signoff checks available.'],
  ])
    checks.push({ id, status: 'not_run', detail, evidence: {} });
  return VerificationReportSchema.parse({
    design_id: designID,
    status: checks.some((c) => c.status === 'fail') ? 'failed' : 'passed_with_limitations',
    checks,
    limitations,
  });
}
export async function verifyArtifacts(
  directory: string,
  backend: ScientificBackend = new PythonBackend(),
  artifacts?: RunResult['artifacts'],
): Promise<VerificationReport> {
  const checks: CheckResult[] = [];
  let id = 'unknown';
  if (artifacts) {
    const mismatches: string[] = [];
    for (const artifact of artifacts) {
      try {
        const file = path.join(directory, artifact.name);
        if (
          path.basename(artifact.name) !== artifact.name ||
          path.dirname(await realpath(file)) !== (await realpath(directory)) ||
          (await stat(file)).size !== artifact.size_bytes ||
          sha256(await readFile(file)) !== artifact.sha256
        )
          mismatches.push(artifact.name);
      } catch {
        mismatches.push(artifact.name);
      }
    }
    checks.push(
      check(
        'artifact_integrity',
        mismatches.length === 0,
        'Artifacts match the recorded SHA-256 inventory.',
        { mismatches },
      ),
    );
  }
  try {
    const ir = EngineeringIRSchema.parse(
      await readJSON(path.join(directory, 'engineering_ir.json')),
    );
    id = ir.design_id;
    checks.push(...semanticChecks(ir));
    if (Object.keys(controlSettings(ir)).length)
      checks.push(
        check(
          'control_artifact_consistency',
          canonical(await readJSON(path.join(directory, 'controls.json'))) ===
            canonical(controlSettings(ir)),
          'Exported optical controls and calibration boundary match engineering intent.',
        ),
      );
    if (ir.hierarchy)
      checks.push(
        check(
          'hierarchy_artifact_consistency',
          canonical(await readJSON(path.join(directory, 'hierarchy.json'))) ===
            canonical(ir.hierarchy) &&
            canonical(await readJSON(path.join(directory, 'instance-paths.json'))) ===
              canonical(ir.instance_paths),
          'Exported hierarchy and primitive source paths match the resolved engineering IR.',
        ),
      );
    const simulation = SimulationResultSchema.parse(
      await readJSON(path.join(directory, 'simulation.json')),
    );
    checks.push(
      check(
        'netlist_artifact_consistency',
        canonical(await readJSON(path.join(directory, 'netlist.json'))) === canonical(ir.netlist),
        'Exported netlist equals resolved IR.',
      ),
    );
    // Every derived workflow state must be rebuildable from the submitted design.
    const compiled = compile(ir.specification);
    const layout = ir.specification.layout
      ? LayoutResultSchema.parse(await readJSON(path.join(directory, 'layout.json')))
      : null;
    const expected = layout ? backannotate(compiled, layout) : compiled;
    const before = ir.specification.tuning
      ? EngineeringIRSchema.parse(await readJSON(path.join(directory, 'pre-tuning-ir.json')))
      : null;
    checks.push(
      check(
        'workflow_state_consistency',
        canonical(await readJSON(path.join(directory, 'specification.json'))) ===
          canonical(ir.specification) &&
          canonical(await readJSON(path.join(directory, 'compiled_ir.json'))) ===
            canonical(compiled) &&
          canonical(before ?? ir) === canonical(expected),
        'Specification, compiled IR, measured pre-tuning state and final IR are rebuilt from the submitted design.',
      ),
    );
    if (layout) checks.push(...physicalChecks(ir, layout));
    else
      checks.push(
        check(
          'layout_boundary',
          !(await readdir(directory)).some(
            (name) => name.endsWith('.gds') || name === 'layout.json',
          ),
          'A design without a layout plan exports no physical artifacts.',
        ),
        ...layoutNotRunChecks(),
      );
    if (before) {
      const tuning = TuningResultSchema.parse(await readJSON(path.join(directory, 'tuning.json')));
      checks.push(...verifyTuning(ir, before, tuning, simulation));
      checks.push(
        ...(backend.verifyTuning
          ? await backend.verifyTuning(ir, tuning)
          : [check('tuning_trace_reference', false, 'Independent tuning verifier unavailable.')]),
      );
    }
    const [optical, geometry] = await Promise.all([
      backend.verifySimulation(ir, simulation),
      layout ? backend.verifyGeometry(ir, layout, directory) : [],
    ]);
    checks.push(...optical, ...geometry);
  } catch (error) {
    checks.push(check('artifact_read_or_validation', false, String(error)));
  }
  return report(id, checks);
}
export async function simulateCircuit(
  input: unknown,
  backend: ScientificBackend = new PythonBackend(),
) {
  let ir = validateIR(input);
  const before = structuredClone(ir);
  let tuning = null;
  if (ir.specification.tuning) {
    if (ir.operating_point)
      throw new Error(
        'Submit unresolved compiled IR to tune; use verify_run for persisted operating-point evidence.',
      );
    if (!backend.optimize) throw new Error('Backend does not support target tuning');
    tuning = TuningResultSchema.parse(await backend.optimize(ir, resolveVariables(ir)));
    ir = validateIR(applyOperatingPoint(ir, tuning.controls));
  }
  const simulation = await backend.simulate(ir);
  return {
    ir,
    tuning,
    simulation,
    verification: report(ir.design_id, [
      ...semanticChecks(ir),
      ...layoutNotRunChecks(),
      ...(await backend.verifySimulation(ir, simulation)),
      ...(tuning ? verifyTuning(ir, before, tuning, simulation) : []),
      ...(tuning
        ? backend.verifyTuning
          ? await backend.verifyTuning(ir, tuning)
          : [check('tuning_trace_reference', false, 'Independent tuning verifier unavailable.')]
        : []),
    ]),
  };
}
