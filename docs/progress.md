# Persistent development progress

## Capability audit as code (2026-10-20)

`core/src/capabilities.ts` now holds 27 capabilities: 16 implemented, 2 partial and 9 missing, each with the tests that prove it and its limitation (ADR-010). A test rejects evidence that names no existing test, and the README table is generated from the registry. The registry replaced the hand-written capability object behind `GET /v1/capabilities` and MCP `get_capabilities`; `agentpic capabilities --missing` lists what to build next. Writing it caught one violation of the freeze rule in the registry itself (evidence titles naming a device), which the architecture test reported. `docs/structure.md` gives a reading order for the whole code base, and the planar TE plugin moved from `core/src/capabilities/` to `core/src/physics/` so the two meanings of "capabilities" no longer share a name.

## Physics evidence ladder with FDTDX (2026-10-20)

The strip cross-section's mode model is now an FDTDX characterization instead of an assumption: neff 1.63973 and ng 2.0723 at 1550 nm, replacing 1.8 and 1.9. The pipeline (`src/agentpic/characterize.py`) uses only FDTD time stepping, a uniform plane source and phasor detectors; it first reproduces the analytic slab solution (error 8.3e-4 against a 1e-3 criterion), then runs three grids at three wavelengths with Richardson extrapolation (observed orders 2.02–2.04). Evidence is in `pdks/sin_demo_v1.strip.characterization.json`; each design run verifies it, and a tampered index or missing file fails `mode_characterization`. FDTDX is an optional `em` group installed in CI so the slab validation runs there; AgentPIC code never imports tidy3d or uses its mode solver, which the architecture test enforces. Every test reads its constants from the PDK, so no golden reference needed editing when the indices changed.

The new indices exposed a defect in target tuning: the `ring_target` drop resonance moved to 0.35 rad above the lower phase bound, and the local search, started exactly on that bound, crawled (trust-region-reflective steps scale with distance to a bound) and then restarted from identical points until the 128-evaluation budget ran out. Duplicate starts are now skipped, each local search restarts from the best point found so far, and searches start a thousandth of the range inside the bounds. The ring target is now met in 47 evaluations; the budget-accounting tests are unchanged.

## PDK as data (2026-10-20)

`pdks/sin_demo_v1.json` now holds every process fact: layers, rules, Sellmeier materials (Luke 2015 Si3N4, Malitson 1965 SiO2), cross-sections with mode models, and components with ports, cells, compact-model versions, validity ranges and sources. The engine reads all of them from the PDK: semantic port and parameter checks, a new `model_validity` check (sweep, parameters and tuning bounds inside each validity range), layout cells and cross-sections, and mode parameters in SAX and the independent reference. The layout backend rejects a cell whose ports disagree with its declaration; the SAX backend rejects model versions it does not implement. The design ID and provenance include the PDK content hash, and verification limitations list every uncalibrated source. Regenerating the designs from PDK-derived cell geometry reproduced them byte for byte.

cspdk 2.1.0 and ubcpdk 1.3.4 were installed in isolation and found to ship only placeholder models (`docs/research.md`), so neither is used as a model source.

## Generic place and route with independent LVS (2026-10-20)

Routes without steps are now found by GDSFactory's `route_single`; routes listed in a `bundle` are routed together by `route_bundle` with a common separation. The routers only propose Manhattan backbones in a scratch cell. One validator, one circular-bend smoother and one extruder handle every path, so measured lengths and bend radii come from the same representation whatever produced the route. `layout.json` records the router of each path.

`src/agentpic/lvs.py` adds layout-versus-schematic checks independent of the builder: connectivity re-extracted from coincident physical pins (reporting opens, shorts and ambiguous pins), pins backed by real GDS geometry, and no waveguide crossing another waveguide or a coupler body. A deliberately crossing MZI arm now fails `waveguide_crossings` while every connectivity-based check still passes. `waveguide_chain` gained a layout with an auto-routed S-shaped middle waveguide (measured 395.829 µm against 35.5 µm nominal); the new `mzi_cascade_offset` design shifts its second stage by 300 µm and bundles both links.

## Freeze rule: designs are data (2026-10-20, earlier)

Every device recipe was removed from the engine (ADR-007). `DesignSpec` 3.0 is one generic contract: a flat or hierarchical circuit, an explicit `port_order`, and optional layout plan, tuning and spectral measurements. The 38 device-specific branches in the compiler, layout, simulation, verification and runtime are gone, together with `cells/mzi.ts`, `cells/ring.ts`, `cascade.ts` and `generic.ts`. `core/tests/architecture.test.ts` fails if engine code names a device family, instance or port, or imports `designs/`.

