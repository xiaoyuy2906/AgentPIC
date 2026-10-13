"""Planar TE operator adapter using SciPy/LAPACK, with an independent dispersion benchmark.

No FDTD implementation: the adapter assembles a 1D Helmholtz operator and uses
established SciPy eigensolvers/root finding. Layer geometry is cell averaged.
"""

from __future__ import annotations

import time

import numpy as np
from scipy.linalg import eigh_tridiagonal
from scipy.optimize import brentq

from agentpic.ir import PhysicalResult, PhysicsConfiguration


def solve(configuration: PhysicsConfiguration, *, reference: bool = False) -> PhysicalResult:
    tick = time.perf_counter()
    c = configuration
    if c.model_kind != "layered_dielectric" or c.polarization != "TE":
        raise ValueError("Planar adapter supports propagation-invariant isotropic TE layers only")
    widths = np.array([layer.thickness_um for layer in c.layers], dtype=float)
    indices = np.array([layer.refractive_index for layer in c.layers], dtype=float)
    if not np.all(indices > c.background_index):
        raise ValueError("This guided-mode benchmark requires layers above the background index")
    k0 = 2 * np.pi / c.wavelength_um
    if reference:
        if len(widths) != 1:
            raise NotImplementedError(
                "Independent analytic reference currently supports one symmetric layer"
            )
        a = widths[0] / 2
        v = k0 * a * np.sqrt(indices[0] ** 2 - c.background_index**2)
        upper = min(v, np.pi / 2) * (1 - 1e-12)

        def equation(u: float) -> float:
            return float(u * np.tan(u) - np.sqrt(max(v * v - u * u, 0)))

        u = brentq(equation, 1e-14, upper, xtol=1e-14, rtol=1e-14)
        beta = np.sqrt((k0 * indices[0]) ** 2 - (u / a) ** 2)
        x = np.linspace(-a - c.padding_um, a + c.padding_um, 401)
        field = np.where(
            np.abs(x) <= a,
            np.cos(u * x / a),
            np.cos(u)
            * np.exp(-np.sqrt(beta**2 - (k0 * c.background_index) ** 2) * (np.abs(x) - a)),
        )
        residual = abs(equation(u)) / max(v, 1)
        step = float(x[1] - x[0])
        method = "symmetric_TE_dispersion_brentq"
    else:
        span = float(widths.sum() + 2 * c.padding_um)
        intervals = int(np.ceil(span / c.grid_step_um - 1e-10))
        points = intervals - 1
        if points < 3 or points > c.max_points:
            raise ValueError(f"Requested {points} grid points exceeds limits [3, {c.max_points}]")
        step = span / intervals
        x = -span / 2 + step * np.arange(1, intervals)
        epsilon = np.full(points, c.background_index**2)
        left = -float(widths.sum()) / 2
        for width, index in zip(widths, indices, strict=True):
            right = left + width
            fraction = (
                np.maximum(0, np.minimum(x + step / 2, right) - np.maximum(x - step / 2, left))
                / step
            )
            epsilon += fraction * (index**2 - c.background_index**2)
            left = right
        diagonal = k0**2 * epsilon - 2 / step**2
        off_diagonal = np.full(points - 1, 1 / step**2)
        values, vectors = eigh_tridiagonal(
            diagonal,
            off_diagonal,
            select="i",
            select_range=(points - 1, points - 1),
            lapack_driver="stebz",
        )
        eigenvalue = values[0]
        if eigenvalue <= 0:
            raise ValueError("No positive propagation eigenvalue; check model and domain")
        beta = np.sqrt(eigenvalue)
        field = vectors[:, 0]
        field *= np.sign(field[np.argmax(np.abs(field))])
        field /= np.max(np.abs(field))
        applied = diagonal * field
        applied[:-1] += off_diagonal * field[1:]
        applied[1:] += off_diagonal * field[:-1]
        residual = np.linalg.norm(applied - eigenvalue * field) / (
            abs(eigenvalue) * np.linalg.norm(field)
        )
        method = "cell_averaged_1D_TE_Helmholtz_scipy_eigh_tridiagonal"
    return PhysicalResult.model_validate(
        {
            "backend": "scipy",
            "method": method,
            "effective_index": float(beta / k0),
            "beta_per_um": float(beta),
            "units": {
                "effective_index": "1",
                "beta_per_um": "um^-1",
                "coordinates": "um",
                "field": "arbitrary_normalized",
            },
            "x_um": x.tolist(),
            "field_amplitude": field.tolist(),
            "diagnostics": {
                "grid_points": len(x),
                "actual_grid_step_um": step,
                "relative_residual": float(residual),
                "edge_amplitude_ratio": float(max(abs(field[0]), abs(field[-1])) / max(abs(field))),
                "elapsed_seconds": time.perf_counter() - tick,
                "estimated_array_bytes": int(len(x) * 8 * 8),
            },
        }
    )
