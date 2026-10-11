"""Replaceable adapters, with contracts owned by AgentPIC."""

from pathlib import Path
from typing import Protocol

from agentpic.ir import ElectromagneticRequest, ElectromagneticResult, EngineeringIR


class LayoutBackend(Protocol):
    name: str

    def build(self, ir: EngineeringIR, directory: Path) -> dict: ...


class CircuitBackend(Protocol):
    name: str

    def simulate(self, ir: EngineeringIR) -> dict: ...


class ElectromagneticBackend(Protocol):
    name: str

    def solve(self, request: ElectromagneticRequest) -> ElectromagneticResult: ...


class ReservedElectromagneticBackend:
    def __init__(self, name: str):
        if name not in {"fdtdx", "fem", "eme"}:
            raise ValueError(f"Unknown reserved backend: {name}")
        self.name = name

    def solve(self, request: ElectromagneticRequest) -> ElectromagneticResult:
        raise NotImplementedError(f"{self.name} is reserved, not implemented in milestone 1")


def capabilities() -> dict:
    return {
        "schema_version": "1.0",
        "devices": ["mzi"],
        "platforms": ["sin"],
        "technology": "sin_demo_v1",
        "circuit": {"backend": "sax", "status": "implemented"},
        "layout": {"backend": "gdsfactory", "status": "implemented"},
        "electromagnetic": {name: "not_implemented" for name in ("fdtdx", "fem", "eme")},
        "foundry_signoff": False,
        "physical_model_calibration": "not_performed",
    }
