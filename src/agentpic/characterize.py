"""Characterize a PDK cross-section's mode model with FDTDX and record the evidence.

    uv run --group em python -m agentpic.characterize sin_demo_v1 strip [--write]

The method is validated before it is trusted: the same pipeline runs on a symmetric slab of
the same materials and must reproduce the existing analytic slab dispersion solution. The
channel guide is then simulated at three grids per wavelength, Richardson-extrapolated with
the observed convergence order, and differenced across wavelengths for the group index.
Material indices come from the PDK's Sellmeier data at each wavelength, so material
dispersion enters the group index. Results are simulations, not measurements: the source
is recorded as an uncalibrated characterization.
"""

from __future__ import annotations

import argparse
import json
import math
from importlib.metadata import version
from pathlib import Path

from scipy.optimize import brentq

from agentpic.backends.fdtd import propagation_index
from agentpic.backends.planar_modes import solve
from agentpic.ir import PhysicsConfiguration

ROOT = Path(__file__).resolve().parents[2]
GRIDS_UM = (0.05, 0.04, 0.025)
WAVELENGTH_OFFSETS_UM = (-0.05, 0.0, 0.05)
# The slab check bounds the method error after extrapolation. 1e-3 (0.06 %) is below the
# index shift of a 10 nm width change; three grids down to 25 nm reach about 8e-4 because
# interface staircasing keeps convergence pre-asymptotic (observed order near 1.7).
CRITERIA = {
    "slab_validation_error": 1e-3,
    "phase_residual_rad": 0.05,
    "amplitude_spread": 0.1,
    "observed_order": (1.0, 3.0),
    "richardson_correction": 0.01,
}


def evidence_path(pdk: str, section: str) -> Path:
    return ROOT / "pdks" / f"{pdk}.{section}.characterization.json"


def sellmeier(material: dict, wavelength_um: float) -> float:
    w2 = wavelength_um**2
    return math.sqrt(1 + sum(t["b"] * w2 / (w2 - t["c_um"] ** 2) for t in material["terms"]))


def richardson(grids: tuple[float, ...], values: list[float]) -> dict:
    """Extrapolate three grid results to zero spacing with the observed order of convergence."""
    (h1, h2, h3), (n1, n2, n3) = grids, values
    ratio = (n1 - n2) / (n2 - n3)

    def mismatch(p: float) -> float:
        return (h1**p - h2**p) / (h2**p - h3**p) - ratio

    try:
        order = brentq(mismatch, 0.25, 6.0)
    except ValueError:
        order = float("nan")
    scale = (n2 - n3) / (h2**order - h3**order)
    limit = n3 - scale * h3**order
    return {"observed_order": order, "extrapolated": limit, "correction": n3 - limit}


def slab_reference(wavelength_um: float, core: float, cladding: float, thickness: float) -> float:
    configuration = PhysicsConfiguration(
        model_kind="layered_dielectric",
        wavelength_um=wavelength_um,
        polarization="TE",
        layers=[{"thickness_um": thickness, "refractive_index": core}],
        background_index=cladding,
        grid_step_um=0.01,
        padding_um=2.0,
        max_points=12000,
    )
    return solve(configuration, reference=True).effective_index


