"""FDTDX adapter: effective index from time-domain propagation phase.

Only FDTDX's FDTD time stepping, a uniform plane source and a phasor detector are used. Its
mode sources, mode detectors and mode solver are backed by tidy3d, which AgentPIC never calls.

A continuous wave is launched into a straight guide. After the field settles, the field on
each cross-section inside a detector box is projected onto the field of the last
cross-section. The projection phase advances by β per unit length; radiation and reflections
only perturb it, and the fit residual and amplitude spread report how much.
"""

from __future__ import annotations

import math
import time

import numpy as np

C = 299792458.0


def propagation_index(
    wavelength_um: float,
    core_index: float,
    cladding_index: float,
    width_um: float | None,
    thickness_um: float,
    grid_um: float,
    *,
    length_um: float = 7.0,
    span_um: float = 4.0,
    pml_cells: int = 12,
) -> dict:
    """Effective index of a channel guide, or of a slab when `width_um` is None."""
    import fdtdx
    import jax
    import jax.numpy as jnp

    slab = width_um is None
    um = 1e-6
    grid = grid_um * um
    wavelength = wavelength_um * um
    # A slab is invariant along y: a few periodic cells stand for the infinite width.
    y_len = 8 * grid if slab else (width_um + 2.6) * um
    z_len = (thickness_um + 2.6) * um
    pad = 2 * pml_cells * grid
    period = wavelength / C
    # Wait for the wave to cross the domain (group index well below 2.5) and settle, then
    # accumulate the phasor over a whole number of periods.
    start = length_um * um * 2.5 / C + 6 * period
    config = fdtdx.SimulationConfig(
        time=start + 12 * period,
        grid=fdtdx.UniformGrid(spacing=grid),
        dtype=jnp.float32,
        courant_factor=0.99,
    )
    volume = fdtdx.SimulationVolume(
        partial_real_shape=(length_um * um + pad, y_len + (0 if slab else pad), z_len + pad),
        material=fdtdx.Material(permittivity=cladding_index**2),
    )
    boundary = fdtdx.BoundaryConfig.from_uniform_bound(
        thickness=pml_cells,
        boundary_type="pml",
        override_types={"min_y": "periodic", "max_y": "periodic"} if slab else None,
    )
    boundaries, constraints = fdtdx.boundary_objects_from_config(boundary, volume)
    cross_section = (None, None if slab else width_um * um, thickness_um * um)
    core = fdtdx.UniformMaterialObject(
        name="core",
        partial_real_shape=cross_section,
        material=fdtdx.Material(permittivity=core_index**2),
    )
    source = fdtdx.UniformPlaneSource(
        name="source",
        partial_grid_shape=(1, None, None),
        partial_real_shape=cross_section,
        fixed_E_polarization_vector=(0, 1, 0),
        wave_character=fdtdx.WaveCharacter(wavelength=wavelength),
        direction="+",
    )
    detector = fdtdx.PhasorDetector(
        name="field",
        partial_real_shape=(span_um * um, y_len, z_len),
        wave_characters=(fdtdx.WaveCharacter(wavelength=wavelength),),
        components=("Ey",),
        switch=fdtdx.OnOffSwitch(start_time=start),
    )
    gap = (length_um - span_um) / 2 * um
    constraints += [
        core.place_at_center(volume, axes=(1, 2)),
        source.place_at_center(volume, axes=(1, 2)),
        source.place_relative_to(
            volume, axes=0, own_positions=0, other_positions=0, margins=-(length_um / 2 - 0.5) * um
        ),
        detector.place_at_center(volume, axes=(1, 2)),
        detector.place_relative_to(
            volume, axes=0, own_positions=0, other_positions=0, margins=gap - 0.5 * um
        ),
    ]
    key = jax.random.PRNGKey(0)
    objects, arrays, params, config, _ = fdtdx.place_objects(
        object_list=[volume, core, source, detector, *boundaries.values()],
        config=config,
        constraints=constraints,
        key=key,
    )
    arrays, objects, _ = fdtdx.apply_params(arrays, objects, params, key)
    tick = time.perf_counter()
    _, arrays = fdtdx.run_fdtd(arrays=arrays, objects=objects, config=config, key=key)
    phasor = np.asarray(arrays.detector_states["field"]["phasor"])
    elapsed = time.perf_counter() - tick
    field = phasor.reshape(phasor.shape[-3:])
    overlaps = np.array([np.vdot(field[-1], plane) for plane in field])
    x = np.arange(len(overlaps)) * grid_um
    phase = np.unwrap(np.angle(overlaps))
    slope, intercept = np.polyfit(x, phase, 1)
    amplitude = np.abs(overlaps)
    return {
        "wavelength_um": wavelength_um,
        "grid_um": grid_um,
        "core_index": core_index,
        "cladding_index": cladding_index,
        "effective_index": float(abs(slope) * wavelength_um / (2 * math.pi)),
        "phase_residual_rad": float(np.max(np.abs(phase - (slope * x + intercept)))),
        "amplitude_spread": float(np.ptp(amplitude) / np.mean(amplitude)),
        "cross_sections_fitted": int(len(overlaps)),
        "time_steps": int(config.time_steps_total),
        "elapsed_seconds": elapsed,
    }
