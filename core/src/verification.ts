import { readFile, stat, realpath } from 'node:fs/promises';
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
  const targets = ir.assembly?.blocks.map((block) => ({
    name: block.name,
    top: block.primitives.top_arm,
    bottom: block.primitives.bottom_arm,
    delta: block.delta_length_um,
  })) ?? [
    {
      name: 'mzi',
      top: 'top_arm',
      bottom: 'bottom_arm',
      delta: ir.specification.device === 'mzi' ? ir.specification.delta_length_um : NaN,
    },
  ];
  const deltaErrors = Object.fromEntries(
    targets.map((t) => [t.name, Math.abs(lengths[t.top] - lengths[t.bottom] - t.delta)]),
  );
  const deltaError = Math.max(...Object.values(deltaErrors));
  const linkError = ir.assembly
    ? Math.max(
        ...ir.assembly.links.map((link) =>
          Math.abs(lengths[link.instance] - ir.assembly!.link_length_um),
        ),
      )
    : 0;
  return [
    ...(ir.assembly
      ? [
          check(
            'requested_interconnect_lengths',
            linkError <= 0.001,
            'Every connecting waveguide matches the requested physical length.',
            { maximum_error_um: linkError },
          ),
        ]
      : []),
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
    check(
      'requested_path_imbalance',
      deltaError <= 0.002,
      'Physical arm imbalance matches the specification.',
      { error_um: deltaError, stage_errors_um: deltaErrors },
    ),
  ];
}
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
              canonical(ir.instance_paths) &&
            canonical(await readJSON(path.join(directory, 'assembly.json'))) ===
              canonical(ir.assembly),
          'Exported hierarchy, primitive source paths and assembly plan match the resolved engineering IR.',
        ),
      );
    const layout = LayoutResultSchema.parse(await readJSON(path.join(directory, 'layout.json')));
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
    checks.push(...physicalChecks(ir, layout));
    if (ir.specification.tuning) {
      const before = EngineeringIRSchema.parse(
        await readJSON(path.join(directory, 'pre-tuning-ir.json')),
      );
      const tuning = TuningResultSchema.parse(await readJSON(path.join(directory, 'tuning.json')));
      const compiled = compile(ir.specification);
      checks.push(
        check(
          'tuning_source_intent',
          canonical(await readJSON(path.join(directory, 'specification.json'))) ===
            canonical(ir.specification) &&
            canonical(await readJSON(path.join(directory, 'compiled_ir.json'))) ===
              canonical(compiled) &&
            canonical(before) === canonical(backannotate(compiled, layout)),
          'Original specification, compiled IR and measured pre-tuning state remain consistent.',
        ),
      );
      checks.push(...verifyTuning(ir, before, tuning, simulation));
      checks.push(
        ...(backend.verifyTuning
          ? await backend.verifyTuning(ir, tuning)
          : [check('tuning_trace_reference', false, 'Independent tuning verifier unavailable.')]),
      );
    }
    const [optical, geometry] = await Promise.all([
      backend.verifySimulation(ir, simulation),
      backend.verifyGeometry(ir, layout, directory),
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