The layout engine places cells (absolute or anchored to another instance's port) and routes waveguides along Manhattan steps with one automatic final corner and PDK-radius bends. Layout constraints (`length`, `length_difference`) replace the device checks for arm imbalance, link length and ring dimensions. Verification uses network elimination for every circuit; a midpoint-interpolation check replaces the ring-only sampling rule and applies to all spectra. Device closed forms moved into the tests as golden references.

The ten designs in `designs/` (MZI, controlled and target MZI, 2-stage cascades, ring and target ring, waveguide chain, coupler) are generated by `designs/templates.ts`. They reproduce the previous geometry: MZI arms 814.157/804.157 µm, 100.000 µm cascade links, 654.579 µm ring returns. HTTP and MCP acceptance pass for every design; reverification of the MZI gives 33 passes and three explicit `not_run` checks.

## Bounded milestone: generic circuit compilation and simulation (2026-10-17)

The Stage 3 generic-circuit milestone adds `device: circuit` to the existing design
contract. External flat circuits, versioned model references and explicit optical
port order now use the same compiler, runtime, real SAX, independent verification,
HTTP/MCP and artifact interfaces. The existing hierarchy flattener can supply the
flat circuit. No waveguide-chain or standalone-coupler recipe was added.

Local verification passes 148 TypeScript tests and 32 Python tests, type/lint/format
checks, both new real HTTP/MCP acceptances, all six existing design acceptances
and all eight physics benchmark expectations. Each generic acceptance reports
24 passes and six explicit `not_run` checks; seven core artifact hashes agree
across transports. The 201-point waveguide-chain complex error is 1.7057e-13
against the summed-length closed form and 1.9906e-13 against independent dense
network elimination (threshold 1e-9). The standalone coupler matches both references
to floating-point zero. Existing MZI, cascade, phase-control, target-tuning and
ring regression tests all pass. CI runs the complete eight design acceptances and
eight physics benchmarks on Python 3.12 and 3.13; inspect the exact revision's
hosted result before claiming published CI success.

Generic GDS, layout checks, path backannotation, target tuning, general spectral
resolution guarantees and calibrated physical models remain unsupported. Layout
requests produce no GDS; checks record `not_run`. See
`docs/history/stage3-generic-circuits.md` for fixed gates and reproduction. This milestone
does not authorize the next model-calibration, solver or generic-layout project.

## Earlier milestones

Current goal (updated 2026-10-16): Stage 1 builds the minimum complete agent-native PIC EDA; Stage 2 validates it with an MZI. Stage 3 uses progressively more complex designs to expose and close capability gaps. ADR-001 remains mandatory. The MZI is a benchmark, not the product. The existing planar-mode physics module is an additional reusable capability, not the first-stage objective. See `docs/roadmap.md` and `docs/acceptance.md` for the current scope and acceptance gates.

## Implemented and locally executed

- TypeScript/Zod is the sole editable contract source. JSON Schema and Python Pydantic models are generated.
- TypeScript owns compiler semantics, runtime, verification management, experiment/hypothesis policies, capability registry, HTTP and MCP.
- Python owns scientific adapters and numerical/geometric analysis. SAX/GDSFactory internals remain inside adapters.
- The exact MZI request executes through real HTTP and MCP and produces matching GDS/netlist/simulation artifacts. Reverification yields 27 passes and three explicitly unperformed calibration/signoff checks.
- Straight planar waveguide physics executes real SciPy eigenmode and independent dispersion-reference calculations. The reference neff for the example is approximately 1.7467074376474285.
- Valid configurations are accepted; coarse resolution and boundary truncation are diagnosed and improved. Incorrect wavelength units, material parameters and physical assumptions are rejected before solver execution. Missing evidence remains inconclusive.
- LLM proposals are recorded separately and cannot override numerical evidence.
- Unknown capabilities produce persistent technical specifications and development/test dependencies.

## Latest verification state

The Stage 1–2 baseline is commit `1262411ffc31f6a21ca35d941e332370d4945998`: 52 TypeScript tests, 8 Python tests, real MZI HTTP/MCP acceptance and eight physics benchmarks passed on both Python 3.12 and 3.13 in [CI run 38414150524](https://github.com/xiaoyuy2906/AgentPIC/actions/runs/38414150524). A reproducible local delivery bundle preserves the original source commit, manifests, GDS and verification evidence.

Stage 3 adds generic module definitions, recursive alias resolution, deterministic collision-free primitive naming, instance-path traceability and bounded expansion. HTTP `/v1/circuits/flatten`, MCP `flatten_circuit` and CLI `flatten` execute the same contract. The complete local suite now passes 122 TypeScript and 30 Python tests. Strict compilation, generation and lint checks, passive/controlled machine-interface acceptance workflows and all eight existing physics benchmark expectations passed. See [current CI](https://github.com/xiaoyuy2906/AgentPIC/actions/workflows/ci.yml) for the hosted result at each revision.

The two-MZI example flattens into 10 primitives, 12 connections and four external ports. The full 2–4 stage series recipe now generates connected GDS, measures every arm and interconnect, simulates the resolved network with SAX and compares the full complex matrix to independent transfer composition. HTTP/MCP produce identical engineering artifacts and reverification gives 30 passes plus three explicit `not_run` checks. The reference error is 1.9327e-12, below the predeclared 1e-9 threshold. Corruption tests reject module, interconnect, optical and GDS faults. A three-stage boundary regression also protects the 1 nm layout-grid tolerance. The acceptance gates and evidence are in `docs/history/stage3-cascade.md`.

Controlled single/cascaded MZIs now reuse a mixed-domain phase-shifter primitive, with optical graph projection for SAX and exposed electrical terminals in the engineering/layout records. GDS includes metal actuators; independent readback detects missing/moved metal and verifies dimensions and terminal positions. Phase-state tests show switching, equal splitting and periodic return while core/metal polygons remain unchanged. The controlled cascade's HTTP/MCP acceptance yields 35 passes and four explicit `not_run` checks; its maximum complex reference error is 2.4162e-12. Seventeen new TypeScript tests cover these behaviors, invalid controls and corruption. See `docs/history/stage3-phase-control.md`.

Target-driven control now accepts bounded phase-variable paths and optical power targets through the same API/MCP design contract. The runtime optimizes after measured-length backannotation, preserves source intent and pre-tuning IR, records all candidate evaluations and applies only selected phases. SciPy bounded least squares reuses a parameterized SAX evaluator; final verification independently checks exported S-matrix powers and replays every candidate analytically. The two-variable, three-target cascade reaches maximum power error 7.9876e-7 in 30 evaluations; real HTTP/MCP artifacts match and reverification yields 42 passes plus four explicit not-run checks. Single-MZI targets pass 1e-9 tolerance, and a four-variable/sixteen-target boundary case passes at 1e-8. Fourteen new TS tests and nine Python tests include hard-budget accounting, target failure, forged success, trace/state corruption, backend failure and unchanged GDS polygons. See `docs/history/stage3-target-tuning.md` for the predeclared gates and local evidence. Hosted CI must be inspected at the exact revision before claiming a published result.

Resonant feedback is now a supported primitive composition: `ring_add_drop` reuses the Circuit IR, SAX network solver, physical GDS extraction, measured-path backannotation and target optimizer. Independent feedback summation checks the full complex matrix; spectral verification checks peak positions, spacing, half-maximum widths, coverage and minimum sampling. Passive HTTP/MCP acceptance yields 31 passes/3 not-run; automatically aligning drop transmission to 1550 nm yields 43 passes/4 not-run with error 2.7913e-7 in 36 evaluations. Coarse/clipped spectra fail despite correct sampled values, while an explicitly refined weak-coupling grid passes. Twelve TS tests and six Python tests cover geometry/control bounds, asymmetric coupling, corruption, sampling and transport. See `docs/history/stage3-resonant-network.md`. These are prescribed compact-coupler assumptions with real MMI/return-path geometry, not a calibrated evanescent microring.

Remaining Stage 3 gaps include geometry optimization, arbitrary hierarchy placement/routing, calibrated component models, electrothermal actuation, additional device families and qualified PDK integration. Optical phase is explicitly requested, not inferred from voltage or heating power. These completed benchmarks are incremental EDA capabilities, not completion of the long-term platform goal.

Final review found that failed checks on the independent reference did not block acceptance if its effective index agreed. A regression test reproduced the false acceptance by corrupting only the reference propagation units. The verdict now requires the reference's own deterministic checks to pass before either the baseline or a revised configuration can be accepted.

Repeated Linux/Python 3.12 CI exposed `ModuleNotFoundError: scipy.signal` during concurrent API/MCP tests. MCP's default environment omits uv interpreter settings; per-request `uv run` could therefore replace the shared environment while another backend was importing. Scientific requests now execute the already prepared Python directly, without resolving or syncing dependencies. Test/acceptance MCP clients preserve environment settings, provenance records the actual Python version/executable, and regression checks enforce environment stability and transport consistency. Failed test artifacts are retained in CI.

No foundry signoff, full-vector channel solver, 3D EM implementation, fabricated-device calibration, embedded code-writing agent, or production solver deployment is claimed. uv continues to manage `.venv`; both dependency lock files are committed.
