import json
from pathlib import Path

import pytest

from agentpic.runtime import Runtime


@pytest.fixture(scope="session")
def example_spec():
    return json.loads((Path(__file__).parents[1] / "examples/mzi_1550.json").read_text())


@pytest.fixture(scope="session")
def accepted_run(tmp_path_factory, example_spec):
    runtime = Runtime(tmp_path_factory.mktemp("runs"))
    result = runtime.run(example_spec)
    assert result.status == "completed", result.model_dump()
    return runtime, result
