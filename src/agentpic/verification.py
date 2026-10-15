"""Independent numerical and geometry checks; semantic verification lives in TypeScript.

This module deliberately does not import the SAX models or the layout builder.
Numerical agreement verifies the stated ideal models, not physical calibration.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from agentpic.ir import CheckResult, EngineeringIR

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
    matrix = np.asarray(simulation["s_real"]) + 1j * np.asarray(simulation["s_imag"])
    spec, tech = ir.specification, ir.technology
    controls = {i.name: i.phase_control for i in ir.netlist.instances if i.kind == "phase_shifter"}
    calibration = (
        [
            CheckResult(
                id="phase_actuation_calibration",
                status="not_run",
                detail="Optical phase is specified directly; voltage, current, power and temperature-to-phase mapping is not calibrated.",
                evidence={},
            )
        ]
        if controls
        else []
    )
    expected_grid = np.linspace(
        spec.wavelength_nm - spec.sweep_span_nm / 2,
        spec.wavelength_nm + spec.sweep_span_nm / 2,
        spec.sweep_points,
    )
    if (
        matrix.shape != (spec.sweep_points, 4, 4)
        or wavelengths.shape != expected_grid.shape
        or not np.all(np.isfinite(matrix))
        or not np.all(np.isfinite(wavelengths))
        or simulation["ports"] != ["in0", "in1", "out0", "out1"]
    ):
        return calibration + [
            _check(
                "simulation_shape_and_finiteness",
                False,
                "Invalid scattering data shape, values or ports.",
            )
        ]
    lengths = {i.name: i.length_um for i in ir.netlist.instances if i.kind != "ideal_coupler"}
    wl = wavelengths / 1000
    # Independent closed-form MZI, derived directly from its two-path interference.
    index = (
        tech.effective_index
        + (tech.effective_index - tech.group_index)
        * (wl - tech.reference_wavelength_um)
        / tech.reference_wavelength_um
    )

    def propagation(name: str) -> np.ndarray:
        induced_path = (
            controls[name].phase_rad * tech.reference_wavelength_um / (2 * np.pi)
            if name in controls
            else 0.0
        )
        return np.exp(2j * np.pi * (index * lengths[name] + induced_path) / wl)

    def mzi_transfer(top_name: str, bottom_name: str) -> np.ndarray:
        top, bottom = propagation(top_name), propagation(bottom_name)
        transfer = np.zeros((len(wl), 2, 2), dtype=complex)
        transfer[:, 0, 0], transfer[:, 1, 1] = (bottom - top) / 2, (top - bottom) / 2
        transfer[:, 0, 1] = transfer[:, 1, 0] = 1j * (bottom + top) / 2
        return transfer

    if ir.assembly is None:
        transfer = mzi_transfer("top_arm", "bottom_arm")
    else:
        blocks = ir.assembly.blocks
        transfer = mzi_transfer(blocks[0].primitives["top_arm"], blocks[0].primitives["bottom_arm"])
        for previous, block in zip(blocks, blocks[1:]):
            links = {
                link.a.port: link.instance
                for link in ir.assembly.links
                if link.a.instance == previous.name and link.b.instance == block.name
            }
            connecting = np.zeros_like(transfer)
            connecting[:, 0, 0] = propagation(links["out0"])
            connecting[:, 1, 1] = propagation(links["out1"])
            transfer = (
                mzi_transfer(block.primitives["top_arm"], block.primitives["bottom_arm"])
                @ connecting
                @ transfer
            )
    expected = np.zeros_like(matrix)
    expected[:, 2:, :2] = transfer
    expected[:, :2, 2:] = transfer.transpose(0, 2, 1)
    error = float(np.max(np.abs(matrix - expected)))
    reciprocity = float(np.max(np.abs(matrix - matrix.transpose(0, 2, 1))))
    unitary_error = float(np.max(np.abs(matrix.conj().transpose(0, 2, 1) @ matrix - np.eye(4))))
    largest_gain = float(np.max(np.linalg.svd(matrix, compute_uv=False)))
    out0 = np.asarray(simulation["transmission_out0"])
    out1 = np.asarray(simulation["transmission_out1"])
    powers_consistent = (
        out0.shape == wavelengths.shape
        and out1.shape == wavelengths.shape
        and np.allclose(out0, np.abs(matrix[:, 2, 0]) ** 2, atol=1e-12, rtol=0)
        and np.allclose(out1, np.abs(matrix[:, 3, 0]) ** 2, atol=1e-12, rtol=0)
    )
    return calibration + [
        _check(
            "simulation_grid",
            np.allclose(wavelengths, expected_grid, rtol=0, atol=1e-9),
            "Spectrum covers the requested wavelength range and center.",
        ),
        _check(
            "analytic_cascade_agreement" if ir.assembly is not None else "analytic_mzi_agreement",
            error < 1e-9,
            "Full complex SAX S-matrix agrees with independent analytic MZI transfer matrices and physical interconnect propagation.",
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
            "All four inputs satisfy S†S=I for the stated lossless model.",
            max_error=unitary_error,
        ),
        _check(
            "reported_transmission",
            bool(powers_consistent),
            "Reported transmission powers agree with the exported S-matrix.",
        ),
    ]


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
    return verify_actuators(ir, metadata, layout, top, region) + [
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
            "gds_contains_arm_centerlines",
            corridor_missing_area < 1e-6,
            "Every waveguide centerline corridor is contained in the exported GDS core.",
            missing_area_um2=corridor_missing_area,
        ),
        _check(
            "demo_bend_radius",
            np.isfinite(minimum_radius) and minimum_radius >= tech.bend_radius_um - 0.01,
            "Centerline circumradii meet the demonstration bend-radius rule.",
            minimum_radius_um=minimum_radius if np.isfinite(minimum_radius) else None,
        ),
    ]


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
        straight = [
            (a, b) for a, b in zip(route, route[1:]) if abs(b[1] - a[1]) < 1e-9 and b[0] > a[0]
        ]
        a, b = max(straight, key=lambda pair: pair[1][0] - pair[0][0])
        midpoint = (a + b) / 2
        intent_ok &= (
            tuple(actuator["layer"]) == tuple(tech.heater_layer)
            and abs(actuator["width_um"] - tech.heater_width_um) <= 0.001
            and np.linalg.norm(points.mean(axis=0) - midpoint) <= 0.001
            and abs(points[1, 1] - points[0, 1]) <= 0.001
            and points[1, 0] > points[0, 0]
            and b[0] - a[0] >= control.active_length_um
        )
        length_error = abs(np.linalg.norm(points[1] - points[0]) - control.active_length_um)
        max_length_error = max(max_length_error, float(length_error))
        for j, port_name in enumerate(("e1", "e2")):
            port = metadata["ports"][name].get(port_name)
            terminal_ok &= bool(port) and (
                port["domain"] == "electrical"
                and np.linalg.norm(np.asarray(port["center_um"]) - points[j]) <= 0.001
                and abs(port["width_um"] - tech.heater_width_um) <= 0.001
                and abs(port["orientation_deg"] - (180 if j == 0 else 0)) <= 1e-6
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
