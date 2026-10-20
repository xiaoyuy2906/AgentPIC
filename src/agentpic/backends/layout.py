"""Generic GDSFactory layout: place cells, route waveguides along Manhattan steps, extract.

The engine knows primitive kinds and the demonstration PDK cells, never device families.
Placements are absolute or anchored to another instance's port. A routed waveguide joins
the two placed ports it connects to; its path follows the declared steps, gains at most one
final corner to reach the end port and is smoothed with circular bends of the PDK radius.
"""

from pathlib import Path

import numpy as np

from agentpic.ir import EngineeringIR


class GDSFactoryBackend:
    name = "gdsfactory"

    def build(self, ir: EngineeringIR, directory: Path) -> dict:
        return build_layout(ir, directory)


def direction(orientation_deg: float) -> np.ndarray:
    """Unit vector pointing out of a port."""
    angle = np.deg2rad(orientation_deg)
    return np.round(np.array([np.cos(angle), np.sin(angle)]), 12)


def longest_segment(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The longest straight section of a smoothed path; actuators are centred on it."""
    lengths = np.linalg.norm(np.diff(points, axis=0), axis=1)
    k = int(np.argmax(lengths))
    return points[k], points[k + 1]


def manhattan_points(start, start_orientation, end, end_orientation, steps, radius) -> np.ndarray:
    """Polyline from start through the steps to end, adding at most one final corner."""
    start, end = np.asarray(start, float), np.asarray(end, float)
    points = [start]
    for step in steps:
        ((key, value),) = step.model_dump().items()
        x, y = points[-1]
        if key == "dx_um":
            x += value
        elif key == "dy_um":
            y += value
        elif key == "x_um":
            x = value
        elif key == "y_um":
            y = value
        elif key == "x_from_end_um":
            x = end[0] + value
        else:
            y = end[1] + value
        points.append(np.array([x, y]))
    arrival = -direction(end_orientation)
    last = points[-1]
    if abs(arrival[0]) > 0.5 and abs(last[1] - end[1]) > 1e-9:
        points.append(np.array([last[0], end[1]]))
    elif abs(arrival[1]) > 0.5 and abs(last[0] - end[0]) > 1e-9:
        points.append(np.array([end[0], last[1]]))
    points.append(end)
    # Drop repeated points and merge collinear runs so every interior point is a real corner.
    merged = [points[0]]
    for point in points[1:]:
        if np.linalg.norm(point - merged[-1]) < 1e-9:
            continue
        if len(merged) >= 2:
            a, b = merged[-1] - merged[-2], point - merged[-1]
            if abs(a[0] * b[1] - a[1] * b[0]) < 1e-9 and np.dot(a, b) > 0:
                merged[-1] = point
                continue
        merged.append(point)
    path = np.array(merged)
    segments = np.diff(path, axis=0)
    if len(segments) == 0:
        raise ValueError("Route start and end ports coincide")
    if np.any(np.all(np.abs(segments) > 1e-9, axis=1)):
        raise ValueError("Route segments must be axis aligned")
    lengths = np.linalg.norm(segments, axis=1)
    unit = segments / lengths[:, None]
    if not np.allclose(unit[0], direction(start_orientation), atol=1e-9):
        raise ValueError("Route must leave its start port along the port direction")
    if not np.allclose(unit[-1], arrival, atol=1e-9):
        raise ValueError("Route must enter its end port along the port direction")
    if np.any(np.einsum("ij,ij->i", unit[1:], unit[:-1]) < -0.5):
        raise ValueError("Route reverses direction")
    room = np.full(len(lengths), 2 * radius)
    room[0] = room[-1] = radius
    if len(lengths) == 1:
        room[0] = 0
    if np.any(lengths < room - 1e-9):
        raise ValueError("Route segment is too short for the PDK bend radius")
    return path


def build_layout(ir: EngineeringIR, directory: Path) -> dict:
    plan = ir.specification.layout
    if plan is None:
        raise NotImplementedError("The design has no layout plan")
    import gdsfactory as gf
    import klayout.db as kdb

    gf.gpdk.PDK.activate()
    gf.clear_cache()
    tech = ir.technology
    cross_section = gf.cross_section.strip(
        width=tech.width_um, layer=tech.core_layer, radius=tech.bend_radius_um
    )
    heater_section = gf.cross_section.heater_metal(
        width=tech.heater_width_um, layer=tech.heater_layer
    )
    mmi = gf.components.mmi2x2(
        width=tech.width_um,
        width_taper=1.5,
        length_taper=10,
        length_mmi=40,
        width_mmi=5,
        gap_mmi=1,
        cross_section=cross_section,
    )
    component = gf.Component(f"agentpic_{ir.specification.name}_{ir.design_id}")
    instances = {i.name: i for i in ir.netlist.instances}
    index = {"/".join(path): name for name, path in ir.instance_paths.items()}
    placements = {index[path]: p for path, p in plan.placements.items()}
    routes = {index[path]: r for path, r in plan.routes.items()}
    references, lengths, centerlines, actuators = {}, {}, {}, {}

    def waveguide_cell(name: str, path) -> gf.Component:
        waveguide = gf.path.extrude(path, cross_section=cross_section)
        control = instances[name].phase_control
        if control is None:
            waveguide.name = f"{name}_{ir.design_id}"
            return waveguide
        cell = gf.Component(f"{name}_{ir.design_id}")
        cell.add_ports(cell.add_ref(waveguide).ports)
        a, b = longest_segment(np.asarray(path.points))
        span = float(np.linalg.norm(b - a))
        if span < control.active_length_um:
            raise ValueError("No straight section can contain the specified actuator")
        unit = (b - a) / span
        heater = cell.add_ref(
            gf.components.straight(length=control.active_length_um, cross_section=heater_section)
        )
        heater.drotate(float(np.degrees(np.arctan2(unit[1], unit[0]))))
        heater.dmove(tuple((a + b) / 2 - unit * control.active_length_um / 2))
        cell.add_ports(heater.ports)
        return cell

    def place(name: str) -> None:
        placement = placements[name]
        instance = instances[name]
        if instance.kind == "ideal_coupler":
            cell = mmi
        else:
            straight = gf.Path(np.array([(0.0, 0.0), (instance.length_um, 0.0)]))
            cell = waveguide_cell(name, straight)
        reference = component.add_ref(cell, name=name)
        if placement.rotation_deg:
            reference.drotate(placement.rotation_deg)
        if placement.anchor is None:
            reference.dmove((placement.x_um, placement.y_um))
        else:
            anchor = references[index[placement.anchor.instance]].ports[placement.anchor.port]
            own = reference.ports[placement.port].center
            reference.dmove(
                (
                    anchor.center[0] + placement.x_um - own[0],
                    anchor.center[1] + placement.y_um - own[1],
                )
            )
        references[name] = reference
        if instance.kind != "ideal_coupler":
            ends = [reference.ports[p].center for p in ("o1", "o2")]
            centerlines[name] = [list(map(float, point)) for point in ends]
            lengths[name] = float(instance.length_um)

    pending = list(placements)
    while pending:
        ready = [
            n
            for n in pending
            if placements[n].anchor is None or index[placements[n].anchor.instance] in references
        ]
        if not ready:
            raise ValueError("Placement anchors form a cycle")
        for name in ready:
            place(name)
            pending.remove(name)

    neighbour = {}
    for edge in ir.netlist.connections:
        neighbour[(edge.a.instance, edge.a.port)] = edge.b
        neighbour[(edge.b.instance, edge.b.port)] = edge.a
    for name, route in routes.items():
        start = neighbour[(name, "o1")]
        end = neighbour[(name, "o2")]
        start_port = references[start.instance].ports[start.port]
        end_port = references[end.instance].ports[end.port]
        points = manhattan_points(
            start_port.center,
            start_port.orientation,
            end_port.center,
            end_port.orientation,
            route.steps,
            tech.bend_radius_um,
        )
        path = (
            gf.path.smooth(points, radius=tech.bend_radius_um, bend=gf.path.arc, npoints=128)
            if len(points) > 2
            else gf.Path(points)
        )
        references[name] = component.add_ref(waveguide_cell(name, path), name=name)
        lengths[name] = float(path.length())
        centerlines[name] = np.asarray(path.points).tolist()

    for name, reference in references.items():
        if instances[name].phase_control is not None:
            actuators[name] = {
                "centerline_um": [
                    list(map(float, reference.ports[p].center)) for p in ("e1", "e2")
                ],
                "layer": list(tech.heater_layer),
                "width_um": float(reference.ports["e1"].width),
            }
    for name, endpoint in ir.netlist.ports.items():
        component.add_port(name=name, port=references[endpoint.instance].ports[endpoint.port])
    # Derive connectivity from all placed primitive ports, including routed waveguides.
    extracted = component.get_netlist(
        on_multi_connect="error", on_dangling_port="error", instance_namer=lambda ref: ref.name
    )

    def endpoint(key: str) -> dict[str, str]:
        instance, port = key.split(",")
        return {"instance": instance, "port": port}

    extracted_circuit = {
        "instances": [
            {
                **instance.model_dump(mode="json"),
                "ports": [
                    {"name": port.name, "domain": port.port_type, "direction": "bidirectional"}
                    for port in references[instance.name].ports
                ],
            }
            for instance in ir.netlist.instances
            if instance.name in extracted["instances"]
        ],
        "connections": [
            {"a": endpoint(e["p1"]), "b": endpoint(e["p2"])} for e in extracted["nets"]
        ],
        "ports": {name: endpoint(key) for name, key in extracted["ports"].items()},
    }
    ports = {
        name: {
            port.name: {
                "center_um": list(map(float, port.center)),
                "orientation_deg": float(port.orientation),
                "width_um": float(port.width),
                "domain": port.port_type,
            }
            for port in ref.ports
        }
        for name, ref in references.items()
    }
    options = kdb.SaveLayoutOptions()
    options.gds2_write_timestamps = False
    component.write_gds(directory / "design.gds", save_options=options, with_metadata=False)
    return {
        "schema_version": "3.0",
        "top_cell": component.name,
        "technology": tech.name,
        "core_layer": list(tech.core_layer),
        "lengths_um": lengths,
        "centerlines_um": centerlines,
        "ports": ports,
        "extracted_circuit": extracted_circuit,
        "bend_radius_um": tech.bend_radius_um,
        "actuators": actuators,
    }
