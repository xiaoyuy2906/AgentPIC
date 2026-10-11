import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from agentpic.runtime import Runtime


def test_full_acceptance_artifacts(accepted_run):
    runtime, result = accepted_run
    directory = Path(result.artifact_directory)
    for name in (
        "netlist.json",
        "engineering_ir.json",
        "simulation.json",
        "spectrum.csv",
        "design.gds",
        "verification.json",
        "manifest.json",
        "provenance.json",
    ):
        assert (directory / name).stat().st_size > 0
    report = runtime.verify_run(result.run_id)
    assert report.status == "passed_with_limitations"
    assert len([c for c in report.checks if c.status == "pass"]) >= 19
    assert {c.id for c in report.checks if c.status == "not_run"} == {
        "electromagnetic_calibration",
        "measurement_validation",
        "foundry_signoff",
    }
    assert not report.foundry_signoff
    tasks = json.loads((directory / "workflow.json").read_text())["tasks"]
    assert all(task["state"] == "completed" for task in tasks)
    events = [json.loads(line) for line in (directory / "events.jsonl").read_text().splitlines()]
    assert len(events) == 2 * len(tasks)
    provenance = json.loads((directory / "provenance.json").read_text())
    assert provenance["packages"]["sax"] == "0.18.2"
    assert provenance["packages"]["gdsfactory"] == "9.51.0"
    assert len(provenance["uv_lock_sha256"]) == 64


@pytest.mark.parametrize("imbalance", [-200, -10, 0, 10, 200])
def test_physical_imbalance_and_analytic_interference(tmp_path, imbalance):
    runtime = Runtime(tmp_path)
    result = runtime.run({"delta_length_um": imbalance, "sweep_points": 21})
    assert result.status == "completed", result.model_dump()
    directory = Path(result.artifact_directory)
    simulation = json.loads((directory / "simulation.json").read_text())
    layout = json.loads((directory / "layout.json").read_text())
    assert layout["delta_length_um"] == pytest.approx(imbalance, abs=0.002)
    # Independent textbook formula at the specified reference wavelength.
    expected_bar = np.sin(np.pi * 1.8 * imbalance / 1.55) ** 2
    assert simulation["transmission_out0"][10] == pytest.approx(expected_bar, abs=1e-9)
    assert simulation["transmission_out1"][10] == pytest.approx(1 - expected_bar, abs=1e-9)


def test_core_engineering_artifacts_are_reproducible(accepted_run, example_spec):
    runtime, first = accepted_run
    second = runtime.run(example_spec)
    assert second.status == "completed"
    assert first.run_id != second.run_id
    for filename in (
        "specification.json",
        "engineering_ir.json",
        "netlist.json",
        "simulation.json",
        "design.gds",
        "layout.json",
        "layout.svg",
    ):
        a = runtime.artifact_path(first.run_id, filename).read_bytes()
        b = runtime.artifact_path(second.run_id, filename).read_bytes()
        assert hashlib.sha256(a).digest() == hashlib.sha256(b).digest(), filename


def test_backend_failure_is_persisted_and_downstream_tasks_are_blocked(tmp_path):
    class BrokenSimulator:
        name = "broken_test_backend"

        def simulate(self, ir):
            raise RuntimeError("injected simulator failure")

    runtime = Runtime(tmp_path, circuit_backend=BrokenSimulator())
    result = runtime.run({})
    assert result.status == "failed"
    assert result.verification_status == "not_run"
    assert "injected simulator failure" in result.error
    assert runtime.get_run(result.run_id) == result
    tasks = json.loads((Path(result.artifact_directory) / "workflow.json").read_text())["tasks"]
    states = {t["name"]: t["state"] for t in tasks}
    assert states["simulate"] == "failed"
    assert states["verify"] == states["manifest"] == "blocked"


def test_artifact_paths_cannot_escape_run_directory(accepted_run):
    runtime, result = accepted_run
    with pytest.raises(FileNotFoundError):
        runtime.artifact_path(result.run_id, "../../uv.lock")
    with pytest.raises(FileNotFoundError):
        runtime.get_run("../")
