"""Independent spectral checks on exported responses, without SAX models or device formulas."""

import numpy as np
from scipy.signal import find_peaks

from agentpic.circuit_reference import circuit_reference
from agentpic.ir import CheckResult, EngineeringIR

# Linear interpolation of a unit-height Lorentzian sampled 20 times per half-maximum width
# errs by about 1/20² at its peak; this bound therefore demands that resolution everywhere.
INTERPOLATION_TOLERANCE = 1 / 400


def sampling_adequacy(
    ir: EngineeringIR, wavelength_nm: np.ndarray, matrix: np.ndarray
) -> CheckResult:
    """Compare midpoint interpolation of exported powers with the independent reference."""
    midpoints = (wavelength_nm[1:] + wavelength_nm[:-1]) / 2
    exact = np.abs(circuit_reference(ir, midpoints)) ** 2
    power = np.abs(matrix) ** 2
    error = np.abs((power[1:] + power[:-1]) / 2 - exact)
    k, i, j = np.unravel_index(int(np.argmax(error)), error.shape)
    worst = float(error[k, i, j])
    ports = ir.specification.port_order
    return CheckResult(
        id="spectral_sampling",
        status="pass" if worst <= INTERPOLATION_TOLERANCE else "fail",
        detail="Linear interpolation between exported samples matches the independent reference at every midpoint; sampled-value agreement alone is insufficient.",
        evidence={
            "maximum_interpolation_error": worst,
            "tolerance": INTERPOLATION_TOLERANCE,
            "worst_wavelength_nm": float(midpoints[k]),
            "worst_output_port": ports[i],
            "worst_input_port": ports[j],
        },
    )


def measure_resonances(
    wavelength_nm: np.ndarray, power: np.ndarray, min_count: int
) -> tuple[bool, dict]:
    """Peaks whose half-maximum crossings both lie inside the sampled window."""
    peaks, _ = find_peaks(power, prominence=0.1 * float(np.ptp(power)))
    centers, widths = [], []
    for peak in peaks:
        level = power[peak] / 2
        left = right = int(peak)
        while left > 0 and power[left] > level:
            left -= 1
        while right < len(power) - 1 and power[right] > level:
            right += 1
        if power[left] > level or power[right] > level:
            continue
        lo = wavelength_nm[left] + (level - power[left]) * (
            wavelength_nm[left + 1] - wavelength_nm[left]
        ) / (power[left + 1] - power[left])
        hi = wavelength_nm[right - 1] + (level - power[right - 1]) * (
            wavelength_nm[right] - wavelength_nm[right - 1]
        ) / (power[right] - power[right - 1])
        centers.append(float(wavelength_nm[peak]))
        widths.append(float(hi - lo))
    return len(centers) >= min_count, {
        "resonances_nm": centers,
        "half_maximum_widths_nm": widths,
        "spacing_nm": np.diff(centers).tolist(),
        "loaded_q_ideal_model": [c / w for c, w in zip(centers, widths, strict=True)],
        "peak_powers": [float(power[np.argmin(abs(wavelength_nm - c))]) for c in centers],
        "required_count": min_count,
    }


def verify_measurements(
    ir: EngineeringIR, wavelength_nm: np.ndarray, matrix: np.ndarray
) -> list[CheckResult]:
    ports = list(ir.specification.port_order)
    checks = []
    for m in ir.specification.measurements:
        power = np.abs(matrix[:, ports.index(m.output_port), ports.index(m.input_port)]) ** 2
        ok, evidence = measure_resonances(wavelength_nm, power, m.min_count)
        checks.append(
            CheckResult(
                id=f"resonances_{m.input_port}_to_{m.output_port}",
                status="pass" if ok else "fail",
                detail="Enough complete resonances lie inside the window; metrics describe the ideal compact model.",
                evidence=evidence,
            )
        )
    return checks
