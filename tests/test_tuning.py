"""Contract and numerical evaluation-budget tests at the scientific process boundary."""

import json
import subprocess
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from agentpic.backends import tuning
from agentpic.ir import DesignSpec, EngineeringIR, ResolvedTuningVariable

ROOT = Path(__file__).resolve().parents[1]
SPEC = TypeAdapter(DesignSpec)


@pytest.fixture(scope="module")
def circuit():
    output = subprocess.check_output(
        ["node", "--import", "tsx", "core/src/cli.ts", "compile", "designs/mzi_target.json"],
        cwd=ROOT,
    )
    return EngineeringIR.model_validate_json(output, strict=True)


def test_generated_tuning_contract_round_trip():
    parsed = SPEC.validate_json((ROOT / "designs/mzi_cascade_target.json").read_text(), strict=True)
    assert len(parsed.tuning.variables) == 2
    assert len(parsed.tuning.targets) == 3
    assert SPEC.validate_json(parsed.model_dump_json(), strict=True) == parsed


@pytest.mark.parametrize(
    "field,value",
    [
        ("max_evaluations", 0),
        ("max_evaluations", 513),
        ("power_tolerance", 0),
        ("power_tolerance", 1e-10),
    ],
)
def test_generated_tuning_limits(field, value):
    source = json.loads((ROOT / "designs/mzi_target.json").read_text())
    source["tuning"][field] = value
    with pytest.raises(ValidationError):
        SPEC.validate_json(json.dumps(source), strict=True)


@pytest.mark.parametrize("budget", [1, 2, 9, 13])
def test_budget_counts_actual_sax_calls_including_jacobian(monkeypatch, circuit, budget):
    ir = circuit.model_copy(deep=True)
    ir.specification.tuning.max_evaluations = budget
    original = tuning.build_circuit
    calls = []

    def instrumented(ir):
        model, ports = original(ir)

        def counted(**kwargs):
            calls.append(kwargs)
            return model(**kwargs)

        return counted, ports

    monkeypatch.setattr(tuning, "build_circuit", instrumented)
    variable = ir.specification.tuning.variables[0]
    result = tuning.optimize(
        ir,
        [
            ResolvedTuningVariable(
                instance="top_arm",
                min_phase_rad=variable.min_phase_rad,
                max_phase_rad=variable.max_phase_rad,
            )
        ],
    )
    assert result.status == "budget_exhausted"
    assert result.evaluations == len(result.evaluation_trace) == len(calls) == budget
    for call, entry in zip(calls, result.evaluation_trace, strict=True):
        assert call["top_arm"]["phase_rad"] == entry.controls["top_arm"]
