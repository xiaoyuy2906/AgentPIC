"""GDSFactory adapter for composed feed-forward and resonant feedback circuits."""

from pathlib import Path

import numpy as np

from agentpic.ir import EngineeringIR


class GDSFactoryBackend:
    name = "gdsfactory"

    def build(self, ir: EngineeringIR, directory: Path) -> dict:
        return build_layout(ir, directory)


def build_layout(ir: EngineeringIR, directory: Path) -> dict:
    if ir.specification.device == "circuit":
        raise NotImplementedError("Generic circuit layout and GDS export are not implemented")
    import gdsfactory as gf
    import klayout.db as kdb

    gf.gpdk.PDK.activate()
    gf.clear_cache()
    tech = ir.technology
    cross_section = gf.cross_section.strip(
        width=tech.width_um, layer=tech.core_layer, radius=tech.bend_radius_um
    )
    component = gf.Component(f"agentpic_{ir.specification.device}_{ir.design_id}")
    coupler = gf.components.mmi2x2(
        width=tech.width_um,
        width_taper=1.5,
        length_taper=10,
        length_mmi=40,
        width_mmi=5,
        gap_mmi=1,
        cross_section=cross_section,
    )
    references, lengths, centerlines, block_ports, imbalances, actuators = {}, {}, {}, {}, {}, {}
    instances = {i.name: i for i in ir.netlist.instances}

    def add_path(name: str, path: gf.Path) -> None:
        waveguide = gf.path.extrude(path, cross_section=cross_section)
        control = instances[name].phase_control
        if control is not None:
            cell = gf.Component(f"{name}_{ir.design_id}")
            optical = cell.add_ref(waveguide)
            cell.add_ports(optical.ports)
            # The longest horizontal segment is the straight section of the arm.
            points = path.points
            segments = [
                (a, b)
                for a, b in zip(points, points[1:])
                if abs(b[1] - a[1]) < 1e-9 and b[0] > a[0]
            ]
            a, b = max(segments, key=lambda pair: pair[1][0] - pair[0][0])
            if b[0] - a[0] < control.active_length_um:
                raise ValueError("No straight section can contain the specified actuator")
            heater = cell.add_ref(
                gf.components.straight(
                    length=control.active_length_um,
                    cross_section=gf.cross_section.heater_metal(
                        width=tech.heater_width_um, layer=tech.heater_layer
                    ),
                )
            )
            heater.dmove(((a[0] + b[0] - control.active_length_um) / 2, a[1]))
            cell.add_ports(heater.ports)
            actuators[name] = {
                "centerline_um": [list(map(float, heater.ports[p].center)) for p in ("e1", "e2")],
                "layer": list(tech.heater_layer),
                "width_um": float(heater.ports["e1"].width),
            }
            waveguide = cell
        else:
            waveguide.name = f"{name}_{ir.design_id}"
        references[name] = component.add_ref(waveguide, name=name)
        lengths[name] = float(path.length())
        centerlines[name] = path.points.tolist()

    def add_block(name: str, primitive_ids: dict[str, str], delta: float, origin: float) -> None:
        splitter = component.add_ref(coupler, name=primitive_ids["splitter"])
        combiner = component.add_ref(coupler, name=primitive_ids["combiner"])
        splitter.dmove((origin, 0))
        combiner.dmove((origin + 650, 0))
        references[primitive_ids["splitter"]] = splitter
        references[primitive_ids["combiner"]] = combiner
        for local, start_port, end_port, direction, height in [
            ("top_arm", "o3", "o2", 1, 150 + max(delta, 0) / 2),
            ("bottom_arm", "o4", "o1", -1, 150 + max(-delta, 0) / 2),
        ]:
            start, end = (
                tuple(splitter.ports[start_port].center),
                tuple(combiner.ports[end_port].center),
            )
            route_y = start[1] + direction * height
            points = np.array(
                [
                    start,
                    (start[0] + 100, start[1]),
                    (start[0] + 100, route_y),
                    (end[0] - 100, route_y),
                    (end[0] - 100, end[1]),
                    end,
                ]
            )
            path = gf.path.smooth(points, radius=tech.bend_radius_um, bend=gf.path.arc, npoints=128)
            add_path(primitive_ids[local], path)
        block_ports[name] = {
            "in0": splitter.ports["o1"],
            "in1": splitter.ports["o2"],
            "out0": combiner.ports["o4"],
            "out1": combiner.ports["o3"],
        }
        imbalances[name] = lengths[primitive_ids["top_arm"]] - lengths[primitive_ids["bottom_arm"]]

    if ir.specification.device == "ring_add_drop":
        spec = ir.specification
        top = component.add_ref(coupler, name="top_coupler")
        bottom = component.add_ref(coupler, name="bottom_coupler")
        top.dmove((0, spec.loop_height_um))
        bottom.drotate(180)
        bottom.dmove((40, 0))
        references.update(top_coupler=top, bottom_coupler=bottom)
        for name, start_port, end_port, direction in [
            ("right_return", top.ports["o4"], bottom.ports["o1"], 1),
            ("left_return", bottom.ports["o4"], top.ports["o1"], -1),
        ]:
            x, y = start_port.center
            ex, ey = end_port.center
            points = np.array(
                [
                    (x, y),
                    (x + direction * spec.side_extension_um, y),
                    (ex + direction * spec.side_extension_um, ey),
                    (ex, ey),
                ]
            )
            add_path(
                name,
                gf.path.smooth(points, radius=tech.bend_radius_um, bend=gf.path.arc, npoints=128),
            )
    elif ir.assembly is None:
        if ir.specification.device != "mzi":
            raise ValueError("An assembled design requires a physical assembly plan")
        add_block(
            "mzi",
            {n: n for n in ("splitter", "combiner", "top_arm", "bottom_arm")},
            ir.specification.delta_length_um,
            0,
        )
    else:
        origin = 0.0
        for block in ir.assembly.blocks:
            add_block(block.name, block.primitives, block.delta_length_um, origin)
            origin = (
                float(block_ports[block.name]["out0"].center[0])
                + ir.assembly.link_length_um
                - float(coupler.ports["o1"].center[0])
            )
        for link in ir.assembly.links:
            start = np.asarray(block_ports[link.a.instance][link.a.port].center)
            end = np.asarray(block_ports[link.b.instance][link.b.port].center)
            if end[0] <= start[0] or abs(end[1] - start[1]) > 1e-9:
                raise ValueError(
                    "Series assembly requires aligned forward-facing interconnect ports"
                )
            # Port placement snaps to the 0.001 µm database grid. Preserve the
            # requested intent; the verifier independently enforces this same
            # predeclared 1 nm physical-length tolerance after backannotation.
            if abs(float(np.linalg.norm(end - start)) - ir.assembly.link_length_um) > 0.001:
                raise ValueError("Physical interconnect does not meet the requested link length")
            add_path(link.instance, gf.Path(np.array([start, end])))

    for name, endpoint in ir.netlist.ports.items():
        component.add_port(name=name, port=references[endpoint.instance].ports[endpoint.port])
    # Derive connectivity from all placed primitive ports, including physical interconnects.
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
        "schema_version": "2.0",
        "top_cell": component.name,
        "technology": tech.name,
        "core_layer": list(tech.core_layer),
        "lengths_um": lengths,
        "centerlines_um": centerlines,
        "ports": ports,
        "extracted_circuit": extracted_circuit,
        "bend_radius_um": tech.bend_radius_um,
        "delta_length_um": imbalances.get("mzi") if ir.assembly is None else None,
        "path_imbalances_um": imbalances,
        "actuators": actuators,
    }
