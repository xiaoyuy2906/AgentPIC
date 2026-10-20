"""The PDK data file must agree with the cells and models the backends actually provide."""

import json
import subprocess
from pathlib import Path

import pytest

from agentpic.backends.circuit import simulate
from agentpic.backends.layout import build_layout
from agentpic.ir import PDK, EngineeringIR

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def compiled():
    output = subprocess.check_output(
        ["node", "--import", "tsx", "core/src/cli.ts", "compile", "designs/mzi.json"], cwd=ROOT
    )
    return EngineeringIR.model_validate_json(output, strict=True)


def test_pdk_data_file_validates_against_the_generated_contract():
    pdk = PDK.model_validate_json((ROOT / "pdks/sin_demo_v1.json").read_text(), strict=True)
    assert pdk.cross_sections["strip"].mode.source.kind == "characterization"
    assert pdk.components["ideal_coupler"].source.kind == "assumption"
    assert pdk.materials["silicon_nitride"].source.kind == "literature"
    assert {p.name for p in pdk.components["ideal_coupler"].ports} == {"o1", "o2", "o3", "o4"}


def test_a_cell_that_disagrees_with_its_declared_ports_is_a_pdk_error(compiled, tmp_path):
    ir = compiled.model_copy(deep=True)
    ir.technology.components["ideal_coupler"].ports[2].position_um = (51.0, 1.25)
    with pytest.raises(ValueError, match="port o3 is not where the PDK says"):
        build_layout(ir, tmp_path)


def test_a_model_the_backend_does_not_implement_is_rejected(compiled):
    ir = compiled.model_copy(deep=True)
    ir.technology.components["waveguide"].model.version = "calibrated_waveguide_v9"
    with pytest.raises(ValueError, match="does not implement waveguide calibrated_waveguide_v9"):
        simulate(ir)


def test_simulation_uses_the_pdk_mode_model(compiled):
    ir = compiled.model_copy(deep=True)
    baseline = simulate(ir)
    ir.technology.cross_sections["strip"].mode.effective_index += 0.01
    shifted = simulate(ir)
    assert json.dumps(baseline["s_real"]) != json.dumps(shifted["s_real"])
