"""Bounded local search using SciPy and a reusable SAX model, with an exact call budget."""

import numpy as np
from scipy.optimize import least_squares

from agentpic.backends.circuit import build_circuit
from agentpic.ir import EngineeringIR, ResolvedTuningVariable, TuningResult


class BudgetExhausted(Exception):
    pass


class TargetMet(Exception):
    pass


def optimize(ir: EngineeringIR, variables: list[ResolvedTuningVariable]) -> TuningResult:
    request = ir.specification.tuning
    if request is None or not variables or ir.operating_point is not None:
        raise ValueError("Optimization requires an unresolved tuning request and phase variables")
    model, ports = build_circuit(ir)
    names = [v.instance for v in variables]
    lower = np.array([v.min_phase_rad for v in variables])
    upper = np.array([v.max_phase_rad for v in variables])
    instances = {i.name: i for i in ir.netlist.instances}
    initial = np.array([instances[name].phase_control.phase_rad for name in names])
    if np.any(lower >= upper) or np.any(initial < lower) or np.any(initial > upper):
        raise ValueError("Invalid phase bounds or initial controls")
    wavelengths = np.array([t.wavelength_nm for t in request.targets]) / 1000
    wanted = np.array([t.power for t in request.targets])
    if any(t.input_port not in ports or t.output_port not in ports for t in request.targets):
        raise ValueError("Targets must use external optical ports")
    trace = []

    def residual(x):
        if len(trace) >= request.max_evaluations:
            raise BudgetExhausted
        if not np.all(np.isfinite(x)) or np.any(x < lower) or np.any(x > upper):
            raise ValueError("Optimizer produced invalid controls")
        controls = dict(zip(names, map(float, x), strict=True))
        scattering = model(wl=wavelengths, **{n: {"phase_rad": v} for n, v in controls.items()})
        powers = np.array(
            [
                abs(
                    np.asarray(
                        scattering.get((t.output_port, t.input_port), np.zeros(len(wavelengths)))
                    )[i]
                )
                ** 2
                for i, t in enumerate(request.targets)
            ]
        )
        if not np.all(np.isfinite(powers)):
            raise ValueError("Nonfinite SAX response during tuning")
        trace.append({"controls": controls, "powers": powers.tolist()})
        errors = powers - wanted
        if np.max(np.abs(errors)) <= request.power_tolerance:
            raise TargetMet
        return errors

    status = "target_not_met"
    reason = "Deterministic local searches terminated without meeting all targets; infeasibility is not proven."
    try:
        # Boundary/midpoint probes cover common switching states. Interior starts avoid
        # stationary initial settings; each probe and numerical Jacobian call is counted.
        starts = [initial, lower, upper, (lower + upper) / 2]
        for seed in range(1, 5):
            fractions = (seed * np.sqrt(np.array([2, 3, 5, 7][: len(names)]))) % 1
            starts.append(lower + fractions * (upper - lower))
        for x in starts:
            residual(x)
        ranked = sorted(trace, key=lambda c: float(np.max(np.abs(np.array(c["powers"]) - wanted))))
        for candidate in ranked:
            x0 = np.array([candidate["controls"][n] for n in names])
            least_squares(
                residual,
                x0,
                bounds=(lower, upper),
                method="trf",
                jac="3-point",
                ftol=1e-12,
                xtol=1e-12,
                gtol=1e-12,
                max_nfev=32,
            )
    except TargetMet:
        status = "target_met"
        reason = "An evaluated candidate meets every requested absolute power tolerance."
    except BudgetExhausted:
        status = "budget_exhausted"
        reason = "Hard network-evaluation budget reached, including numerical Jacobian probes."
    if status != "target_met" and len(trace) == request.max_evaluations:
        status = "budget_exhausted"
        reason = "Hard network-evaluation budget reached, including numerical Jacobian probes."
    best = min(trace, key=lambda c: float(np.max(np.abs(np.array(c["powers"]) - wanted))))
    return TuningResult.model_validate(
        {
            "backend": "scipy_least_squares+sax",
            "status": status,
            "controls": best["controls"],
            "predicted_powers": best["powers"],
            "maximum_error": float(np.max(np.abs(np.array(best["powers"]) - wanted))),
            "evaluations": len(trace),
            "evaluation_trace": trace,
            "termination_reason": reason,
        }
    )
