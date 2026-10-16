import { check, canonical, semanticChecks } from './compiler.js';
import { applyOperatingPoint, resolveVariables, sampleIndex, validateControls } from './tuning.js';
import type { EngineeringIR, TuningResult, SimulationResult, CheckResult } from './contracts.js';

/** Engineering acceptance reads the final exported complex response, never a solver success flag. */
export function verifyTuning(
  ir: EngineeringIR,
  before: EngineeringIR,
  result: TuningResult,
  simulation: SimulationResult,
): CheckResult[] {
  const checks: CheckResult[] = [];
  const request = ir.specification.tuning;
  try {
    if (!request) throw new Error('No target request');
    const variables = resolveVariables(before);
    validateControls(variables, result.controls);
    checks.push(
      check(
        'tuning_state_preservation',
        before.operating_point === null &&
          semanticChecks(before).every((c) => c.status !== 'fail') &&
          canonical(applyOperatingPoint(before, result.controls)) === canonical(ir),
        'Only selected optical phases and the operating point changed from the preserved pre-tuning IR.',
      ),
    );
    let traceValid =
      result.evaluations === result.evaluation_trace.length &&
      result.evaluations <= request.max_evaluations;
    const errors: number[] = [];
    for (const candidate of result.evaluation_trace) {
      validateControls(variables, candidate.controls);
      traceValid &&= candidate.powers.length === request.targets.length;
      errors.push(
        Math.max(...request.targets.map((t, i) => Math.abs(candidate.powers[i] - t.power))),
      );
    }
    const selected = result.evaluation_trace.find(
      (c) =>
        canonical(c.controls) === canonical(result.controls) &&
        canonical(c.powers) === canonical(result.predicted_powers),
    );
    const best = Math.min(...errors);
    const expectedStatus =
      best <= request.power_tolerance
        ? 'target_met'
        : result.evaluations === request.max_evaluations
          ? 'budget_exhausted'
          : 'target_not_met';
    checks.push(
      check(
        'tuning_search_evidence',
        traceValid &&
          !!selected &&
          result.predicted_powers.length === request.targets.length &&
          Math.abs(best - result.maximum_error) <= 1e-12 &&
          Math.abs(
            Math.max(
              ...request.targets.map((t, i) => Math.abs(result.predicted_powers[i] - t.power)),
            ) - best,
          ) <= 1e-12 &&
          result.status === expectedStatus,
        'Recorded selection, candidate bounds, evaluation count, residual and termination agree.',
        {
          evaluations: result.evaluations,
          budget: request.max_evaluations,
          search_status: result.status,
        },
      ),
    );
    const powers = request.targets.map((t) => {
      const index = sampleIndex(ir, t.wavelength_nm);
      if (Math.abs(simulation.wavelength_nm[index] - t.wavelength_nm) > 1e-9)
        throw new Error('Final spectrum target grid mismatch');
      const out = simulation.ports.indexOf(t.output_port),
        input = simulation.ports.indexOf(t.input_port);
      const real = simulation.s_real[index]?.[out]?.[input],
        imag = simulation.s_imag[index]?.[out]?.[input];
      if (!Number.isFinite(real) || !Number.isFinite(imag))
        throw new Error('Missing target S-matrix entry');
      return real ** 2 + imag ** 2;
    });
    const maximumError = Math.max(...powers.map((p, i) => Math.abs(p - request.targets[i].power)));
    checks.push(
      check(
        'tuning_prediction_agreement',
        powers.every((p, i) => Math.abs(p - result.predicted_powers[i]) < 1e-9),
        'Optimizer predictions agree with independently exported final S-matrix powers.',
      ),
    );
    checks.push(
      check(
        'optical_targets',
        maximumError <= request.power_tolerance && result.status === 'target_met',
        'All target powers must meet the requested absolute tolerance; unsuccessful search does not prove infeasibility.',
        {
          achieved_powers: powers,
          maximum_error: maximumError,
          tolerance: request.power_tolerance,
          length_source: ir.length_source,
        },
      ),
    );
  } catch (error) {
    checks.push(check('tuning_evidence_validation', false, String(error)));
  }
  return checks;
}