def characterize(pdk: dict, section_name: str) -> dict:
    section = pdk["cross_sections"][section_name]
    mode = section["mode"]
    core, cladding = (pdk["materials"][section[k]] for k in ("core_material", "cladding_material"))
    width, thickness = section["width_um"], section["thickness_um"]
    centre = mode["reference_wavelength_um"]
    runs, checks = [], []

    def indices(wl: float) -> tuple[float, float]:
        return sellmeier(core, wl), sellmeier(cladding, wl)

    def converge(label: str, wl: float, guide_width: float | None) -> dict:
        n_core, n_clad = indices(wl)
        found = [
            propagation_index(wl, n_core, n_clad, guide_width, thickness, grid) for grid in GRIDS_UM
        ]
        runs.extend({"case": label, **run} for run in found)
        fit = richardson(GRIDS_UM, [run["effective_index"] for run in found])
        checks.append(
            {
                "case": label,
                "observed_order": fit["observed_order"],
                "richardson_correction": fit["correction"],
                "worst_phase_residual_rad": max(r["phase_residual_rad"] for r in found),
                "worst_amplitude_spread": max(r["amplitude_spread"] for r in found),
            }
        )
        return {"wavelength_um": wl, "core_index": n_core, "cladding_index": n_clad, **fit}

    slab = converge("slab_validation", centre, None)
    analytic = slab_reference(centre, slab["core_index"], slab["cladding_index"], thickness)
    channel = [converge("channel", centre + d, width) for d in WAVELENGTH_OFFSETS_UM]
    low, mid, high = channel
    group_index = mid["extrapolated"] - centre * (high["extrapolated"] - low["extrapolated"]) / (
        high["wavelength_um"] - low["wavelength_um"]
    )
    lo, hi = CRITERIA["observed_order"]
    passed = {
        "slab_validation": abs(slab["extrapolated"] - analytic)
        <= CRITERIA["slab_validation_error"],
        "convergence_order": all(lo <= c["observed_order"] <= hi for c in checks),
        "richardson_correction": all(
            abs(c["richardson_correction"]) <= CRITERIA["richardson_correction"] for c in checks
        ),
        "phase_residual": all(
            c["worst_phase_residual_rad"] <= CRITERIA["phase_residual_rad"] for c in checks
        ),
        "amplitude_spread": all(
            c["worst_amplitude_spread"] <= CRITERIA["amplitude_spread"] for c in checks
        ),
    }
    return {
        "schema_version": "1.0",
        "pdk": pdk["name"],
        "cross_section": section_name,
        "method": (
            "FDTDX continuous-wave time-domain propagation; effective index from the phase of "
            "cross-section field projections; three grids per wavelength with Richardson "
            "extrapolation at the observed order; group index by central difference."
        ),
        "versions": {name: version(name) for name in ("fdtdx", "jax", "numpy", "scipy")},
        "grids_um": list(GRIDS_UM),
        "criteria": CRITERIA,
        "validation": {
            "case": "symmetric slab, TE, same materials and thickness",
            "analytic_effective_index": analytic,
            "fdtd_extrapolated_effective_index": slab["extrapolated"],
            "error": slab["extrapolated"] - analytic,
        },
        "convergence": checks,
        "channel": channel,
        "mode": {
            "reference_wavelength_um": centre,
            "effective_index": round(mid["extrapolated"], 5),
            "group_index": round(group_index, 4),
        },
        "passed": passed,
        "accepted": all(passed.values()),
        "runs": runs,
    }


def write_pdk(pdk_file: Path, section_name: str, evidence: dict) -> None:
    pdk = json.loads(pdk_file.read_text())
    mode = pdk["cross_sections"][section_name]["mode"]
    mode["effective_index"] = evidence["mode"]["effective_index"]
    mode["group_index"] = evidence["mode"]["group_index"]
    mode["source"] = {
        "kind": "characterization",
        "reference": (
            f"FDTDX {evidence['versions']['fdtdx']} time-domain characterization of this "
            "cross-section from the PDK Sellmeier materials; method validated on the analytic "
            "slab. A simulation, not a measurement."
        ),
        "calibrated": False,
        "evidence": str(evidence_path(pdk["name"], section_name).relative_to(ROOT)),
    }
    pdk_file.write_text(json.dumps(pdk, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdk")
    parser.add_argument("cross_section")
    parser.add_argument("--write", action="store_true", help="update the PDK mode model")
    args = parser.parse_args()
    pdk_file = ROOT / "pdks" / f"{args.pdk}.json"
    evidence = characterize(json.loads(pdk_file.read_text()), args.cross_section)
    target = evidence_path(args.pdk, args.cross_section)
    target.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({k: evidence[k] for k in ("mode", "validation", "passed", "accepted")}))
    if not evidence["accepted"]:
        raise SystemExit("Characterization failed its acceptance criteria; PDK left unchanged")
    if args.write:
        write_pdk(pdk_file, args.cross_section, evidence)


if __name__ == "__main__":
    main()
