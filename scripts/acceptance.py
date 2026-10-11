"""Run the exact milestone specification through real HTTP and MCP transports."""

import argparse
import asyncio
import base64
import hashlib
import json
import socket
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from agentpic.runtime import write_json


async def mcp_acceptance(output: Path, specification: dict) -> dict:
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "agentpic.cli", "mcp", "--runs-dir", str(output / "runs")],
    )
    with (output / "mcp-server.log").open("w") as errors:
        async with stdio_client(parameters, errlog=errors) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await session.list_tools()
                response = await session.call_tool("design_pic", {"specification": specification})
                assert not response.isError, response
                run = response.structuredContent
                assert run["status"] == "completed", run
                report = await session.call_tool("verify_run", {"run_id": run["run_id"]})
                assert not report.isError, report
                assert report.structuredContent["status"] == "passed_with_limitations"
                resource = await session.read_resource(
                    f"agentpic://runs/{run['run_id']}/design.gds"
                )
                downloaded = base64.b64decode(resource.contents[0].blob)
                expected = Path(run["artifact_directory"]) / "design.gds"
                assert downloaded == expected.read_bytes()
                write_json(output / "mcp-response.json", run)
                write_json(output / "mcp-verification.json", report.structuredContent)
                return {"run": run, "tools": [tool.name for tool in tools.tools]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("runs/acceptance"))
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    specification = json.loads(
        (Path(__file__).resolve().parents[1] / "examples/mzi_1550.json").read_text()
    )
    write_json(output / "request.json", specification)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with (output / "http-server.log").open("w") as log:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "agentpic.cli",
                "serve",
                "--port",
                str(port),
                "--runs-dir",
                str(output / "runs"),
            ],
            stdout=log,
            stderr=log,
        )
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=120) as client:
                deadline = time.monotonic() + 30
                while True:
                    try:
                        ready = client.get("/v1/capabilities")
                        ready.raise_for_status()
                        break
                    except httpx.ConnectError:
                        if process.poll() is not None or time.monotonic() > deadline:
                            raise RuntimeError("HTTP server did not start; inspect http-server.log")
                        time.sleep(0.1)
                response = client.post("/v1/designs", json=specification)
                response.raise_for_status()
                run = response.json()
                assert run["status"] == "completed", run
                report = client.post(f"/v1/runs/{run['run_id']}/verify")
                report.raise_for_status()
                report = report.json()
                assert report["status"] == "passed_with_limitations", report
                download = client.get(f"/v1/runs/{run['run_id']}/artifacts/design.gds")
                download.raise_for_status()
                assert (
                    download.content
                    == (Path(run["artifact_directory"]) / "design.gds").read_bytes()
                )
                write_json(output / "http-response.json", run)
                write_json(output / "http-verification.json", report)
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    mcp = asyncio.run(mcp_acceptance(output, specification))
    first = {artifact["name"]: artifact["sha256"] for artifact in run["artifacts"]}
    second = {artifact["name"]: artifact["sha256"] for artifact in mcp["run"]["artifacts"]}
    stable = ["design.gds", "netlist.json", "simulation.json", "engineering_ir.json", "layout.json"]
    assert all(first[name] == second[name] for name in stable), "Transport runs are inconsistent"
    directory = Path(run["artifact_directory"])
    simulation = json.loads((directory / "simulation.json").read_text())
    layout = json.loads((directory / "layout.json").read_text())
    center = len(simulation["wavelength_nm"]) // 2
    summary = {
        "status": "passed_with_limitations",
        "http_run_id": run["run_id"],
        "mcp_run_id": mcp["run"]["run_id"],
        "design_id": run["design_id"],
        "http_artifact_directory": run["artifact_directory"],
        "mcp_tools": mcp["tools"],
        "transport_artifacts_identical": stable,
        "verification_counts": dict(Counter(c["status"] for c in report["checks"])),
        "not_run": [c["id"] for c in report["checks"] if c["status"] == "not_run"],
        "center_wavelength_nm": simulation["wavelength_nm"][center],
        "center_transmission": {
            name: simulation[name][center] for name in ("transmission_out0", "transmission_out1")
        },
        "lengths_um": layout["lengths_um"],
        "gds_sha256": hashlib.sha256(download.content).hexdigest(),
        "foundry_signoff": False,
    }
    write_json(output / "acceptance.json", summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
