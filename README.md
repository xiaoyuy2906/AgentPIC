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
| `mzi_cascade_offset` | Offset stages whose links are auto-routed together as a bundle |
| `waveguide_chain` | Arbitrary port names and order, an automatically routed S-shaped waveguide |
| `coupler` | Simulation without any layout plan |

A design contains:

- `circuit`: a flat netlist or a module hierarchy of primitives, plus `port_order` for the S-matrix.
- `layout` (optional): `placements` (absolute or anchored to another instance's port), `routes` (declared Manhattan steps, or none to let GDSFactory's router choose), `bundles` of routes kept at a common separation, and `constraints` on measured lengths. Without it, layout checks report `not_run`.
- `tuning` (optional): power targets over phase-shifter variables, solved by bounded SciPy search.
- `measurements` (optional): spectral features such as complete resonances between two ports.

Process facts live in a PDK data file named by the design's `pdk` field (default `pdks/sin_demo_v1.json`): layers, rules, materials, cross-sections with mode models, and components with ports, cells, compact-model versions, validity ranges and the source of every value ([ADR-008](docs/architecture.md#adr-008-the-pdk-is-data-with-sources)).

The full contract is in [docs/interfaces.md](docs/interfaces.md). To add a device, write a generator in `designs/templates.ts`, run `npm run generate`, and add golden-reference tests; to add a process, add a PDK file. If either needs an engine change, the engine is missing a generic capability.

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

TypeScript checks references, port occupancy and compatibility, topology, the layout plan, extracted connectivity, port alignment, measured lengths and layout constraints. Python checks the full SAX matrix against independent dense network elimination, spectral sampling adequacy, reciprocity, passivity and lossless power balance, then reopens the GDS with KLayout for connectivity, width, spacing, bend radius and metal geometry, and runs pin-based LVS: connectivity re-extracted from physical pins, pins backed by real geometry, and no crossing waveguides.

