"""Compile engineering intent into an explicit netlist and dependency graph."""

import hashlib
import json

from agentpic.ir import (
    Connection,
    DesignSpec,
    Endpoint,
    EngineeringIR,
    InstanceIR,
    NetlistIR,
    TaskIR,
    TechnologyIR,
)


def canonical_json(value: dict) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def compile_design(specification: DesignSpec | dict) -> EngineeringIR:
    spec = DesignSpec.model_validate(specification)
    design_id = hashlib.sha256(canonical_json(spec.model_dump()).encode()).hexdigest()[:16]

    def edge(a: str, ap: str, b: str, bp: str) -> Connection:
        return Connection(a=Endpoint(instance=a, port=ap), b=Endpoint(instance=b, port=bp))

    instances = [
        InstanceIR(
            name=name, kind="ideal_coupler", ports=["o1", "o2", "o3", "o4"], coupling_ratio=0.5
        )
        for name in ("splitter", "combiner")
    ] + [
        InstanceIR(name=name, kind="waveguide", ports=["o1", "o2"])
        for name in ("top_arm", "bottom_arm")
    ]
    return EngineeringIR(
        design_id=design_id,
        specification=spec,
        technology=TechnologyIR(),
        netlist=NetlistIR(
            instances=instances,
            connections=[
                edge("splitter", "o3", "top_arm", "o1"),
                edge("top_arm", "o2", "combiner", "o2"),
                edge("splitter", "o4", "bottom_arm", "o1"),
                edge("bottom_arm", "o2", "combiner", "o1"),
            ],
            ports={
                "in0": Endpoint(instance="splitter", port="o1"),
                "in1": Endpoint(instance="splitter", port="o2"),
                "out0": Endpoint(instance="combiner", port="o4"),
                "out1": Endpoint(instance="combiner", port="o3"),
            },
        ),
        workflow=[
            TaskIR(name="compile", depends_on=[], backend="agentpic"),
            TaskIR(name="layout", depends_on=["compile"], backend="gdsfactory"),
            TaskIR(name="backannotate", depends_on=["layout"], backend="agentpic"),
            TaskIR(name="simulate", depends_on=["backannotate"], backend="sax"),
            TaskIR(name="verify", depends_on=["simulate", "layout"], backend="agentpic"),
            TaskIR(name="manifest", depends_on=["verify"], backend="agentpic"),
        ],
        assumptions=[
            "sin_demo_v1 is an illustrative SiN process, not a foundry PDK.",
            "MMI polygons use ideal reciprocal 50:50 compact couplers; no EM calibration.",
            "Waveguide neff=1.8 and ng=1.9 at 1550 nm are explicit demonstration assumptions.",
            "Propagation loss is zero; bend loss, taper phase and coupler dispersion are omitted.",
            "Circuit propagation lengths are backannotated from physical path centerlines.",
        ],
    )


def backannotate(ir: EngineeringIR, lengths_um: dict[str, float]) -> EngineeringIR:
    resolved = ir.model_copy(deep=True)
    for instance in resolved.netlist.instances:
        if instance.kind == "waveguide":
            length = lengths_um[instance.name]
            if length <= 0:
                raise ValueError("layout waveguide lengths must be positive")
            instance.length_um = length
    resolved.layout_resolved = True
    return EngineeringIR.model_validate(resolved.model_dump())
