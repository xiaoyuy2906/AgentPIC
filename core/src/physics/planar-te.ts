/** Domain-specific policy plugin; the experiment runtime does not know waveguide geometry. */
import type { PhysicsCapability } from './registry.js';
import {
  PhysicsConfigurationSchema,
  type EngineeringGoal,
  type PhysicsConfiguration,
  type Criterion,
  type Evaluation,
  type Hypothesis,
  type Evidence,
  type Diagnostic,
} from './contracts.js';
const um = (q: { value: number; unit: 'nm' | 'um' | 'm' }) =>
  q.value * { nm: 0.001, um: 1, m: 1e6 }[q.unit];
const criteria: Criterion[] = [
  {
    id: 'propagation_units',
    observable: 'relative_beta_consistency_error',
    comparison: 'lte',
    thresholds: [1e-12],
    unit: '1',
    rationale: 'beta must equal 2π neff / wavelength in the declared inverse-micrometre units.',
  },
  {
    id: 'guiding_bounds',
    observable: 'effective_index',
    comparison: 'range',
    thresholds: [],
    unit: '1',
    rationale:
      'For a lossless guided mode, background index < neff < maximum core index; bounds derive from the declared model.',
  },
  {
    id: 'eigen_residual',
    observable: 'relative_residual',
    comparison: 'lte',
    thresholds: [1e-8],
    unit: '1',
    rationale:
      'Algebraic eigenproblem or dispersion residual must be small independently of discretization accuracy.',
  },
  {
    id: 'sampling',
    observable: 'minimum_core_cells',
    comparison: 'gte',
    thresholds: [20],
    unit: 'cells',
    rationale: 'At least 20 cells across the thinnest core before accepting the baseline.',
  },
  {
    id: 'reference_agreement',
    observable: 'absolute_effective_index_error',
    comparison: 'lte',
    thresholds: [1e-4],
    unit: '1',
    rationale: 'Agreement with an independent symmetric-slab dispersion relation.',
  },
  {
    id: 'grid_convergence',
    observable: 'effective_index_change',
    comparison: 'lte',
    thresholds: [1e-4],
    unit: '1',
    rationale:
      'Two consecutive spatial refinements must stabilize neff within the declared accuracy.',
  },
  {
    id: 'domain_convergence',
    observable: 'effective_index_change',
    comparison: 'lte',
    thresholds: [1e-5],
    unit: '1',
    rationale: 'Doubling the sufficiently padded domain must have negligible effect.',
  },
  {
    id: 'reproducibility',
    observable: 'effective_index_change',
    comparison: 'lte',
    thresholds: [1e-12],
    unit: '1',
    rationale: 'Repeated identical configurations must reproduce neff.',
  },
];
const evaluation = (
  id: string,
  ok: boolean,
  value: number | null,
  ids: string[],
  detail: string,
): Evaluation => ({
  criterion_id: id,
  status: ok ? 'pass' : 'fail',
  value,
  evidence_ids: ids,
  detail,
});
const get = (items: Evidence[], id: string) => items.find((e) => e.experiment.id === id);
export const planarTE: PhysicsCapability = {
  id: 'optical.mode.planar_te',
  description:
    'Fundamental TE mode of a propagation-invariant layered dielectric using SciPy, with an independent symmetric single-layer reference.',
  limitations: [
    'One-dimensional, scalar TE, linear lossless isotropic nonmagnetic material assumptions.',
    'Fundamental mode only; benchmark policy currently requires one symmetric core layer.',
    'No fabricated-material calibration, finite-width channel effects, bend loss, 3D FDTD or foundry signoff.',
    'LLM proposals are hypotheses only and cannot override numerical acceptance criteria.',
  ],
  criteria,
  compile(goal) {
    const diagnostics: Diagnostic[] = [];
    const add = (code: string, message: string, cause: string, action: string) =>
      diagnostics.push({ code, message, possible_cause: cause, suggested_action: action });
    if (goal.model.kind !== 'layered_dielectric' || goal.model.layers.length !== 1)
      add(
        'unsupported_model',
        'Independent reference supports one symmetric dielectric layer.',
        'Missing independently verified policy for this model.',
        'Develop and benchmark a suitable reference adapter before accepting this model.',
      );
    if (goal.polarization !== 'TE' || Object.values(goal.model.assumptions).some((v) => !v))
      add(
        'inconsistent_assumptions',
        'The selected backend requires TE and all declared invariant, linear, lossless, isotropic and nonmagnetic assumptions.',
        'Backend physics assumptions do not match the requested model.',
        'Select or implement a backend matching the physical assumptions.',
      );
    const wl = um(goal.wavelength);
    if (wl < 0.4 || wl > 2.5)
      add(
        'wavelength_unit_or_range',
        'Normalized wavelength is outside the supported optical interval 0.4–2.5 µm.',
        `Value ${goal.wavelength.value} ${goal.wavelength.unit} equals ${wl} µm; a unit/scale mismatch is possible.`,
        'Correct the declared value/unit or request a capability for that wavelength range; no silent unit repair is applied.',
      );
    const background = goal.model.materials[goal.model.background_material]?.refractive_index;
    for (const [name, material] of Object.entries(goal.model.materials))
      if (material.refractive_index < 1 || material.refractive_index > 4)
        add(
          'invalid_material',
          `Material ${name} index must lie in the benchmark range [1,4].`,
          'Invalid or unsupported material parameters.',
          'Provide valid real optical indices or extend the material model with evidence.',
        );
    if (background === undefined)
      add(
        'missing_material',
        'Background material is not defined.',
        'Unresolved material reference.',
        'Define the named background material.',
      );
    const layers = goal.model.layers.map((layer) => ({
      thickness_um: um(layer.thickness),
      refractive_index: goal.model.materials[layer.material]?.refractive_index ?? NaN,
    }));
    if (layers.some((l) => !(l.thickness_um >= 0.05 && l.thickness_um <= 2)))
      add(
        'geometry_unit_or_range',
        'Core thickness must be 0.05–2 µm for this benchmark.',
        'Incorrect length units or unsupported geometry.',
        'Correct the thickness or define a broader benchmark.',
      );
    if (
      layers.some((l) => !Number.isFinite(l.refractive_index) || !(l.refractive_index > background))
    )
      add(
        'no_index_guiding',
        'Every core layer must have an index above the background.',
        'Missing material or inconsistent guiding assumptions.',
        'Correct material references/indices or use a suitable nonguiding model.',
      );
    const parsed = PhysicsConfigurationSchema.safeParse({
      model_kind: goal.model.kind,
      wavelength_um: wl,
      polarization: goal.polarization,
      layers,
      background_index: background,
      grid_step_um: um(goal.numerical.grid_step),
      padding_um: um(goal.numerical.padding),
      max_points: goal.numerical.max_points,
    });
    if (!parsed.success)
      add(
        'invalid_numerics',
        'Numerical lengths and material values must be finite and positive.',
        'Invalid resolution, padding or material reference.',
        'Use positive finite numerical dimensions and resolve all material references.',
      );
    return {
      configuration: diagnostics.length || !parsed.success ? null : parsed.data,
      diagnostics,
    };
  },
  plan(configuration) {
    const refined = {
      ...configuration,
      grid_step_um: Math.min(configuration.grid_step_um / 2, 0.01),
    };
    const fine = { ...refined, grid_step_um: refined.grid_step_um / 2 };
    const expanded = { ...fine, padding_um: Math.max(2, configuration.padding_um * 2) };
    const confirmed = { ...expanded, padding_um: expanded.padding_um * 2 };
    return [
      {
        id: 'baseline',
        operation: 'mode_planar_te',
        purpose: 'Measure the submitted configuration.',
        hypothesis_ids: [],
        configuration,
      },
      {
        id: 'analytic_reference',
        operation: 'reference_planar_te',
        purpose: 'Independent dispersion-relation benchmark.',
        hypothesis_ids: ['reference_disagreement'],
        configuration,
      },
      {
        id: 'refined_grid',
        operation: 'mode_planar_te',
        purpose: 'Test whether spatial discretization changes the prediction.',
        hypothesis_ids: ['discretization_error'],
        configuration: refined,
      },
      {
        id: 'fine_grid',
        operation: 'mode_planar_te',
        purpose: 'Confirm numerical convergence under a second refinement.',
        hypothesis_ids: ['discretization_error'],
        configuration: fine,
      },
      {
        id: 'expanded_domain',
        operation: 'mode_planar_te',
        purpose: 'Test whether truncated evanescent tails bias the solution.',
        hypothesis_ids: ['boundary_truncation'],
        configuration: expanded,
      },
      {
        id: 'confirmed_domain',
        operation: 'mode_planar_te',
        purpose: 'Confirm convergence after another boundary expansion.',
        hypothesis_ids: ['boundary_truncation'],
        configuration: confirmed,
      },
      {
        id: 'repeat',
        operation: 'mode_planar_te',
        purpose: 'Test repeatability of the accepted candidate.',
        hypothesis_ids: ['non_reproducibility'],
        configuration: confirmed,
      },
    ].map((e) => ({
      ...e,
      criteria: structuredClone(criteria).map((c) =>
        c.id === 'guiding_bounds'
          ? {
              ...c,
              thresholds: [
                configuration.background_index,
                Math.max(...configuration.layers.map((l) => l.refractive_index)),
              ],
            }
          : c,
      ),
    }));
  },
  selectNext(goal, evidence, candidates) {
    const done = new Set(evidence.map((e) => e.experiment.id));
    const pick = (id: string, reason: string) => {
      const experiment = candidates.find((e) => e.id === id && !done.has(id));
      return experiment ? { experiment, reason } : null;
    };
    if (!done.has('baseline'))
      return pick('baseline', 'First measure the submitted physical model.');
    if (!done.has('analytic_reference'))
      return pick(
        'analytic_reference',
        'Compare the baseline to an independent physical equation before diagnosing its error.',
      );
    const baseline = get(evidence, 'baseline');
    const reference = get(evidence, 'analytic_reference');
    const suspiciousPrediction =
      !!baseline?.result &&
      !!reference?.result &&
      Math.abs(baseline.result.effective_index - reference.result.effective_index) > 1e-4;
    const shortDomain =
      suspiciousPrediction &&
      baseline &&
      baseline.experiment.configuration.padding_um <
        baseline.experiment.configuration.wavelength_um;
    const boundaryProposal = goal.reasoning_proposals.some(
      (p) => p.cause === 'boundary_truncation',
    );
    const order =
      shortDomain || boundaryProposal
        ? ['expanded_domain', 'confirmed_domain', 'refined_grid', 'fine_grid', 'repeat']
        : ['refined_grid', 'fine_grid', 'expanded_domain', 'confirmed_domain', 'repeat'];
    for (const id of order) {
      const selected = pick(
        id,
        shortDomain
          ? 'Observed reference disagreement combined with short padding suggests evanescent-tail truncation; prioritize boundary experiments, then check spatial convergence.'
          : boundaryProposal
            ? 'An external hypothesis prioritizes boundary testing; acceptance still requires all independent numerical checks.'
            : 'Test discretization first, then boundary convergence and repeatability.',
      );
      if (selected) return selected;
    }
    return null;
  },
  checkExperiment(experiment, result) {
    const c = experiment.configuration;
    const nmax = Math.max(...c.layers.map((l) => l.refractive_index));
    const betaExpected = (2 * Math.PI * result.effective_index) / c.wavelength_um;
    const betaError = Math.abs(result.beta_per_um - betaExpected) / Math.abs(betaExpected);
    const checks = [
      evaluation(
        'propagation_units',
        betaError <= 1e-12,
        betaError,
        [experiment.id],
        'Propagation constant is consistent with neff and wavelength units.',
      ),
      evaluation(
        'guiding_bounds',
        result.effective_index > c.background_index && result.effective_index < nmax,
        result.effective_index,
        [experiment.id],
        'Bounded propagation constant for the declared lossless dielectric model.',
      ),
      evaluation(
        'eigen_residual',
        result.diagnostics.relative_residual <= 1e-8,
        result.diagnostics.relative_residual,
        [experiment.id],
        'Independent algebraic or dispersion residual.',
      ),
    ];
    if (experiment.operation === 'mode_planar_te') {
      const cells =
        Math.min(...c.layers.map((l) => l.thickness_um)) / result.diagnostics.actual_grid_step_um;
      checks.push(
        evaluation(
          'sampling',
          cells >= 20,
          cells,
          [experiment.id],
          'At least 20 cells span the thinnest core.',
        ),
      );
    }
    return checks;
  },
  assess(goal, evidence) {
    const ids = [
      'baseline',
      'analytic_reference',
      'refined_grid',
      'fine_grid',
      'expanded_domain',
      'confirmed_domain',
      'repeat',
    ];
    const [b, a, r, f, d, c, p] = ids.map((id) => get(evidence, id));
    const value = (e: Evidence | undefined) => e?.result?.effective_index;
    const checks: Evaluation[] = [];
    const compare = (id: string, x: Evidence | undefined, y: Evidence | undefined, tol: number) => {
      const ids = [x?.experiment.id ?? 'missing', y?.experiment.id ?? 'missing'];
      if (x?.result && y?.result) {
        const delta = Math.abs(value(x)! - value(y)!);
        checks.push(
          evaluation(id, delta <= tol, delta, ids, `Absolute neff difference must be <= ${tol}.`),
        );
      } else
        checks.push({
          criterion_id: id,
          status: 'not_evaluated',
          value: null,
          evidence_ids: ids,
          detail: 'Required experiment evidence is missing or failed.',
        });
    };
    compare('grid_convergence', r, f, 1e-4);
    compare('domain_convergence', d, c, 1e-5);
    compare('reference_agreement', c, a, 1e-4);
    compare('reproducibility', c, p, 1e-12);
    const baselineError = b?.result && a?.result ? Math.abs(value(b)! - value(a)!) : null;
    const baselineVerified =
      !!b?.result &&
      !!a?.result &&
      a.checks.every((x) => x.status === 'pass') &&
      b.checks.every((x) => x.status === 'pass') &&
      baselineError !== null &&
      baselineError <= 1e-4;
    const complete = checks.every((x) => x.status !== 'not_evaluated');
    const acceptable =
      complete &&
      checks.every((x) => x.status === 'pass') &&
      [a, r, f, d, c, p].every((e) => e?.result && e.checks.every((x) => x.status === 'pass'));
    const hypotheses: Hypothesis[] = [];
    const assess = (
      cause: Hypothesis['cause'],
      statement: string,
      source: Hypothesis['source'] = 'deterministic_physics',
      suffix = '',
    ) => {
      let status: Hypothesis['status'] = 'inconclusive',
        explanation = 'Insufficient independent experiment evidence.',
        evidenceIDs: string[] = [];
      if (cause === 'discretization_error' && b?.result && r?.result && f?.result) {
        const change = Math.abs(value(b)! - value(f)!);
        status =
          change > 1e-4 && Math.abs(value(r)! - value(f)!) < change ? 'supported' : 'contradicted';
        explanation = `Grid refinement changed neff by ${change}; residual stability alone does not establish discretization accuracy.`;
        evidenceIDs = ['baseline', 'refined_grid', 'fine_grid'];
      }
      if (cause === 'boundary_truncation' && f?.result && d?.result && c?.result) {
        const shift = Math.abs(value(f)! - value(c)!);
        status =
          shift > 1e-5 && Math.abs(value(d)! - value(c)!) < shift ? 'supported' : 'contradicted';
        explanation = `Domain expansion changed neff by ${shift}; the confirmation run separates truncation effects from solver residual.`;
        evidenceIDs = ['fine_grid', 'expanded_domain', 'confirmed_domain'];
      }
      if (cause === 'non_reproducibility' && c?.result && p?.result) {
        const delta = Math.abs(value(c)! - value(p)!);
        status = delta > 1e-12 ? 'supported' : 'contradicted';
        explanation = `Identical input reproduced neff with absolute difference ${delta}.`;
        evidenceIDs = ['confirmed_domain', 'repeat'];
      }
      if (cause === 'reference_disagreement' && c?.result && a?.result) {
        const delta = Math.abs(value(c)! - value(a)!);
        status = delta > 1e-4 ? 'supported' : 'contradicted';
        explanation = `Independent dispersion equation differs from the final eigenmode calculation by ${delta}.`;
        evidenceIDs = ['confirmed_domain', 'analytic_reference'];
      }
      hypotheses.push({
        id: cause + suffix,
        source,
        statement,
        cause,
        status,
        evidence_ids: evidenceIDs,
        explanation,
      });
    };
    assess(
      'discretization_error',
      'Insufficient spatial resolution is biasing the baseline effective index.',
    );
    assess(
      'boundary_truncation',
      'A finite computational boundary is truncating the evanescent mode tail.',
    );
    assess(
      'non_reproducibility',
      'The solver result is not reproducible under identical numerical inputs.',
    );
    assess(
      'reference_disagreement',
      'The converged numerical model disagrees with an independent physical reference.',
    );
    goal.reasoning_proposals.forEach((proposal, i) =>
      assess(proposal.cause, proposal.claim, 'external_llm', `_llm_${i}`),
    );
    const status = !complete
      ? 'inconclusive'
      : acceptable
        ? baselineVerified
          ? 'accepted'
          : 'improved'
        : 'rejected';
    return {
      status,
      baseline_verified: baselineVerified,
      accepted_configuration: acceptable ? c!.experiment.configuration : null,
      checks,
      hypotheses,
      reasoning: [
        {
          kind: 'physical_principle',
          statement:
            'A lossless bound TE mode must have its effective index between background and core indices. Small algebraic residual does not imply spatial or boundary convergence.',
          evidence_ids: [],
        },
        ...goal.reasoning_proposals.map((proposal) => ({
          kind: 'llm_proposal' as const,
          statement:
            proposal.claim +
            ' Reasoning: ' +
            proposal.rationale +
            ' This claim is not numerical proof.',
          evidence_ids: [],
        })),
        {
          kind: 'numerical_evidence',
          statement:
            'SciPy eigenmode calculations and the independent dispersion relation provide separate numerical evidence.',
          evidence_ids: evidence.filter((e) => e.result).map((e) => e.experiment.id),
        },
        {
          kind: 'deterministic_verification',
          statement:
            'Predeclared physical, convergence, reference and repeatability thresholds determine the verdict.',
          evidence_ids: ids,
        },
        {
          kind: 'engineering_judgment',
          statement: `Evidence-based outcome: ${status}. ${baselineVerified ? 'The submitted baseline meets its checks.' : 'The submitted baseline is not accepted as verified.'}`,
          evidence_ids: ids.filter((id) => get(evidence, id)?.result),
        },
      ],
    };
  },
};
