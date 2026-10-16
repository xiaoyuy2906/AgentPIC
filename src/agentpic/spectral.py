"""Independent resonance feature checks on exported spectra, without SAX models."""

import numpy as np
from scipy.signal import find_peaks

from agentpic.ir import CheckResult, EngineeringIR


def verify_ring_spectrum(
    ir: EngineeringIR, wavelength_nm: np.ndarray, drop: np.ndarray
) -> list[CheckResult]:
    tech = ir.technology
    length = sum(i.length_um for i in ir.netlist.instances if i.kind != "ideal_coupler")
    phase = sum(
        i.phase_control.phase_rad for i in ir.netlist.instances if i.phase_control is not None
    )
    ratios = [i.coupling_ratio for i in ir.netlist.instances if i.kind == "ideal_coupler"]
    rho = np.sqrt((1 - ratios[0]) * (1 - ratios[1]))
    # Round-trip phase / 2π = A / wavelength_um + B for the declared linear dispersion.
    a = tech.group_index * length + phase * tech.reference_wavelength_um / (2 * np.pi)
    b = (tech.effective_index - tech.group_index) * length / tech.reference_wavelength_um
    wl = wavelength_nm / 1000
    phase_steps = abs(np.diff(2 * np.pi * (a / wl + b)))
    half_phase_width = 2 * np.arcsin((1 - rho) / (2 * np.sqrt(rho)))
    samples = float(2 * half_phase_width / np.max(phase_steps))
    orders = np.arange(np.ceil(a / wl[-1] + b), np.floor(a / wl[0] + b) + 1)[::-1]
    centers = 1000 * a / (orders - b)
    low = 1000 * a / (orders - b + half_phase_width / (2 * np.pi))
    high = 1000 * a / (orders - b - half_phase_width / (2 * np.pi))
    full = (low >= wavelength_nm[0]) & (high <= wavelength_nm[-1])
    centers, widths = centers[full], (high - low)[full]
    peaks, _ = find_peaks(drop)
    observed, measured_widths, chosen = [], [], []
    for center in centers:
        if not len(peaks):
            break
        peak = int(peaks[np.argmin(abs(wavelength_nm[peaks] - center))])
        level = drop[peak] / 2
        left = right = peak
        while left > 0 and drop[left] > level:
            left -= 1
        while right < len(drop) - 1 and drop[right] > level:
            right += 1
        if left == peak or right == peak or drop[left] > level or drop[right] > level:
            break
        lo = wavelength_nm[left] + (level - drop[left]) * (
            wavelength_nm[left + 1] - wavelength_nm[left]
        ) / (drop[left + 1] - drop[left])
        hi = wavelength_nm[right - 1] + (level - drop[right - 1]) * (
            wavelength_nm[right] - wavelength_nm[right - 1]
        ) / (drop[right] - drop[right - 1])
        chosen.append(peak)
        observed.append(float(wavelength_nm[peak]))
        measured_widths.append(float(hi - lo))
    complete = (
        len(observed) == len(centers) and len(observed) >= 2 and len(set(chosen)) == len(chosen)
    )
    step = float(np.max(np.diff(wavelength_nm)))
    peak_error = float(np.max(abs(np.array(observed) - centers))) if complete else None
    spacing_error = float(np.max(abs(np.diff(observed) - np.diff(centers)))) if complete else None
    width_error = float(np.max(abs(np.array(measured_widths) - widths))) if complete else None
    features_ok = (
        complete and peak_error <= step and spacing_error <= 2 * step and width_error <= 2 * step
    )
    return [
        CheckResult(
            id="resonance_sampling",
            status="pass" if samples >= 20 else "fail",
            detail="At least 20 spectral samples resolve each theoretical half-maximum linewidth; sampled-value agreement alone is insufficient.",
            evidence={"minimum_samples_per_linewidth": samples, "required_samples": 20},
        ),
        CheckResult(
            id="resonance_features",
            status="pass" if features_ok else "fail",
            detail="At least two complete drop resonances have matching wavelength, spacing and half-maximum width; all metrics describe the ideal compact model.",
            evidence={
                "expected_resonances_nm": centers.tolist(),
                "observed_resonances_nm": observed,
                "expected_linewidths_nm": widths.tolist(),
                "observed_linewidths_nm": measured_widths,
                "observed_spacing_nm": np.diff(observed).tolist(),
                "loaded_q_ideal_model": [
                    w / width for w, width in zip(observed, measured_widths, strict=True)
                ],
                "maximum_peak_error_nm": peak_error,
                "maximum_spacing_error_nm": spacing_error,
                "maximum_linewidth_error_nm": width_error,
                "grid_step_nm": step,
                "modeled_round_trip_length_um": length,
            },
        ),
    ]
