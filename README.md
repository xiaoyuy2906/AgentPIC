# AgentPIC

[![CI](https://github.com/xiaoyuy2906/AgentPIC/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaoyuy2906/AgentPIC/actions/workflows/ci.yml)

An agent-native photonic integrated circuit EDA platform. Submit an engineering specification through HTTP or MCP and receive a circuit netlist, SAX simulation, GDSFactory layout, GDS, and independent verification evidence. No GUI, GPU, paid solver, or language-model API is required.

**Milestone 1: an executable SiN Mach–Zehnder interferometer design loop.** AgentPIC owns the typed Engineering IR, design compiler, workflow runtime, interfaces and verification engine. SAX and GDSFactory are replaceable backend adapters.

这是第一个机器接口驱动的 PIC 设计闭环：输入设计要求，自动生成网表、光谱、真实 GDS 和结构化验证报告。当前使用示例 SiN 工艺及理想紧凑模型；数学与几何检查通过不代表物理校准或晶圆厂签核。

## Run the first design

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then:

```sh
git clone https://github.com/xiaoyuy2906/AgentPIC.git
cd AgentPIC
uv sync --locked
uv run agentpic design examples/mzi_1550.json
```

uv creates and manages `.venv`. Python 3.12–3.13 is supported; `.python-version` selects 3.13. All dependency versions are recorded in `uv.lock`.

The example contains the milestone's exact request:

```json
{
  "device": "mzi",
  "platform": "sin",
  "wavelength_nm": 1550,
  "outputs": ["netlist", "simulation", "gds", "verification"]
}
```

The JSON response contains `run_id`, `artifact_directory`, artifact hashes, `status` and `verification_status`. A successful run reports `completed` with `passed_with_limitations`. Inspect each check in `verification.json`, including `not_run` checks. To repeat verification:

```sh
uv run agentpic verify <run_id>
```

Each invocation creates a separate directory under `runs/`. Override it with `--runs-dir /path/to/runs` or `AGENTPIC_RUNS_DIR`. CLI exit codes are 0 for completion, 1 for a failed workflow/verification, and 2 for invalid input or an unavailable run.

## HTTP API

Start a local server:

```sh
uv run agentpic serve --host 127.0.0.1 --port 8000
```

Then submit the design from another terminal or an agent:

```sh
curl --fail-with-body http://127.0.0.1:8000/v1/designs \
  -H 'Content-Type: application/json' \
  --data-binary @examples/mzi_1550.json
```

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/capabilities` | Supported and explicitly unsupported capabilities |
| POST | `/v1/compile` | Validate specification and return unresolved Engineering IR |
| POST | `/v1/designs` | Execute the complete design workflow synchronously |
| GET | `/v1/runs/{run_id}` | Retrieve persisted result and artifact hashes |
| POST | `/v1/runs/{run_id}/verify` | Repeat independent verification and check artifact hashes |
| GET | `/v1/runs/{run_id}/artifacts/{name}` | Download an artifact, including `design.gds` |
| GET | `/openapi.json` | Machine-readable API contract |

Invalid specifications return HTTP 422; unknown runs/artifacts return 404. Engineering failures return a persisted result with `status: failed`; agents must inspect the result even when HTTP transport succeeds. The service is intended for trusted local use and has no authentication, remote job queue, or multi-tenant isolation.

## MCP

Use the standard stdio transport:

```sh
uv run agentpic mcp --runs-dir /absolute/path/to/runs
```

For an MCP client that uses `mcpServers` configuration, replace the paths below:

```json
{
  "mcpServers": {
    "agentpic": {
      "command": "uv",
      "args": [
        "--directory", "/absolute/path/to/AgentPIC", "run", "--locked",
        "agentpic", "mcp", "--runs-dir", "/absolute/path/to/AgentPIC/runs"
      ]
    }
  }
}
```

Tools: `get_capabilities`, `get_design_schema`, `compile_pic`, `design_pic`, `get_run`, `verify_run`. `design_pic` accepts `{"specification": {...}}`, where the inner object is the exact design request above. Outputs are structured according to the Pydantic-generated schemas. Artifacts are MCP resources at `agentpic://runs/{run_id}/{name}`; the stdio SDK transports binary GDS as a base64 blob.

An agent should discover capabilities, submit the specification, inspect the run status, read the verification report, and download the artifact. Unsupported devices/platforms are rejected instead of being silently substituted.

## Artifacts and reproducibility

| Artifact | Contents |
|---|---|
| `specification.json` | Validated input with explicit defaults and units |
| `compiled_ir.json` | Intended topology, technology assumptions and task dependencies |
| `engineering_ir.json`, `netlist.json` | Resolved IR/netlist with physical arm lengths |
| `layout.json` | Actual centerlines, physical ports and extracted layout netlist |
| `design.gds`, `layout.svg` | Real hierarchical GDS and a static preview derived from it |
| `simulation.json`, `spectrum.csv` | Complex 4×4 S-matrix and optical power spectrum |
| `verification.json` | Individual check results, evidence and explicit limitations |
| `workflow.json`, `events.jsonl` | Task states, dependencies, timing and failure records |
| `provenance.json` | Backend versions, Python/platform, source hash, lock hash and Git state |
| `manifest.json`, `run.json` | Result metadata and SHA-256 artifact inventory |

Identical normalized input has a stable `design_id`; each execution has a unique `run_id`. Timestamps and run IDs are intentionally variable. Core engineering outputs, including GDS with timestamps disabled, are checked for byte-for-byte reproducibility within the same locked environment. Cross-platform bitwise identity is not promised. The `outputs` field records requested deliverables; milestone 1 always emits the full evidence set needed to verify them. It does not disable internal verification.

## What is verified

The independent verifier reads saved JSON and reopens exported GDS with KLayout. It does not call the layout builder or SAX compact-model functions.

- Intended graph connectivity, extracted physical-port netlist agreement and port alignment.
- Physical centerline lengths and requested arm imbalance.
- Full complex SAX response against a separately coded analytic MZI, wavelength sampling, reciprocity, passivity and lossless power balance.
- GDS readback, connected core geometry, centerline containment, 0.5 µm minimum width/spacing and 50 µm bend-radius demonstration rules.
- Recorded SHA-256 hashes when a saved run is reverified.

The default case has 18 passing engineering checks. Reverification adds the artifact-integrity check for 19 passes. Both explicitly report three `not_run` checks: electromagnetic calibration, measurement validation, and foundry signoff.

## Model scope and unsupported work

`sin_demo_v1` assumes a 1 µm wide, 0.4 µm thick SiN core, effective index 1.8, group index 1.9 at 1550 nm, and zero propagation loss. Two ideal reciprocal 50:50 couplers connect two routed waveguides. MMI polygons are present in the GDS, but their optical behavior has **not** been calibrated to the ideal coupler model. GDS encodes planar geometry; the nominal thickness is an IR assumption. See [model equations and validity](docs/models-and-verification.md).

This is a parameterized MZI compiler, not arbitrary photonic topology synthesis. Supported input ranges are documented in [the interface contract](docs/interfaces.md). FDTDX, FEM and EME have reserved interfaces and raise `NotImplementedError`. Mode solving, EM simulation, optimization, thermal effects, foundry PDK integration, full foundry DRC/LVS, fabrication packaging and signoff are not implemented. No fabrication readiness is claimed.

## Development and acceptance

```sh
uv sync --locked
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
uv run python scripts/export_schemas.py --check
uv run pytest -q
uv run python scripts/acceptance.py --output runs/acceptance
```

The acceptance script launches a real local HTTP server and MCP stdio server, submits the exact example through each, retrieves binary GDS, repeats verification, and compares the core artifact hashes. It saves the responses, reports, server logs and `acceptance.json`. Both servers shut down when it finishes. GitHub CI runs tests and this acceptance procedure on Linux with Python 3.12 and 3.13, and uploads the evidence.

See [architecture decisions](docs/architecture.md), [tool research](docs/research.md), [persistent progress](docs/progress.md), and [generated schemas](schemas/). AgentPIC source is MIT licensed; upstream dependencies retain their own licenses.
