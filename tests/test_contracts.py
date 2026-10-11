from graphlib import TopologicalSorter

import pytest
from pydantic import ValidationError

from agentpic.backends import ReservedElectromagneticBackend, capabilities
from agentpic.compiler import compile_design
from agentpic.ir import DesignSpec, ElectromagneticRequest, EngineeringIR


@pytest.mark.parametrize(
    "invalid",
    [
        {"device": "nanobeam"},
        {"platform": "silicon"},
        {"wavelength_nm": float("nan")},
        {"wavelength_nm": 0},
        {"sweep_points": 2},
        {"sweep_points": 100},
        {"outputs": ["gds", "gds"]},
        {"outputs": []},
        {"outputs": ["signoff"]},
        {"delta_length_um": 1000},
        {"pdk": "imaginary_foundry"},
    ],
)
def test_rejects_unsupported_or_invalid_requirements(invalid):
    with pytest.raises(ValidationError):
        DesignSpec.model_validate(invalid)


def test_compiler_normalizes_and_roundtrips(example_spec):
    ir = compile_design(example_spec)
    assert ir.design_id == compile_design({}).design_id
    assert EngineeringIR.model_validate_json(ir.model_dump_json()) == ir
    assert not ir.layout_resolved
    order = list(TopologicalSorter({t.name: t.depends_on for t in ir.workflow}).static_order())
    assert order.index("layout") < order.index("backannotate") < order.index("simulate")
    assert len(ir.netlist.instances) == 4
    assert len(ir.netlist.connections) == 4
    assert not ir.technology.calibrated


def test_reserved_em_backends_are_explicitly_unsupported():
    request = ElectromagneticRequest(
        geometry_artifact="design.gds", wavelength_nm=[1550], material_map={"1/0": "sin"}, ports=[]
    )
    for name in ("fdtdx", "fem", "eme"):
        assert capabilities()["electromagnetic"][name] == "not_implemented"
        with pytest.raises(NotImplementedError):
            ReservedElectromagneticBackend(name).solve(request)
