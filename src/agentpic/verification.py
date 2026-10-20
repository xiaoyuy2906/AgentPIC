"""Independent numerical and geometry checks; semantic verification lives in TypeScript.

This module deliberately does not import the SAX models or the layout builder, and it never
names a device family: the reference is dense network elimination of the submitted netlist.
Numerical agreement verifies the stated ideal models, not physical calibration.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from agentpic.circuit_reference import circuit_reference
from agentpic.ir import CheckResult, EngineeringIR
from agentpic.lvs import verify_lvs
from agentpic.spectral import sampling_adequacy, verify_measurements

LIMITATIONS = [
    "Demonstration SiN process; no foundry PDK or signoff rule deck.",
    "Ideal compact models are analytically checked, not calibrated to these polygons or measurements.",
    "No electromagnetic simulation, bend-loss model, manufacturing variation or thermal model.",
    "Connectivity is port-based with GDS geometry checks; this is not full foundry LVS.",
]


def _check(identifier: str, passed: bool, detail: str, **evidence) -> CheckResult:
    return CheckResult(
        id=identifier, status="pass" if passed else "fail", detail=detail, evidence=evidence
    )


def verify_simulation(ir: EngineeringIR, simulation: dict) -> list[CheckResult]:
    wavelengths = np.asarray(simulation["wavelength_nm"], dtype=float)
    spec = ir.specification
    size = len(spec.port_order)
    try:
        real, imag = np.asarray(simulation["s_real"]), np.asarray(simulation["s_imag"])
        if real.shape != imag.shape:
            raise ValueError("Real and imaginary shapes differ")
        matrix = real + 1j * imag
    except ValueError:
        return [_check("simulation_shape_and_finiteness", False, "Malformed complex matrix.")]
    controlled = any(i.phase_control is not None for i in ir.netlist.instances)
    calibration = (
        [
            CheckResult(
                id="phase_actuation_calibration",
                status="not_run",
                detail="Optical phase is specified directly; voltage, current, power and temperature-to-phase mapping is not calibrated.",
                evidence={},
            )
        ]
        if controlled
        else []
    )
    expected_grid = np.linspace(
        spec.wavelength_nm - spec.sweep_span_nm / 2,
        spec.wavelength_nm + spec.sweep_span_nm / 2,
        spec.sweep_points,
    )
    if (
        matrix.shape != (spec.sweep_points, size, size)
        or wavelengths.shape != expected_grid.shape
        or not np.all(np.isfinite(matrix))
        or not np.all(np.isfinite(wavelengths))
        or simulation["ports"] != list(spec.port_order)
    ):
        return calibration + [
            _check(
                "simulation_shape_and_finiteness",
                False,
                "Invalid scattering data shape, values or ports.",
            )
        ]
    try:
        expected = circuit_reference(ir, wavelengths)
        sampling = sampling_adequacy(ir, wavelengths, matrix)
    except (ValueError, np.linalg.LinAlgError) as exc:
        return calibration + [
            _check(
                "independent_circuit_agreement",
                False,
                "Independent reference could not resolve the network.",
                error=str(exc),
            )
        ]
    if not np.all(np.isfinite(expected)):
        return calibration + [
            _check("independent_circuit_agreement", False, "Independent reference is not finite.")
        ]
    error = float(np.max(np.abs(matrix - expected)))
    reciprocity = float(np.max(np.abs(matrix - matrix.transpose(0, 2, 1))))
    unitary_error = float(np.max(np.abs(matrix.conj().transpose(0, 2, 1) @ matrix - np.eye(size))))
    largest_gain = float(np.max(np.linalg.svd(matrix, compute_uv=False)))
    return (
        calibration
        + [
            _check(
                "simulation_shape_and_finiteness",
                True,
                "Complex matrix dimensions, finiteness and explicit optical port order agree.",
                ports=list(spec.port_order),
                shape=list(matrix.shape),
            ),
            _check(
                "simulation_grid",
                np.allclose(wavelengths, expected_grid, rtol=0, atol=1e-9),
                "Spectrum covers the requested wavelength range and center.",
            ),
            _check(
                "independent_circuit_agreement",
                error < 1e-9,
                "Full complex SAX S-matrix agrees with independent NumPy network elimination.",
                max_complex_error=error,
                tolerance=1e-9,
            ),
            _check(
                "reciprocity", reciprocity < 1e-10, "S equals its transpose.", max_error=reciprocity
            ),
            _check(
                "passivity",
                largest_gain <= 1 + 1e-10,
                "Largest singular value does not exceed unity.",
                max_singular_value=largest_gain,
            ),
            _check(
                "lossless_power_balance",
                unitary_error < 1e-10,
                "All optical inputs satisfy S†S=I for the stated lossless model.",
                max_error=unitary_error,
            ),
            sampling,
        ]
        + verify_measurements(ir, wavelengths, matrix)
    )


def verify_geometry(ir: EngineeringIR, metadata: dict, gds_path: Path) -> list[CheckResult]:
    import klayout.db as kdb

    layout = kdb.Layout()
    layout.read(str(gds_path))
    tops = list(layout.top_cells())
    if len(tops) != 1:
        return [_check("gds_readback", False, "Exported GDS must have exactly one top cell.")]
    tech, top = ir.technology, tops[0]
    layer = layout.find_layer(*tech.core_layer)
    if layer is None:
        return [_check("gds_readback", False, "Core layer is missing in exported GDS.")]
    region = kdb.Region(top.begin_shapes_rec(layer)).merged()
    width = int(np.ceil(tech.minimum_width_um / layout.dbu))
    space = int(np.ceil(tech.minimum_spacing_um / layout.dbu))
    width_errors = region.width_check(width).count()
    spacing_errors = region.space_check(space).count()
    connected_regions = region.count()
    corridor_missing_area = 0.0
    minimum_radius = float("inf")
    for points in metadata["centerlines_um"].values():
        points = np.asarray(points)
        integer_points = [
            kdb.Point(round(x / layout.dbu), round(y / layout.dbu)) for x, y in points
        ]
        corridor = kdb.Region(
            kdb.Path(integer_points, round(0.4 * tech.width_um / layout.dbu)).polygon()
        )
        corridor_missing_area += float((corridor - region).area() * layout.dbu**2)
        a, b = points[1:-1] - points[:-2], points[2:] - points[1:-1]
        cross = np.abs(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0])
        numerator = (
            np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1) * np.linalg.norm(a + b, axis=1)
        )
        curved = (cross > 1e-9) & (numerator > 1e-9)
        if np.any(curved):
            minimum_radius = min(
                minimum_radius, float(np.min(numerator[curved] / (2 * cross[curved])))
            )
    return (
        verify_lvs(ir, metadata, layout, top, region)
        + verify_actuators(ir, metadata, layout, top, region)
        + [
            _check(
                "gds_readback",
                not region.is_empty() and top.name == metadata["top_cell"],
                "Independent KLayout reader opens the exported GDS and finds its core geometry.",
                area_um2=float(region.area() * layout.dbu**2),
                dbu_um=layout.dbu,
            ),
            _check(
                "gds_connected_core",
                connected_regions == 1,
                "Merged core geometry forms one connected PIC region.",
                regions=connected_regions,
            ),
            _check(
                "demo_minimum_width",
                width_errors == 0,
                "KLayout width check against the explicit demonstration rule.",
                threshold_um=tech.minimum_width_um,
                violations=width_errors,
            ),
            _check(
                "demo_minimum_spacing",
                spacing_errors == 0,
                "KLayout spacing check against the explicit demonstration rule.",
                threshold_um=tech.minimum_spacing_um,
                violations=spacing_errors,
            ),
            _check(
                "gds_contains_waveguide_centerlines",
                corridor_missing_area < 1e-6,
                "Every waveguide centerline corridor is contained in the exported GDS core.",
                missing_area_um2=corridor_missing_area,
            ),
            _check(
                "demo_bend_radius",
                minimum_radius >= tech.bend_radius_um - 0.01,
                "Centerline circumradii meet the demonstration bend-radius rule; straight-only layouts have no bends.",
                minimum_radius_um=minimum_radius if np.isfinite(minimum_radius) else None,
            ),
        ]
    )


def verify_actuators(ir, metadata, layout, top, core):
    """Read actual metal polygons independently; infer placement from optical centerlines."""
    import klayout.db as kdb

    controls = {i.name: i.phase_control for i in ir.netlist.instances if i.kind == "phase_shifter"}
    actual = metadata.get("actuators", {})
    if not controls and not actual:
        return []
    if set(controls) != set(actual):
        return [
            _check(
                "phase_layout_intent",
                False,
                "Actuator instances do not match controlled primitives.",
            )
        ]
    tech = ir.technology
    layer = layout.find_layer(*tech.heater_layer)
    metal = kdb.Region(top.begin_shapes_rec(layer)).merged() if layer is not None else kdb.Region()
    expected = kdb.Region()
    intent_ok, terminal_ok = True, True
    max_length_error = 0.0
    for name, control in controls.items():
        actuator = actual[name]
        points = np.asarray(actuator["centerline_um"], dtype=float)
        route = np.asarray(metadata["centerlines_um"][name], dtype=float)
        # Independently locate the longest straight section of the optical centerline.
        steps = np.linalg.norm(np.diff(route, axis=0), axis=1)
        k = int(np.argmax(steps))
        a, b = route[k], route[k + 1]
        unit = (b - a) / steps[k]
        heading = float(np.degrees(np.arctan2(unit[1], unit[0])))
        expected_ends = np.array(
            [
                (a + b) / 2 - unit * control.active_length_um / 2,
                (a + b) / 2 + unit * control.active_length_um / 2,
            ]
        )
        intent_ok &= (
            tuple(actuator["layer"]) == tuple(tech.heater_layer)
            and abs(actuator["width_um"] - tech.heater_width_um) <= 0.001
            and float(np.max(np.linalg.norm(points - expected_ends, axis=1))) <= 0.001
            and steps[k] >= control.active_length_um
        )
        length_error = abs(np.linalg.norm(points[1] - points[0]) - control.active_length_um)
        max_length_error = max(max_length_error, float(length_error))
        for j, port_name in enumerate(("e1", "e2")):
            port = metadata["ports"][name].get(port_name)
            facing = heading + (180 if j == 0 else 0)
            terminal_ok &= bool(port) and (
                port["domain"] == "electrical"
                and np.linalg.norm(np.asarray(port["center_um"]) - points[j]) <= 0.001
                and abs(port["width_um"] - tech.heater_width_um) <= 0.001
                and abs((port["orientation_deg"] - facing + 180) % 360 - 180) <= 1e-6
            )
        integer_points = [
            kdb.Point(round(x / layout.dbu), round(y / layout.dbu)) for x, y in points
        ]
        expected += kdb.Region(
            kdb.Path(integer_points, round(tech.heater_width_um / layout.dbu)).polygon()
        )
        optical_corridor = kdb.Region(
            kdb.Path(integer_points, round(0.4 * tech.width_um / layout.dbu)).polygon()
        )
        intent_ok &= (optical_corridor - core).area() == 0
    discrepancy = float((metal ^ expected.merged()).area() * layout.dbu**2)
    rule = round(tech.minimum_width_um / layout.dbu)
    violations = (
        metal.width_check(rule).count()
        + metal.space_check(round(tech.minimum_spacing_um / layout.dbu)).count()
    )
    return [
        _check(
            "phase_layout_intent",
            bool(intent_ok) and max_length_error <= 0.001,
            "Active metal lies on the intended straight optical segment with declared dimensions.",
            maximum_length_error_um=max_length_error,
        ),
        _check(
            "gds_actuator_geometry",
            discrepancy < 1e-6 and metal.count() == len(controls),
            "Actual GDS metal matches every intended actuator footprint.",
            symmetric_difference_area_um2=discrepancy,
            metal_regions=metal.count(),
        ),
        _check(
            "actuator_terminal_alignment",
            bool(terminal_ok),
            "Exposed electrical terminals match the two physical metal ends.",
        ),
        _check(
            "demo_metal_rules",
            violations == 0,
            "Metal satisfies explicit demonstration width/spacing rules.",
            violations=violations,
        ),
    ]


def verify_tuning(ir: EngineeringIR, tuning: dict) -> list[CheckResult]:
    """Replay every recorded candidate with independent network elimination, without SAX."""
    request = ir.specification.tuning
    if request is None:
        return [_check("tuning_trace_reference", False, "No tuning request")]
    wavelengths = np.array([t.wavelength_nm for t in request.targets])
    ports = list(ir.specification.port_order)
    error = 0.0
    for entry in tuning["evaluation_trace"]:
        candidate = ir.model_copy(deep=True)
        for component in candidate.netlist.instances:
            if component.name in entry["controls"] and component.phase_control is not None:
                component.phase_control.phase_rad = entry["controls"][component.name]
        scattering = circuit_reference(candidate, wavelengths)
        powers = np.array(
            [
                abs(scattering[i, ports.index(t.output_port), ports.index(t.input_port)]) ** 2
                for i, t in enumerate(request.targets)
            ]
        )
        recorded = np.asarray(entry["powers"])
        if recorded.shape != powers.shape or not np.all(np.isfinite(recorded)):
            return [_check("tuning_trace_reference", False, "Invalid candidate powers")]
        error = max(error, float(np.max(np.abs(powers - recorded))))
    return [
        _check(
            "tuning_trace_reference",
            error < 1e-9,
            "Every candidate agrees with independent network elimination; this is not physical calibration.",
            maximum_power_error=error,
            candidates=len(tuning["evaluation_trace"]),
        )
    ]
