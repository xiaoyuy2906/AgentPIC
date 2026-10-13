"""One JSON request/response per process. No engineering compiler or workflow logic."""

import contextlib
import json
import sys
from importlib.metadata import version
from pathlib import Path
from typing import Any

from agentpic.ir import EngineeringIR, LayoutResult, PhysicsConfiguration, SimulationResult


def dispatch(request: dict[str, Any]) -> dict[str, Any] | list[dict[str, Any]]:
    operation = request["operation"]
    if operation == "versions":
        return {
            name: version(name)
            for name in (
                "sax",
                "gdsfactory",
                "jax",
                "jaxlib",
                "klayout",
                "numpy",
                "pydantic",
                "scipy",
            )
        }
    if operation in {"fdtdx", "fem", "eme"}:
        raise NotImplementedError(f"{operation} is reserved, not implemented")
    if operation in {"mode_planar_te", "reference_planar_te"}:
        from agentpic.backends.planar_modes import solve

        configuration = PhysicsConfiguration.model_validate_json(
            json.dumps(request["configuration"]), strict=True
        )
        return solve(configuration, reference=operation == "reference_planar_te").model_dump(
            mode="json"
        )
    ir = EngineeringIR.model_validate_json(json.dumps(request["ir"]), strict=True)
    if operation == "simulate":
        from agentpic.backends.circuit import simulate

        return SimulationResult.model_validate(simulate(ir)).model_dump(mode="json")
    if operation == "layout":
        from agentpic.backends.layout import build_layout
        from agentpic.backends.preview import write_preview

        directory = Path(request["directory"])
        directory.mkdir(parents=True, exist_ok=True)
        result = LayoutResult.model_validate(build_layout(ir, directory)).model_dump(mode="json")
        write_preview(directory, result)
        return result
    if operation == "verify_simulation":
        from agentpic.verification import verify_simulation

        simulation = SimulationResult.model_validate(request["simulation"]).model_dump(mode="json")
        return [c.model_dump(mode="json") for c in verify_simulation(ir, simulation)]
    if operation == "verify_geometry":
        from agentpic.verification import verify_geometry

        layout = LayoutResult.model_validate(request["layout"]).model_dump(mode="json")
        return [
            c.model_dump(mode="json")
            for c in verify_geometry(ir, layout, Path(request["directory"]) / "design.gds")
        ]
    raise ValueError(f"Unknown backend operation: {operation}")


def main() -> None:
    try:
        request = json.load(sys.stdin)
        # Backend logging must not corrupt the machine protocol on stdout.
        with contextlib.redirect_stdout(sys.stderr):
            result = dispatch(request)
        print(json.dumps({"ok": True, "result": result}, allow_nan=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