These checks verify the solver, the netlist and the geometry against the **stated compact models**. The models themselves rest on a ladder of physics evidence (ADR-009): circuits are solved only by SAX and fields only by [FDTDX](https://github.com/ymahlau/fdtdx). The strip waveguide's neff = 1.63973 and ng = 2.0723 at 1550 nm come from an FDTDX time-domain characterization that first reproduces the analytic slab solution, then converges over three grids per wavelength. The earlier assumed 1.8 and 1.9 were 9.8 % and 8.3 % off. Every run checks that evidence (`mode_characterization`) and lists models still without it (`electromagnetic_characterization`): the ideal MMI coupler has none yet. Measurement validation and foundry signoff are always `not_run`, and controlled designs report electrical-to-phase calibration as `not_run`.

```sh
uv sync --group em                                   # FDTDX; installs tidy3d, which AgentPIC never calls
npm run characterize -- sin_demo_v1 strip --write    # about 8 minutes on a laptop CPU
``` See [models and verification](docs/models-and-verification.md).

A separate physics workflow (`npm run --silent agentpic -- physics examples/straight_waveguide.json`) runs a planar TE slab benchmark with independent dispersion evidence; see [physics verification](docs/physics-verification.md).

## Capabilities

`core/src/capabilities.ts` is the authoritative audit, served by `GET /v1/capabilities`, MCP `get_capabilities` and `npm run --silent agentpic -- capabilities [--missing]`. Every implemented or partial entry names the tests that prove it, and a test fails if one of those tests does not exist. This table is generated from it.

<!-- capabilities:start (generated by npm run generate) -->
| Domain | Capability | Status | Limitation |
|---|---|---|---|
| contracts | `typed_shared_contracts` | ✅ implemented | Pre-1.0 contract; version 3.0 artifacts are not migrated from earlier versions. |
| design | `designs_are_data` | ✅ implemented | Three primitive kinds: ideal coupler, waveguide and phase shifter. |
| design | `hierarchical_netlists` | ✅ implemented | At most 32 levels and 10000 expanded primitives. |
| design | `semantic_validation` | ✅ implemented | Schema-valid but physically meaningless parameter combinations can still pass. |
| pdk | `pdk_as_data_with_sources` | ✅ implemented | One demonstration SiN PDK; components cover three primitive kinds. |
| pdk | `foundry_pdk` | ❌ missing | No foundry PDK or rule deck; cspdk and ubcpdk ship only placeholder compact models. |
| simulation | `s_parameter_circuit_solver` | ✅ implemented | SAX frequency domain only; reciprocal, lossless ideal models. |
| simulation | `independent_network_reference` | ✅ implemented | Shares the compact-model equations with SAX: it checks the solver, not the physics. |
| simulation | `spectral_sampling_and_resonances` | ✅ implemented | Resonance measurement finds peaks only, at half of the peak power. |
| simulation | `loss_bend_and_dispersion_models` | ❌ missing | Zero propagation and bend loss; bends carry straight-guide phase; linear dispersion. |
| simulation | `time_domain_circuit` | ❌ missing | No transient or modulated-signal circuit simulation. |
| physics | `cross_section_mode_characterization` | ✅ implemented | FDTDX on the nominal geometry; slab method error 8.3e-4; no sidewall angle, roughness or process variation. |
| physics | `device_level_em_characterization` | ❌ missing | MMI couplers use ideal prescribed ratios; no FDTDX S-parameters of fixed cells. |
| physics | `planar_mode_experiment_loop` | ✅ implemented | Symmetric planar TE slab only. |
| physics | `electrothermal_actuation` | ❌ missing | Optical phase is commanded directly; no voltage, power or temperature-to-phase model. |
| layout | `placement` | 🟡 partial | Placement is declared (absolute or port-anchored); no automatic placer. |
| layout | `routing` | ✅ implemented | Manhattan routes with circular bends; no waveguide crossings or tapers. |
| layout | `layout_versus_schematic` | ✅ implemented | Pin-based extraction with geometric evidence, not polygon device recognition. |
| layout | `design_rule_checks` | 🟡 partial | Demonstration width, spacing and bend-radius rules; no foundry rule deck. |
| layout | `length_backannotation` | ✅ implemented | Lengths only; bends are not given separate phase or loss. |
| optimization | `phase_target_tuning` | ✅ implemented | Bounded local search over at most four phases; no global optimality or feasibility proof. |
| optimization | `geometry_inverse_design` | ❌ missing | No geometry optimization or adjoint inverse design. |
| verification | `evidence_provenance_and_integrity` | ✅ implemented | Local SHA-256 inventory; not a signed attestation. |
| verification | `variability_and_yield` | ❌ missing | No process corners, Monte Carlo or yield analysis. |
| verification | `measurement_validation_and_signoff` | ❌ missing | No fabricated-device measurements or foundry signoff. |
| integration | `http_mcp_cli` | ✅ implemented | Trusted-local service without authentication or multi-tenant isolation. |
| integration | `long_running_jobs` | ❌ missing | Requests are synchronous; FDTDX characterization runs only as an offline command. |
<!-- capabilities:end -->

## Development

```sh
npm run generate        # designs/*.json, JSON Schema, Python models and the capability table
npm run typecheck && npm run format:check && npm test
uv run ruff check src tests && uv run ruff format --check src tests && uv run pytest -q
```

CI regenerates all generated files and rejects drift, runs both test suites on Python 3.12 and 3.13, and runs HTTP + MCP acceptance for every design file. To read the code, start with [docs/structure.md](docs/structure.md). Architecture decisions are in [docs/architecture.md](docs/architecture.md), the plan in [docs/roadmap.md](docs/roadmap.md), progress in [docs/progress.md](docs/progress.md), and earlier milestone records in [docs/history](docs/history/README.md). MIT licensed; dependencies keep their own licenses.
