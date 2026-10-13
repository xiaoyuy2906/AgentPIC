# Unified contract, version 2.0

`core/src/contracts.ts` is the only editable contract definition. Zod exports JSON Schema and the locked generator produces Python Pydantic models. `schemas/openapi.json` documents all HTTP routes; MCP exposes the same definitions through tools/list. Python's shared base sets generic finite-number/default validation policy only.

## Design input

| Field | Default | Supported constraint |
|---|---|---|
| `device` | `mzi` | MZI only |
| `platform` | `sin` | Illustrative `sin_demo_v1` PDK |
| `wavelength_nm` | 1550 | 1500–1600 nm |
| `outputs` | All four | Nonempty unique subset of netlist/simulation/gds/verification |
| `delta_length_um` | 10 | −200 to +200 µm, top minus bottom arm |
| `sweep_span_nm` | 40 | Greater than zero, at most 100 nm |
| `sweep_points` | 201 | Odd integer, 3–2001 |

The full sweep must lie in 1450–1650 nm. Unique outputs, odd samples and engineering bounds are checked by the TS compiler. These are software support ranges, not calibrated physical validity ranges.

## Typed engineering records

- **Component:** instance name, model identifier, typed ports, optional length/coupling parameters.
- **Port:** name, physical domain and input/output/bidirectional direction. The present solver models support optical ports.
- **Connection:** two named component/port endpoints.
- **Circuit:** components, connections and explicitly exposed external ports.
- **PDK:** process identifier, layer/datatype, geometry rules, material-model assumptions and supported components. The current PDK is a demonstration declaration, not a foundry integration.
- **EngineeringIR:** version, normalized design intent/ID, PDK, Circuit, assumptions and workflow DAG. `length_source` distinguishes specification lengths from measured layout lengths.

Schemas reject unknown fields. Semantic validation separately rejects unresolved references, duplicate names, double-used/dangling ports, incompatible domains/directions, disconnected circuits, missing model parameters, PDK violations and invalid task dependencies. Tests deliberately submit schema-valid but semantically invalid circuits.

## Runtime and backend boundary

The TS Runtime invokes the typed ScientificBackend interface. Its Python implementation runs a short-lived `uv run --locked python -m agentpic.worker` process, writes one JSON request to stdin, reads one JSON response, and validates the returned shape. Scientific logging uses stderr. Timeouts terminate the child. No SAX dictionaries or GDSFactory objects cross the adapter boundary.

Compilation assigns nominal lengths so circuit simulation is executable without layout. The full workflow runs compile → layout → backannotate → simulate → verify → manifest. State and events persist after transitions. Backend errors fail the task, block dependents and retain partial artifacts. A completed verification task may still report failed checks and cause overall failure. There is no automatic process-crash recovery or resume.

SAX can evaluate the supported model graph, while the present independent optical validation policy targets the emitted ideal MZI. Adding circuit families requires extending the compiler/model catalog and their independent verification policies. The placeholder EM request/result is not yet a complete material, mesh or solver configuration contract.

## Results

`RunResult` contains run/design IDs, status, verification status, server-local artifact directory, hashes and optional error. HTTP clients download through the artifact route; MCP uses resource URIs. `VerificationReport` includes per-check pass/fail/not_run, evidence, limitations and literal `foundry_signoff: false`.

`manifest.json` and `run.json` are not included in their own hash inventories. Local hashes are an integrity reference, not a signed attestation. Reverification returns a fresh report without altering the original evidence. Format 1.0 prototype artifacts are not accepted as version 2.0 runs.
