import json
import shutil

import klayout.db as kdb
import pytest

from agentpic.verification import verify_artifacts


@pytest.fixture
def copied_run(accepted_run, tmp_path):
    _, result = accepted_run
    directory = tmp_path / "modified"
    shutil.copytree(result.artifact_directory, directory)
    return directory, result


def test_detects_wrong_simulation_not_just_success_status(copied_run):
    directory, _ = copied_run
    path = directory / "simulation.json"
    data = json.loads(path.read_text())
    data["s_real"][100][2][0] += 0.25
    path.write_text(json.dumps(data))
    report = verify_artifacts(directory)
    assert report.status == "failed"
    assert next(c for c in report.checks if c.id == "analytic_mzi_agreement").status == "fail"


def test_detects_layout_connectivity_mismatch(copied_run):
    directory, _ = copied_run
    path = directory / "layout.json"
    data = json.loads(path.read_text())
    data["extracted_netlist"]["nets"].pop()
    path.write_text(json.dumps(data))
    report = verify_artifacts(directory)
    assert next(c for c in report.checks if c.id == "layout_netlist_agreement").status == "fail"


def test_detects_broken_gds_geometry(copied_run):
    directory, _ = copied_run
    metadata = json.loads((directory / "layout.json").read_text())
    layout = kdb.Layout()
    layout.dbu = 0.001
    top = layout.create_cell(metadata["top_cell"])
    layer = layout.layer(1, 0)
    top.shapes(layer).insert(kdb.Box(0, 0, 1000, 1000))
    top.shapes(layer).insert(kdb.Box(5000, 0, 6000, 1000))
    layout.write(str(directory / "design.gds"))
    report = verify_artifacts(directory)
    failed = {c.id for c in report.checks if c.status == "fail"}
    assert "gds_connected_core" in failed
    assert "gds_contains_arm_centerlines" in failed


def test_detects_checksum_tampering_and_missing_artifact(copied_run):
    directory, original = copied_run
    (directory / "spectrum.csv").unlink()
    report = verify_artifacts(directory, original.artifacts)
    integrity = next(c for c in report.checks if c.id == "artifact_integrity")
    assert report.status == "failed"
    assert "spectrum.csv" in integrity.evidence["mismatches"]


def test_invalid_json_is_a_failed_report(copied_run):
    directory, _ = copied_run
    (directory / "engineering_ir.json").write_text("not JSON")
    report = verify_artifacts(directory)
    assert report.status == "failed"
    assert not report.foundry_signoff
