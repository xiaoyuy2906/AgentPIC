"""Generate or check the public contracts: uv run python scripts/export_schemas.py."""

import argparse
import json
from pathlib import Path

from agentpic.api import create_app
from agentpic.ir import DesignSpec, EngineeringIR, RunResult, VerificationReport


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    destination = Path(__file__).resolve().parents[1] / "schemas"
    contracts = {
        "design-spec.schema.json": DesignSpec.model_json_schema(),
        "engineering-ir.schema.json": EngineeringIR.model_json_schema(),
        "run-result.schema.json": RunResult.model_json_schema(),
        "verification-report.schema.json": VerificationReport.model_json_schema(),
        "openapi.json": create_app().openapi(),
    }
    destination.mkdir(exist_ok=True)
    for name, contract in contracts.items():
        contents = json.dumps(contract, sort_keys=True, indent=2) + "\n"
        path = destination / name
        if args.check:
            if not path.exists() or path.read_text() != contents:
                raise SystemExit(f"Stale contract: {path}. Run scripts/export_schemas.py.")
        else:
            path.write_text(contents)


if __name__ == "__main__":
    main()
