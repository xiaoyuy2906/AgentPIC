"""Versioned engineering contracts shared by the API, compiler and backends."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

OutputKind = Literal["netlist", "simulation", "gds", "verification"]


class TypedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, validate_default=True)


class DesignSpec(TypedModel):
    device: Literal["mzi"] = "mzi"
    platform: Literal["sin"] = "sin"
    wavelength_nm: float = Field(default=1550, ge=1500, le=1600)
    outputs: list[OutputKind] = Field(
        default_factory=lambda: ["netlist", "simulation", "gds", "verification"], min_length=1
    )
    delta_length_um: float = Field(default=10, ge=-200, le=200)
    sweep_span_nm: float = Field(default=40, gt=0, le=100)
    sweep_points: int = Field(default=201, ge=3, le=2001)

    @model_validator(mode="after")
    def valid_sweep(self) -> DesignSpec:
        if len(set(self.outputs)) != len(self.outputs):
            raise ValueError("outputs must not contain duplicates")
        if self.sweep_points % 2 == 0:
            raise ValueError("sweep_points must be odd so the design wavelength is sampled")
        if not (
            1450 <= self.wavelength_nm - self.sweep_span_nm / 2
            and self.wavelength_nm + self.sweep_span_nm / 2 <= 1650
        ):
            raise ValueError("the entire wavelength sweep must lie within 1450–1650 nm")
        return self


class TechnologyIR(TypedModel):
    name: Literal["sin_demo_v1"] = "sin_demo_v1"
    foundry: None = None
    calibrated: Literal[False] = False
    core_layer: tuple[int, int] = (1, 0)
    width_um: float = 1.0
    thickness_um: float = 0.4
    bend_radius_um: float = 50.0
    minimum_width_um: float = 0.5
    minimum_spacing_um: float = 0.5
    reference_wavelength_um: float = 1.55
    effective_index: float = 1.8
    group_index: float = 1.9
    loss_db_per_cm: float = 0.0
    model_version: Literal["ideal_sin_v1"] = "ideal_sin_v1"


class Endpoint(TypedModel):
    instance: str
    port: str

    def sax_key(self) -> str:
        return f"{self.instance},{self.port}"


class Connection(TypedModel):
    a: Endpoint
    b: Endpoint


class InstanceIR(TypedModel):
    name: str
    kind: Literal["ideal_coupler", "waveguide"]
    ports: list[str]
    length_um: float | None = Field(default=None, gt=0)
    coupling_ratio: float | None = Field(default=None, ge=0, le=1)


class NetlistIR(TypedModel):
    instances: list[InstanceIR]
    connections: list[Connection]
    ports: dict[str, Endpoint]


class TaskIR(TypedModel):
    name: str
    depends_on: list[str]
    backend: str


class EngineeringIR(TypedModel):
    schema_version: Literal["1.0"] = "1.0"
    design_id: str
    specification: DesignSpec
    technology: TechnologyIR
    netlist: NetlistIR
    workflow: list[TaskIR]
    layout_resolved: bool = False
    assumptions: list[str]


class CheckResult(TypedModel):
    id: str
    status: Literal["pass", "fail", "not_run"]
    detail: str
    evidence: dict = Field(default_factory=dict)


class VerificationReport(TypedModel):
    schema_version: Literal["1.0"] = "1.0"
    design_id: str
    status: Literal["passed_with_limitations", "failed"]
    checks: list[CheckResult]
    foundry_signoff: Literal[False] = False
    limitations: list[str]


class Artifact(TypedModel):
    name: str
    sha256: str
    size_bytes: int
    media_type: str


class RunResult(TypedModel):
    schema_version: Literal["1.0"] = "1.0"
    run_id: str
    design_id: str
    artifact_directory: str
    status: Literal["completed", "failed"]
    verification_status: Literal["passed_with_limitations", "failed", "not_run"]
    artifacts: list[Artifact]
    error: str | None = None


class ElectromagneticRequest(TypedModel):
    """Reserved contract. No implementation is advertised in milestone 1."""

    geometry_artifact: str
    wavelength_nm: list[float]
    material_map: dict[str, str]
    ports: list[str]


class ElectromagneticResult(TypedModel):
    backend: str
    model_artifact: str
    verification_artifact: str
