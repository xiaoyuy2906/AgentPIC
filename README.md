# AgentPIC

[![CI](https://github.com/xiaoyuy2906/AgentPIC/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaoyuy2906/AgentPIC/actions/workflows/ci.yml)

An agent-native photonic circuit EDA platform with a **TypeScript engineering core** and **Python scientific backends**. Submit a single or cascaded MZI specification through API or MCP and receive circuit JSON, SAX simulation, GDSFactory layout, real GDS and a structured verification report. No GUI or paid solver is required.

**ADR-001 is accepted:** engineering logic lives in TypeScript; scientific libraries are replaceable adapters. Zod is the single source of truth and generates JSON Schema and Python Pydantic models. See [the architecture decision](docs/architecture.md).

## Install

Requires Node.js 22+ and [uv](https://docs.astral.sh/uv/getting-started/installation/).

```sh
git clone https://github.com/xiaoyuy2906/AgentPIC.git
cd AgentPIC
npm ci
uv sync --locked
```

uv creates and manages `.venv`. Python 3.12–3.13 is supported; `.python-version` selects 3.13. Node and Python dependencies are locked independently. Scientific requests execute the prepared environment's Python directly and never install or synchronize packages during calculations. If you use `UV_PROJECT_ENVIRONMENT`, propagate that setting to the API/MCP process as well.

## Development order

**Stage 1 builds the minimum complete agent-native PIC EDA. Stage 2 validates that EDA with an MZI.** The product is the reusable engineering core; the MZI is the first end-to-end benchmark. Stage 3 expands capabilities in response to more complex design requirements. See [the roadmap](docs/roadmap.md) and [Stage 1–2 acceptance criteria](docs/acceptance.md).

The current EDA implements typed circuit IR, compilation, SAX simulation, GDSFactory layout, independent verification, API/MCP and reproducible artifacts. Run the complete machine-interface benchmark with:

```sh
npm run acceptance -- --output runs/acceptance
```

Physics reasoning and autonomous capability development support this engineering workflow. They do not replace the EDA or define a separate first-stage product.

Stage 3 adds reusable circuit hierarchy compilation and a complete **2–4 stage MZI cascade** benchmark. `npm run --silent agentpic -- flatten examples/cascaded_mzi.hierarchy.json`, HTTP `POST /v1/circuits/flatten`, and MCP `flatten_circuit` validate module definitions and produce a neutral primitive circuit with source paths. The cascade design recipe uses this compiler, places physical blocks and interconnects, backannotates every waveguide and checks SAX against independent transfer-matrix composition. See [its fixed acceptance gates](docs/stage3-cascade.md).

```sh
npm run --silent agentpic -- design examples/cascaded_mzi_1550.json
npm run acceptance -- --specification examples/cascaded_mzi_1550.json --output runs/cascade-acceptance
```

Each cascade stage has a unique `name` and `delta_length_um`; `link_length_um` sets the two connecting waveguide lengths between adjacent stages. This is a supported series-assembly recipe. Arbitrary hierarchy-to-layout synthesis remains future work.

## Additional capability: physics reasoning and verification

```sh
npm run --silent agentpic -- physics examples/straight_waveguide.json
npm run benchmark:physics -- --output runs/physics-benchmarks
```

The straight-waveguide example is a **symmetric planar TE benchmark**, not a general channel-waveguide solver. The TS workflow compiles unit-aware physical configuration, runs SciPy/LAPACK mode calculations, compares an independent dispersion-relation reference, forms testable hypotheses, and selects additional grid, boundary and repeatability experiments. Criteria and expected benchmark outcomes are saved before execution.

Results distinguish `accepted`, `improved`, `rejected`, `inconclusive`, `invalid` and `unsupported`. A corrected numerical configuration never retroactively marks the submitted baseline as verified. Wrong wavelength units, invalid materials and incompatible physical assumptions are diagnosed before solving. Unknown capabilities produce a development specification and dependency DAG instead of fabricated results.

Use `POST /v1/physics/workflows` with the same goal JSON or MCP `run_engineering_goal` with `{"goal": ...}`. Retrieve reports at `/v1/physics/runs/{run_id}` and experiment artifacts at `/v1/physics/runs/{run_id}/artifacts/{name}`. MCP provides `get_engineering_capabilities`, `get_physics_run` and resources at `agentpic://physics/{run_id}/{name}`.

The default reasoner is a deterministic physical-principle policy. Optional `reasoning_proposals` from an external LLM remain hypotheses and are tested against numerical evidence. No LLM provider, autonomous code-writing model, 3D EM solver or foundry signoff is claimed. See [physics verification](docs/physics-verification.md), [benchmark registry](benchmarks/registry.json) and [development roadmap](docs/roadmap.md).

## Circuit architecture acceptance: specification → IR → SAX

```sh
npm run --silent agentpic -- compile examples/mzi_1550.json > circuit.json
npm run --silent agentpic -- validate circuit.json
npm run --silent agentpic -- simulate circuit.json > simulation-result.json
```

Compilation creates typed Component, Port, Connection, Circuit and PDK records, performs semantic checks in TypeScript, and emits standard JSON. The simulation command passes that JSON to the uv-managed Python SAX adapter and returns the complete complex S-matrix plus independent numerical verification. No layout or EM solver is needed for this path. Nominal arm lengths are 810/800 µm for the default 10 µm imbalance.

The exact milestone input is:

```json
{
  "device": "mzi",
  "platform": "sin",
  "wavelength_nm": 1550,
  "outputs": ["netlist", "simulation", "gds", "verification"]
}
```

## Full design loop: layout → backannotation → simulation → verification

```sh
npm run --silent agentpic -- design examples/mzi_1550.json
npm run --silent agentpic -- verify <run_id>
```

The TypeScript Runtime executes an explicit dependency DAG, invokes GDSFactory through the Python adapter, backannotates actual routed waveguide lengths, invokes SAX, and aggregates semantic/numerical/geometric checks. A successful result reports `status: completed` and `verification_status: passed_with_limitations`.

The response includes `run_id`, `artifact_directory`, artifact hashes and any execution error. Runs are stored separately under `runs/`; use `--runs-dir /path/to/runs` or `AGENTPIC_RUNS_DIR` to override. CLI exit codes are 0 for completion, 1 for a failed workflow/verification and 2 for invalid input or command errors.

## HTTP API

```sh
npm run --silent agentpic -- serve --host 127.0.0.1 --port 8000
```

From another terminal or an agent:

```sh
curl --fail-with-body http://127.0.0.1:8000/v1/designs \
  -H 'Content-Type: application/json' \
  --data-binary @examples/mzi_1550.json
```

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/capabilities` | Discover supported/unsupported capabilities |
| POST | `/v1/compile` | Single/cascaded MZI specification → semantically validated Engineering IR |
| POST | `/v1/circuits/flatten` | Hierarchy → validated primitive circuit and source paths |
| POST | `/v1/validate` | Validate an Engineering IR and its topology |
| POST | `/v1/simulations` | Engineering IR → Python SAX result and verification |
| POST | `/v1/designs` | Execute the complete layout/simulation/verification workflow |
| GET | `/v1/runs/{run_id}` | Read a persisted run |
| POST | `/v1/runs/{run_id}/verify` | Repeat verification and check artifact hashes |
| GET | `/v1/runs/{run_id}/artifacts/{name}` | Download JSON, GDS or other artifacts |
| GET | `/openapi.json` | Generated machine-readable API contract |

Invalid structure or engineering semantics return 422; unknown runs/artifacts return 404. Engineering execution failures return a persisted `status: failed` result; transport success does not imply a verified design. This is a trusted-local service without authentication or multi-tenant isolation.

## MCP

The TypeScript MCP server uses standard stdio. Configure an MCP client with the absolute checkout path:

```json
{
  "mcpServers": {
    "agentpic": {
      "command": "npm",
      "args": [
        "--prefix", "/absolute/path/to/AgentPIC", "run", "--silent", "agentpic",
        "--", "mcp", "--runs-dir", "/absolute/path/to/AgentPIC/runs"
      ]
    }
  }
}
```

Tools: `get_capabilities`, `get_design_schema`, `compile_pic`, `flatten_circuit`, `validate_circuit`, `simulate_circuit`, `design_pic`, `get_run`, `verify_run`. The compile/design tools accept `{"specification": {...}}`; validation/simulation accept `{"ir": {...}}`. The same Zod definitions and TS functions serve the API, MCP and CLI.

Read artifacts at `agentpic://runs/{run_id}/{name}`. Binary GDS is transported as a base64 resource blob. Agents should inspect every verification check, including `not_run`, before using a result.

## Artifacts and reproducibility

| Artifact | Contents |
|---|---|
| `specification.json`, `compiled_ir.json` | Normalized intent and compiler output |
| `engineering_ir.json`, `netlist.json` | Resolved circuit with physical arm and interconnect lengths |
| `hierarchy.json`, `instance-paths.json`, `assembly.json` | Cascade module definitions, primitive source paths and physical assembly intent |
| `layout.json` | Neutral extracted Circuit, physical ports, lengths and centerlines |
| `design.gds`, `layout.svg` | Actual hierarchical geometry and static GDS-derived preview |
| `simulation.json`, `spectrum.csv` | Full complex S-matrix and optical transmission |
| `verification.json` | Individual checks, evidence and explicit limitations |
| `workflow.json`, `events.jsonl` | Persisted task states, dependencies and failures |
| `provenance.json` | Core/backend versions, source/schema/lock hashes and Git state |
| `manifest.json`, `run.json` | Result and artifact SHA-256 inventory |

Identical normalized intent has a stable `design_id`; each execution has a unique run ID. Source/contract/lock hashes distinguish implementation revisions. GDS timestamps are disabled and tests check byte-identical engineering artifacts across separate backend processes in the same environment. Cross-platform bitwise identity is not promised. `outputs` records desired deliverables; the complete evidence set is always generated for verification.

## Verification and supported scope

TypeScript checks references, port occupancy and compatibility, topology, model/PDK constraints, workflow dependencies, extracted connectivity and physical lengths. Python checks the full SAX matrix against independent analytic equations, reciprocity, passivity, lossless power balance, GDS readback, core connectivity and explicit demonstration width/spacing/bend rules. Schema validation alone cannot establish any of these engineering properties.

The default single-MZI run has 26 passing checks; reverification adds artifact integrity for 27. A cascade adds hierarchy intent, hierarchy artifact consistency and interconnect-length checks, giving 30 passes after reverification. EM calibration, measurement validation and foundry signoff remain explicitly `not_run` in both workflows.

`sin_demo_v1` assumes a 1 µm wide, 0.4 µm thick core, 50 µm bends, neff=1.8, ng=1.9 at 1550 nm, ideal 50:50 couplers and zero propagation loss. These are illustrative assumptions. The MMI polygons have not been optically calibrated to the compact model. GDS describes planar geometry; the thickness remains an IR assumption. No fabrication readiness is claimed.

The design compiler currently supports parameterized SiN MZIs and 2–4 stage cascades; the generic hierarchy compiler also supports nested topology. The physics workflow supports the planar TE benchmark described above. FDTDX, FEM, EME, full-vector channel modes, optimization, additional device models, foundry PDKs and foundry DRC/LVS are future work. The reserved EM contract does not advertise execution. See [equations and validity](docs/models-and-verification.md) and [interface boundaries](docs/interfaces.md).

## Development

```sh
npm run generate             # Zod → JSON Schema → generated Pydantic
npm run typecheck
npm run format:check
npm test
uv run ruff check src tests
uv run ruff format --check src tests
uv run pytest -q
npm run acceptance -- --output runs/acceptance
```

The acceptance script exercises real HTTP and MCP transports, the circuit-only IR→SAX path, full GDS production, binary artifact retrieval, repeat verification and matching artifact hashes. CI regenerates contracts to detect drift, runs tests and acceptance on Linux/Python 3.12 and 3.13, and uploads evidence.

See [research](docs/research.md), [persistent progress](docs/progress.md) and [schemas](schemas/). AgentPIC source is MIT licensed; dependencies retain their own licenses.
