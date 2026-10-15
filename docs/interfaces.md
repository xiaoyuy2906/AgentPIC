# Unified contract, version 2.0

`core/src/contracts.ts` is the only editable contract definition. Zod exports JSON Schema and the locked generator produces Python Pydantic models. `schemas/openapi.json` documents all HTTP routes; MCP exposes the same definitions through tools/list. Python's shared base sets generic finite-number/default validation policy only.

## Design input

| Field | Default | Supported constraint |
|---|---|---|
| `device` | `mzi` | `mzi` or `mzi_cascade` |
| `platform` | `sin` | Illustrative `sin_demo_v1` PDK |
| `wavelength_nm` | 1550 | 1500–1600 nm |
| `outputs` | All four | Nonempty unique subset of netlist/simulation/gds/verification |
| `delta_length_um` | 10 | Single MZI only: −200 to +200 µm, top minus bottom arm |
| `stages` | Required for cascade | 2–4 records with unique `name` and `delta_length_um` in −200 to +200 µm |
| `link_length_um` | 100 | Cascade only: 10–1000 µm between adjacent blocks |
| `phase_control` | null | Single MZI or each cascade stage: optional `{phase_rad, active_length_um}` |
| `sweep_span_nm` | 40 | Greater than zero, at most 100 nm |
| `sweep_points` | 201 | Odd integer, 3–2001 |

The full sweep must lie in 1450–1650 nm. Unique outputs, odd samples and engineering bounds are checked by the TS compiler. These are software support ranges, not calibrated physical validity ranges.

Phase controls accept −4π to +4π radians at the PDK reference wavelength (default 1550 nm), with active metal lengths of 20–200 µm (default 100). The controlled top-arm primitive retains its full optical path length and adds electrical terminals `e1`/`e2`. Single-MZI external aliases are `phase_e1`/`phase_e2`; cascade aliases use collision-free stage paths. Electrical ports are exposed in IR/layout, excluded from the optical S-matrix, and have no electrical circuit solver. Voltage/power/temperature fields are rejected rather than silently interpreted as phase.

`DesignSpec` is a union generated from Zod. Python clients can validate it through `TypeAdapter(Contracts.model_fields["DesignSpec"].annotation)` using the generated `agentpic.ir.Contracts` catalog. Do not maintain a parallel handwritten Python union. Unknown or mixed single/cascade fields are rejected.

## Typed engineering records

- **Component:** instance name, model identifier (`ideal_coupler`, `waveguide`, `phase_shifter`), typed ports, optional length/coupling/control parameters. Controls are valid only for phase-shifter instances.
- **Port:** name, physical domain and input/output/bidirectional direction. The present solver models support optical ports.
- **Connection:** two named component/port endpoints.
- **Circuit:** components, connections and explicitly exposed external ports.
- **PDK:** process identifier, layer/datatype, geometry rules, material-model assumptions and supported components. The current PDK is a demonstration declaration, not a foundry integration.
- **EngineeringIR:** version, normalized design intent/ID, PDK, Circuit, assumptions and workflow DAG. `length_source` distinguishes specification lengths from measured layout lengths. Cascade IR also carries the source `hierarchy`, `instance_paths` and backend-neutral `assembly` plan; these must agree with the specification and flattened circuit.

Schemas reject unknown fields. Semantic validation separately rejects unresolved references, duplicate names, double-used/dangling ports, incompatible domains/directions, disconnected circuits, missing model parameters, PDK violations and invalid task dependencies. Tests deliberately submit schema-valid but semantically invalid circuits.

## Runtime and backend boundary

The TS Runtime invokes the typed ScientificBackend interface. Run `uv sync --locked` during setup. The adapter executes that prepared environment's Python with `-m agentpic.worker`, writes one JSON request to stdin, reads one JSON response, and validates the returned shape. It never resolves interpreters or synchronizes packages during scientific requests, avoiding environment replacement during concurrent calculations. `UV_PROJECT_ENVIRONMENT` selects a custom environment and must also be passed to any MCP subprocess. Scientific logging uses stderr. Timeouts terminate the child. No SAX dictionaries or GDSFactory objects cross the adapter boundary.

Compilation assigns nominal lengths so circuit simulation is executable without layout. The full workflow runs compile → layout → backannotate → simulate → verify → manifest. State and events persist after transitions. Backend errors fail the task, block dependents and retain partial artifacts. A completed verification task may still report failed checks and cause overall failure. There is no automatic process-crash recovery or resume.

SAX can evaluate the supported model graph, while independent optical validation targets the emitted ideal single/cascaded MZI families. Adding circuit families requires extending the compiler/model catalog and their independent verification policies. The placeholder EM request/result is not yet a complete material, mesh or solver configuration contract.

## Reusable circuit hierarchy

`CircuitHierarchy` (schema version 1.0) names a top definition and a library of `CircuitDefinition` records. Definitions contain primitive components, named module instances, connections and exposed port aliases. Modules refer to definitions rather than backend-specific model objects. `flattenCircuit` returns `FlattenedCircuit`: a neutral primitive `Circuit` and a map from every generated instance name to its original hierarchy path.

Use HTTP `POST /v1/circuits/flatten`, MCP `flatten_circuit` with `{"hierarchy": ...}`, or CLI `flatten FILE`. Validation rejects missing/recursive definitions, duplicate names, unresolved aliases, port occupancy/domain/direction errors and disconnected expanded circuits. Expansion is bounded to 32 module levels and 10,000 primitives. Names encode segment lengths so underscores in user names cannot create collisions.

This operation compiles topology. It does not by itself execute a solver, generate GDS or establish physical correctness. The `mzi_cascade` specification compiler composes reusable definitions through it and emits an `AssemblyPlan` containing ordered MZI blocks, their primitive mappings and connecting waveguides. The complete design workflow executes that supported series arrangement. Generic arbitrary-hierarchy placement and routing are not implemented.

Every arm and interconnect is measured from actual layout and backannotated into the flattened simulation circuit. Source definitions retain nominal lengths; `instance_paths` preserves their relationship to physical primitives. Reverification checks exported hierarchy/paths/assembly against resolved IR and separately checks topology, requested stage imbalances and interconnect lengths.

`LayoutResult.actuators` maps controlled primitive names to their physical metal layer, width and two-ended centerline. Physical port records carry their domain. Verification compares these dimensions and electrical endpoints with the IR, optical centerline and independently read GDS polygons. `controls.json` records the requested optical operating point separately from layout data and explicitly marks the electrical mapping `not_calibrated`.

## Results

`RunResult` contains run/design IDs, status, verification status, server-local artifact directory, hashes and optional error. HTTP clients download through the artifact route; MCP uses resource URIs. `VerificationReport` includes per-check pass/fail/not_run, evidence, limitations and literal `foundry_signoff: false`.

`manifest.json` and `run.json` are not included in their own hash inventories. Local hashes are an integrity reference, not a signed attestation. Reverification returns a fresh report without altering the original evidence. Format 1.0 prototype artifacts are not accepted as version 2.0 runs.
