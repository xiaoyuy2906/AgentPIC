"""GDSFactory adapter. No GUI and no implicit foundry PDK."""

from pathlib import Path

import numpy as np

from agentpic.ir import EngineeringIR


class GDSFactoryBackend:
    name = "gdsfactory"

    def build(self, ir: EngineeringIR, directory: Path) -> dict:
        return build_layout(ir, directory)


def build_layout(ir: EngineeringIR, directory: Path) -> dict:
    import gdsfactory as gf
    import klayout.db as kdb

    gf.gpdk.PDK.activate()
    gf.clear_cache()
    tech = ir.technology
    cross_section = gf.cross_section.strip(
        width=tech.width_um, layer=tech.core_layer, radius=tech.bend_radius_um
    )
    component = gf.Component(f"agentpic_mzi_{ir.design_id}")
    coupler = gf.components.mmi2x2(
        width=tech.width_um,
        width_taper=1.5,
        length_taper=10,
        length_mmi=40,
        width_mmi=5,
        gap_mmi=1,
        cross_section=cross_section,
    )
    splitter = component.add_ref(coupler, name="splitter")
    combiner = component.add_ref(coupler, name="combiner")
    combiner.dmove((650, 0))
    references = {"splitter": splitter, "combiner": combiner}
    lengths = {}
    centerlines = {}
    delta = ir.specification.delta_length_um
    arms = [
        ("top_arm", "o3", "o2", 1, 150 + max(delta, 0) / 2),
        ("bottom_arm", "o4", "o1", -1, 150 + max(-delta, 0) / 2),
    ]
    for name, start_port, end_port, direction, height in arms:
        start = tuple(splitter.ports[start_port].center)
        end = tuple(combiner.ports[end_port].center)
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
        waveguide = gf.path.extrude(path, cross_section=cross_section)
        waveguide.name = f"{name}_{ir.design_id}"
        references[name] = component.add_ref(waveguide, name=name)
        lengths[name] = float(path.length())
        centerlines[name] = path.points.tolist()

    for name, endpoint in ir.netlist.ports.items():
        component.add_port(name=name, port=references[endpoint.instance].ports[endpoint.port])

    # Derive connectivity from placed component ports, not from compiler edges.
    extracted = component.get_netlist(
        on_multi_connect="error", on_dangling_port="error", instance_namer=lambda ref: ref.name
    )

    def endpoint(key):
        instance, port = key.split(",")
        return {"instance": instance, "port": port}

    extracted_circuit = {
        "instances": [
            {
                **instance.model_dump(mode="json"),
                "ports": [
                    {"name": port.name, "domain": "optical", "direction": "bidirectional"}
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
    ports = {}
    for name, ref in references.items():
        ports[name] = {
            port.name: {
                "center_um": list(map(float, port.center)),
                "orientation_deg": float(port.orientation),
                "width_um": float(port.width),
            }
            for port in ref.ports
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
        "delta_length_um": lengths["top_arm"] - lengths["bottom_arm"],
    }
