"""Layout versus schematic, independent of the layout builder.

Connectivity is re-extracted from physical pin positions: two pins of one domain that coincide
with equal widths and opposite orientations form a connection; a lone pin is open. The result
is compared with the schematic netlist, every pin must sit on real GDS geometry, and no
waveguide may cross or overlap another waveguide or a coupler body. This is pin-based photonic
LVS with geometric evidence, not polygon device recognition.
"""

from __future__ import annotations

import numpy as np

from agentpic.ir import CheckResult, EngineeringIR


def _check(identifier: str, passed: bool, detail: str, **evidence) -> CheckResult:
    return CheckResult(
        id=identifier, status="pass" if passed else "fail", detail=detail, evidence=evidence
    )


def _point(xy, dbu: float):
    import klayout.db as kdb

    return kdb.Point(int(round(xy[0] / dbu)), int(round(xy[1] / dbu)))


def _direction(orientation_deg: float) -> np.ndarray:
    angle = np.deg2rad(orientation_deg)
    return np.round(np.array([np.cos(angle), np.sin(angle)]), 12)


def extract_connectivity(ports: dict) -> tuple[set[str], set[str], list[list[str]]]:
    """Connections, open pins and ambiguous pin groups from coincident physical pins."""
    groups: dict[tuple, list] = {}
    for instance, pins in ports.items():
        for name, pin in pins.items():
            x, y = pin["center_um"]
            key = (pin["domain"], round(x, 3), round(y, 3))
            groups.setdefault(key, []).append((f"{instance},{name}", pin))
    connections, open_pins, ambiguous = set(), set(), []
    for group in groups.values():
        if len(group) == 1:
            open_pins.add(group[0][0])
            continue
        (a, pa), (b, pb) = group[0], group[-1]
        facing = abs((pa["orientation_deg"] - pb["orientation_deg"]) % 360 - 180) < 1e-6
        if len(group) == 2 and facing and abs(pa["width_um"] - pb["width_um"]) <= 0.001:
            connections.add("|".join(sorted((a, b))))
        else:
            ambiguous.append(sorted(endpoint for endpoint, _ in group))
    return connections, open_pins, ambiguous


def _trimmed(points: np.ndarray, cut: float) -> np.ndarray | None:
    """The polyline without `cut` µm at either end, or None when nothing remains."""
    steps = np.linalg.norm(np.diff(points, axis=0), axis=1)
    arc = np.concatenate([[0.0], np.cumsum(steps)])
    if arc[-1] <= 2 * cut:
        return None

    def at(s: float) -> np.ndarray:
        k = int(np.clip(np.searchsorted(arc, s) - 1, 0, len(steps) - 1))
        return points[k] + (points[k + 1] - points[k]) * (s - arc[k]) / steps[k]

    inner = points[(arc > cut) & (arc < arc[-1] - cut)]
    return np.vstack([at(cut), *inner, at(arc[-1] - cut)])


def verify_lvs(ir: EngineeringIR, metadata: dict, layout, top, core) -> list[CheckResult]:
    import klayout.db as kdb

    tech = ir.technology
    dbu = layout.dbu
    connections, open_pins, ambiguous = extract_connectivity(metadata["ports"])
    schematic = {
        "|".join(sorted((f"{e.a.instance},{e.a.port}", f"{e.b.instance},{e.b.port}")))
        for e in ir.netlist.connections
    }
    external = {f"{e.instance},{e.port}" for e in ir.netlist.ports.values()}
    differences = {
        "missing_connections": sorted(schematic - connections),
        "extra_connections": sorted(connections - schematic),
        "unexpected_open_pins": sorted(open_pins - external),
        "connected_external_pins": sorted(external - open_pins),
        "ambiguous_pin_groups": ambiguous,
    }

    heater_layer = layout.find_layer(*tech.heater_layer)
    metal = (
        kdb.Region(top.begin_shapes_rec(heater_layer)).merged()
        if heater_layer is not None
        else kdb.Region()
    )
    probe = 0.1  # µm of geometry that must lie just inside every pin
    missing_geometry = []
    for instance, pins in metadata["ports"].items():
        for name, pin in pins.items():
            centre = np.asarray(pin["center_um"], float)
            inward = -_direction(pin["orientation_deg"])
            box = kdb.Path(
                [_point(q, dbu) for q in (centre, centre + inward * probe)],
                round(0.5 * pin["width_um"] / dbu),
            ).polygon()
            region = core if pin["domain"] == "optical" else metal
            if not (kdb.Region(box) - region).is_empty():
                missing_geometry.append(f"{instance},{name}")

    width = tech.width_um
    corridor = round(0.4 * width / dbu)
    bodies = {}
    for instance in ir.netlist.instances:
        if instance.kind == "ideal_coupler" and instance.name in metadata["ports"]:
            centres = np.array([p["center_um"] for p in metadata["ports"][instance.name].values()])
            bodies[instance.name] = kdb.Region(
                kdb.Box(_point(centres.min(axis=0), dbu), _point(centres.max(axis=0), dbu))
            )
    lines = {}
    for name, points in metadata["centerlines_um"].items():
        inner = _trimmed(np.asarray(points, float), 2 * width)
        if inner is not None:
            path = [_point(q, dbu) for q in inner]
            lines[name] = kdb.Region(kdb.Path(path, corridor).polygon())
    crossings = []
    names = sorted(lines)
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            overlap = (lines[a] & lines[b]).area() * dbu**2
            if overlap > 0:
                crossings.append({"a": a, "b": b, "overlap_um2": float(overlap)})
        for body, region in bodies.items():
            overlap = (lines[a] & region).area() * dbu**2
            if overlap > 0:
                crossings.append({"a": a, "b": body, "overlap_um2": float(overlap)})

    return [
        _check(
            "lvs_connectivity",
            not any(differences.values()),
            "Connectivity re-extracted from coincident physical pins equals the schematic netlist.",
            extracted_connections=len(connections),
            **differences,
        ),
        _check(
            "lvs_pin_geometry",
            not missing_geometry,
            "Every optical pin lies on core geometry and every electrical pin on metal in the GDS.",
            pins_without_geometry=missing_geometry,
        ),
        _check(
            "waveguide_crossings",
            not crossings,
            "No waveguide crosses or overlaps another waveguide or a coupler body.",
            crossings=crossings,
        ),
    ]
