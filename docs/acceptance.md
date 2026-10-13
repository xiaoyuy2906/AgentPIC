# Stage 1–2 acceptance criteria

The product is a minimum complete agent-native PIC EDA. A 1550 nm SiN Mach–Zehnder interferometer is the first full-design benchmark. Physics reasoning is a supporting capability. Successful execution alone is insufficient.

## Stage 1: EDA capabilities

| Requirement | Implementation | Evidence |
|---|---|---|
| Typed engineering IR | Zod Component, Port, Connection, Circuit, PDK and workflow schemas | Strict TypeScript tests; generated JSON Schema/Pydantic drift checks |
| Circuit compilation | Specification normalization, topology, port/reference and model/PDK validation | Valid input and schema-valid but semantically invalid circuits |
| Backend independence | Typed JSON process boundary and scientific interfaces | Neutral IR/results; no SAX/GDSFactory internals exposed |
| Circuit simulation | Real SAX/JAX complex S-matrix | Independent analytic MZI comparison, reciprocity, passivity and lossless power balance |
| Physical layout | Real GDSFactory geometry and extracted connectivity | GDS readback, extracted circuit, physical port/length consistency and demonstration geometry checks |
| Workflow and verification | TypeScript dependency DAG and independent verification manager | Failed task persistence, downstream blocking and corruption detection |
| Machine interfaces | HTTP API and standard MCP stdio | Real clients submit specifications, retrieve reports and download binary GDS |
| Reproducible artifacts | Versioned inputs/results, source/contract/lock hashes and inventory | Same-input artifacts match across independent processes in one environment |
| Tests and CI | Node 22; uv-managed Python 3.12/3.13 | Schema, type, format, unit/integration, MZI acceptance and physics benchmark checks |

## Stage 2: complete MZI benchmark

Submit through `POST /v1/designs` or MCP `design_pic` (under `specification`):

```json
{"device":"mzi","platform":"sin","wavelength_nm":1550,"outputs":["netlist","simulation","gds","verification"]}
```

Run `npm run acceptance -- --output runs/acceptance` to exercise both transports. Required outcomes:

1. The specification compiles into valid typed circuit IR and the circuit-only path invokes SAX successfully.
2. The complete workflow creates actual GDS, extracts layout connectivity and backannotates routed lengths before final simulation.
3. Verification passes within the demonstration model's stated limits, including connectivity, complex amplitude/phase behavior, optical power and layout consistency.
4. Reverification reports 27 passing checks and three explicit `not_run` items: EM model calibration, measurement validation and foundry signoff.
5. HTTP and MCP retrieve actual binary GDS and produce matching hashes for GDS, resolved IR, layout, netlist and simulation.
6. Invalid input, corrupted artifacts and backend failures are detected by the automated suite.

The final simulation uses physical routed lengths. A nominal circuit-only simulation is also available before layout; backannotation prevents accepting simulation of lengths that differ from the generated design.

## Limits of acceptance

The initial circuit specification compiler supports parameterized SiN MZIs. The architecture is modular, but arbitrary PIC synthesis, general hierarchy, automatic optimization, qualified foundry PDKs and fabrication signoff are not implemented.

The demonstration compact model uses ideal couplers and explicit propagation assumptions. Mathematical checks validate those equations and their integration, not a fabricated device. The physical MMI has not been EM-calibrated to the ideal model. See `docs/models-and-verification.md`.

The additional planar TE workflow has separate criteria in `docs/physics-verification.md` and `benchmarks/registry.json`. Its passing benchmark does not establish physical accuracy of the MZI compact models.
