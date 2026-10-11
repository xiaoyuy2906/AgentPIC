"""MCP tools and artifact resources over the standard stdio transport."""

from pathlib import Path

from mcp.server.fastmcp import FastMCP

from agentpic.backends import capabilities
from agentpic.compiler import compile_design
from agentpic.ir import DesignSpec, EngineeringIR, RunResult, VerificationReport
from agentpic.runtime import Runtime


def create_server(runs_dir: str | Path | None = None) -> FastMCP:
    runtime = Runtime(runs_dir)
    server = FastMCP(
        "AgentPIC",
        instructions="Design and verify PICs. Milestone 1 supports illustrative SiN MZIs only. "
        "Always inspect verification.json and its not_run checks; no foundry signoff is available.",
    )

    @server.tool()
    def get_capabilities() -> dict:
        """Discover supported devices, backends and explicit unsupported capabilities."""
        return capabilities()

    @server.tool()
    def get_design_schema() -> dict:
        """Return the JSON Schema accepted by compile_pic and design_pic."""
        return DesignSpec.model_json_schema()

    @server.tool()
    def compile_pic(specification: DesignSpec) -> EngineeringIR:
        """Compile PIC requirements to an unresolved typed IR and explicit workflow DAG."""
        return compile_design(specification)

    @server.tool()
    def design_pic(specification: DesignSpec) -> RunResult:
        """Execute layout, SAX simulation, independent verification and GDS export."""
        return runtime.run(specification)

    @server.tool()
    def get_run(run_id: str) -> RunResult:
        """Retrieve a completed or failed run and its artifact checksums."""
        return runtime.get_run(run_id)

    @server.tool()
    def verify_run(run_id: str) -> VerificationReport:
        """Reread saved artifacts, verify hashes, and independently repeat all available checks."""
        return runtime.verify_run(run_id)

    @server.resource("agentpic://runs/{run_id}/{name}")
    def artifact(run_id: str, name: str) -> bytes:
        """Read a saved artifact, including binary GDS, from a known run."""
        return runtime.artifact_path(run_id, name).read_bytes()

    return server
