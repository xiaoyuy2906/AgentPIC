# AgentPIC

[![CI](https://github.com/xiaoyuy2906/AgentPIC/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaoyuy2906/AgentPIC/actions/workflows/ci.yml)

An agent-native photonic circuit EDA. Submit a design file through HTTP, MCP or the CLI and receive the compiled netlist, a SAX simulation, real GDS from GDSFactory, and a verification report in which every check is `pass`, `fail` or an explicit `not_run`. A **TypeScript engineering core** owns contracts, compilation, workflow and verification; **Python scientific backends** run SAX, GDSFactory and KLayout. No GUI or paid solver is required.

## The rule

**Adding a device must not change compiler, simulation, verification or layout code.** A design is data; the engine knows primitives (`ideal_coupler`, `waveguide`, `phase_shifter`), placement, routing and generic checks, never a device family. `core/tests/architecture.test.ts` enforces this. Device knowledge lives in `designs/templates.ts` and in tests, the way a CPU is an input to digital EDA tools rather than a code path inside them. See [ADR-007](docs/architecture.md#adr-007-designs-are-data-engines-never-name-a-device).

## Install

Requires Node.js 22+ and [uv](https://docs.astral.sh/uv/getting-started/installation/).

```sh
git clone https://github.com/xiaoyuy2906/AgentPIC.git
cd AgentPIC
npm ci
uv sync --locked
```

Python 3.12–3.13 is supported. Scientific requests execute the prepared environment directly and never install packages during calculations; propagate `UV_PROJECT_ENVIRONMENT` to API/MCP processes if you use it.

## Use

```sh
npm run --silent agentpic -- design designs/mzi.json        # compile → layout → simulate → verify
npm run --silent agentpic -- verify <run_id>                # re-check persisted artifacts
npm run --silent agentpic -- compile designs/ring.json      # typed, semantically validated IR only
npm run --silent agentpic -- flatten examples/cascaded_mzi.hierarchy.json
npm run acceptance -- --specification designs/mzi_cascade_target.json --output runs/acceptance
```

| Design file | What it exercises |
|---|---|
| `mzi`, `mzi_tunable`, `mzi_target` | Arm imbalance, phase-shifter metal and terminals, target-driven phase search |
| `mzi_cascade`, `mzi_cascade_tunable`, `mzi_cascade_target` | Module hierarchy, port-anchored placement, multi-variable tuning |
| `ring`, `ring_target` | Feedback topology, resonance measurement, aligning a drop resonance to 1550 nm |
| `waveguide_chain`, `coupler` | Arbitrary port names and order, simulation without layout |

A design contains:

- `circuit`: a flat netlist or a module hierarchy of primitives, plus `port_order` for the S-matrix.
- `layout` (optional): `placements` (absolute or anchored to another instance's port), `routes` (Manhattan steps; the engine adds the final corner and PDK-radius bends) and `constraints` on measured lengths. Without it, layout checks report `not_run`.
- `tuning` (optional): power targets over phase-shifter variables, solved by bounded SciPy search.
- `measurements` (optional): spectral features such as complete resonances between two ports.

The full contract is in [docs/interfaces.md](docs/interfaces.md). To add a device, write a generator in `designs/templates.ts`, run `npm run generate`, and add golden-reference tests; if that needs an engine change, the engine is missing a generic capability.

## Interfaces

`npm run --silent agentpic -- serve --port 8000` starts the HTTP API; `mcp` starts the MCP stdio server. Both use the same Zod contracts and runtime.

| HTTP | MCP | Purpose |
|---|---|---|
| `GET /v1/capabilities` | `get_capabilities` | Supported primitives, backends and limits |
| `POST /v1/compile` | `compile_pic` | Design → validated Engineering IR |
| `POST /v1/circuits/flatten` | `flatten_circuit` | Hierarchy → primitive circuit with source paths |
| `POST /v1/validate` | `validate_circuit` | Validate an Engineering IR |
| `POST /v1/simulations` | `simulate_circuit` | IR → SAX result and verification (no layout) |
| `POST /v1/designs` | `design_pic` | Full persisted workflow |
| `GET /v1/runs/{id}` | `get_run` | Persisted run |
| `POST /v1/runs/{id}/verify` | `verify_run` | Re-verify artifacts and hashes |
| `GET /v1/runs/{id}/artifacts/{name}` | `agentpic://runs/{id}/{name}` | JSON, CSV, SVG or binary GDS |

Invalid structure or semantics return 422 with the failing checks; a completed transport does not imply a verified design. The service is trusted-local, without authentication.

## Verification and its limits

TypeScript checks references, port occupancy and compatibility, topology, the layout plan, extracted connectivity, port alignment, measured lengths and layout constraints. Python checks the full SAX matrix against independent dense network elimination, spectral sampling adequacy, reciprocity, passivity and lossless power balance, then reopens the GDS with KLayout for connectivity, width, spacing, bend radius and metal geometry.

These checks verify the solver, the netlist and the geometry against the **stated ideal models**. `sin_demo_v1` assumes neff = 1.8 and ng = 1.9 at 1550 nm, ideal couplers and zero loss; these are not derived from a mode solver or a measured stack. Electromagnetic calibration, measurement validation and foundry signoff are always reported `not_run`, and controlled designs also report electrical-to-phase calibration as `not_run`. See [models and verification](docs/models-and-verification.md).

A separate physics workflow (`npm run --silent agentpic -- physics examples/straight_waveguide.json`) runs a planar TE slab benchmark with independent dispersion evidence; see [physics verification](docs/physics-verification.md).

## Development

```sh
npm run generate        # designs/*.json, JSON Schema and Python models from their sources
npm run typecheck && npm run format:check && npm test
uv run ruff check src tests && uv run ruff format --check src tests && uv run pytest -q
```

CI regenerates all generated files and rejects drift, runs both test suites on Python 3.12 and 3.13, and runs HTTP + MCP acceptance for every design file. Architecture decisions are in [docs/architecture.md](docs/architecture.md), the plan in [docs/roadmap.md](docs/roadmap.md), progress in [docs/progress.md](docs/progress.md), and earlier milestone records in [docs/history](docs/history/README.md). MIT licensed; dependencies keep their own licenses.
