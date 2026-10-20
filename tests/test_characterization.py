"""FDTDX characterization: extrapolation, material data, evidence integrity and the slab check."""

import json
import subprocess
from pathlib import Path

import pytest

from agentpic.characterize import CRITERIA, GRIDS_UM, richardson, sellmeier, slab_reference
from agentpic.ir import EngineeringIR
from agentpic.verification import verify_models

ROOT = Path(__file__).resolve().parents[1]
PDK = json.loads((ROOT / "pdks/sin_demo_v1.json").read_text())


def test_richardson_recovers_a_known_limit_and_order():
    values = [1.5 + 0.3 * h**1.7 for h in GRIDS_UM]
    fit = richardson(GRIDS_UM, values)
    assert fit["observed_order"] == pytest.approx(1.7, abs=1e-6)
    assert fit["extrapolated"] == pytest.approx(1.5, abs=1e-9)


def test_sellmeier_data_reproduces_published_indices_at_1550_nm():
    assert sellmeier(PDK["materials"]["silicon_dioxide"], 1.55) == pytest.approx(1.44402, abs=1e-5)
    assert sellmeier(PDK["materials"]["silicon_nitride"], 1.55) == pytest.approx(1.99628, abs=1e-5)


def test_strip_mode_model_is_the_accepted_characterization_evidence():
    mode = PDK["cross_sections"]["strip"]["mode"]
    assert mode["source"]["kind"] == "characterization"
    evidence = json.loads((ROOT / mode["source"]["evidence"]).read_text())
    assert evidence["accepted"] and all(evidence["passed"].values())
    assert abs(evidence["validation"]["error"]) <= CRITERIA["slab_validation_error"]
    assert evidence["mode"]["effective_index"] == mode["effective_index"]
    assert evidence["mode"]["group_index"] == mode["group_index"]
    assert len(evidence["runs"]) == 4 * len(GRIDS_UM)


@pytest.fixture(scope="module")
def chain():
    output = subprocess.check_output(
        ["node", "--import", "tsx", "core/src/cli.ts", "compile", "designs/waveguide_chain.json"],
        cwd=ROOT,
    )
    return EngineeringIR.model_validate_json(output, strict=True)


def test_verification_accepts_matching_evidence_and_rejects_tampering(chain):
    status = {c.id: c.status for c in verify_models(chain)}
    assert status == {"mode_characterization": "pass", "electromagnetic_characterization": "pass"}
    for tamper in ("index", "evidence"):
        ir = chain.model_copy(deep=True)
        mode = ir.technology.cross_sections["strip"].mode
        if tamper == "index":
            mode.effective_index += 1e-4
        else:
            mode.source.evidence = "pdks/missing.json"
        found = {c.id: c.status for c in verify_models(ir)}
        assert found["mode_characterization"] == "fail", tamper


def test_fdtdx_reproduces_the_analytic_slab_within_the_validation_criterion():
    pytest.importorskip("fdtdx")
    from agentpic.backends.fdtd import propagation_index

    core = sellmeier(PDK["materials"]["silicon_nitride"], 1.55)
    cladding = sellmeier(PDK["materials"]["silicon_dioxide"], 1.55)
    values = [
        propagation_index(1.55, core, cladding, None, 0.4, grid)["effective_index"]
        for grid in GRIDS_UM
    ]
    fit = richardson(GRIDS_UM, values)
    error = fit["extrapolated"] - slab_reference(1.55, core, cladding, 0.4)
    assert abs(error) <= CRITERIA["slab_validation_error"]
