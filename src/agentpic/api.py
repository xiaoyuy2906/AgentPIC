"""HTTP API with an automatically generated OpenAPI contract."""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from agentpic.backends import capabilities
from agentpic.compiler import compile_design
from agentpic.ir import DesignSpec, EngineeringIR, RunResult, VerificationReport
from agentpic.runtime import Runtime


def create_app(runs_dir: str | Path | None = None) -> FastAPI:
    app = FastAPI(
        title="AgentPIC", version="0.1.0", description="Agent-native PIC EDA, milestone 1"
    )
    runtime = Runtime(runs_dir)
    app.state.runtime = runtime

    @app.get("/v1/capabilities")
    def get_capabilities() -> dict:
        return capabilities()

    @app.post("/v1/compile", response_model=EngineeringIR)
    def compile_specification(specification: DesignSpec) -> EngineeringIR:
        return compile_design(specification)

    @app.post("/v1/designs", response_model=RunResult)
    def design(specification: DesignSpec) -> RunResult:
        return runtime.run(specification)

    @app.get("/v1/runs/{run_id}", response_model=RunResult)
    def get_run(run_id: str) -> RunResult:
        try:
            return runtime.get_run(run_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/v1/runs/{run_id}/verify", response_model=VerificationReport)
    def verify(run_id: str) -> VerificationReport:
        try:
            return runtime.verify_run(run_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/v1/runs/{run_id}/artifacts/{name}")
    def artifact(run_id: str, name: str) -> FileResponse:
        try:
            path = runtime.artifact_path(run_id, name)
            return FileResponse(path, filename=name)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return app
