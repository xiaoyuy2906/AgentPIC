# AgentPIC development roadmap

Updated 2026-10-16: build the EDA, validate it with complete designs, and let increasingly demanding designs drive EDA development. The earlier standalone physics-reasoning milestone is superseded. Its implemented components remain supporting capabilities.

## Mission and architecture

Build a complete, agent-native photonic EDA platform that AI agents can develop, use, test, verify, maintain and extend. ADR-001 remains mandatory: TypeScript owns IR, compiler, workflow, verification management and API/MCP; Zod generates shared JSON Schema and Python Pydantic contracts; Python provides replaceable scientific and layout backends. No GUI is required. Reuse established tools instead of rewriting solvers without an engineering need.

## Seven stages

| Stage | Engineering goal | Acceptance boundary |
|---|---|---|
| 1 | Minimum complete agent-native PIC EDA | Typed IR, compilation, replaceable backend contracts, circuit simulation, layout, verification, API/MCP, reproducible artifacts, tests and CI |
| 2 | Design and verify a minimal complete PIC | MZI specification → Circuit IR → SAX → layout → verification → GDS through machine interfaces |
| 3 | Complex PICs, PDKs and manufacturing verification | Hierarchy and multiple components; design-driven capability development with independent evidence; fabrication claims require qualified PDK/rule data |
| 4 | Reusable photonic functional blocks | Verified optical function, composability and validity ranges |
| 5 | Application-level photonic accelerators | Demonstrated application function and system-level benefit |
| 6 | Photonic/electronic co-design | Verified interfaces and behavior across the combined system |
| 7 | New photonic computing architectures | Agents propose, evaluate and improve architectures through engineering feedback |

Stages 4–7 are long-term research directions, not current feature commitments. Photonic computing is one possible application, not a requirement for every PIC workflow. The MZI is a benchmark, not a device-specific product architecture.

## Implementation and dependencies

| Task | Depends on | State |
|---|---|---|
| ADR-001 and generated shared contracts | — | Implemented; CI checks generation drift |
| Circuit compiler and semantic validation | contracts | Implemented; specification recipes support SiN MZIs, 2–4 stage cascades and add/drop feedback rings |
| Circuit/layout backend interfaces | compiler, JSON transport | Implemented with SAX and GDSFactory |
| Workflow, backannotation, verification and artifact inventory | adapters, compiler | Implemented |
| API/MCP and complete MZI acceptance | workflow, verification | Implemented; real transport and binary GDS checks |
| Tests, two-version CI and evidence | all above | Implemented; CI also preserves failed test evidence |
| Physics experiment/hypothesis support | contracts, transport | Additional capability: planar TE calculations and independent analytical reference |
| Missing-capability specification and dependencies | registry | Implemented; coding execution remains external to the runtime |
| Generic hierarchy compiler, alias resolution and API/MCP | shared circuit contract | Implemented with bounded expansion and source-path traceability |
| Complete cascaded-MZI benchmark | hierarchy, physical assembly, independent transfer reference | Implemented; real API/MCP GDS workflow and fault-injection checks pass |
| Controlled optical phase and metal actuators | mixed-domain component contract, optical projection, metal verification | Implemented in single/cascaded MZI workflows; electrical-to-phase calibration remains absent |
| Target-driven optical operating points | control contract, reusable SAX evaluation, SciPy search, independent trace/target checks | Implemented with bounded local optimization and explicit failed-target evidence |
| Resonant feedback and resolved spectra | cyclic Circuit topology, physical return paths, independent feedback/peak checks | Implemented with actual GDS and shared target tuning; compact couplers remain uncalibrated |
| Qualified PDKs, calibrated models, full-vector/3D EM | independent references and design demand | Future Stage 3 work |

## Design-driven capability development

Use the loop: design → discover an EDA limitation → research existing implementations → extend a contract/adapter or core capability → add independent tests and physical benchmarks → debug → register with evidence → rerun the original design.

Unknown physics capabilities produce a persisted `development-request.json` with a technical specification, candidate-library references and dependency DAG. An external coding agent performs implementation, testing and integration in this repository. The runtime does not embed an autonomous code-writing LLM or automatically deploy unverified solvers.

Verification is layered: circuit references and port topology; model validity and full complex S-parameter constraints; numerical convergence where required; extracted layout connectivity and lengths; qualified PDK rules when available. These checks are not a universal photonic equivalent of digital logic equivalence checking. Physics reasoning generates testable hypotheses and further experiments; explanations alone never establish correctness.

## Next development milestone

The passive, controlled and target-driven cascade and feedback-ring workflows now exercise hierarchy, physical composition, feedback cycles, mixed optical/electrical terminals, bounded search and independent complex/spectral verification. The next major gap is physical model validity: resonant wavelengths currently depend on assumed waveguide dispersion and zero-delay ideal couplers. A channel-waveguide/EM-backed model should provide traceable effective/group indices, units, validity ranges, convergence and independent reference evidence before replacing those assumptions. Reuse existing mode/EM implementations and rerun complete design workflows after integration. Coupler geometry calibration, qualified PDK rules and general hierarchy placement/routing remain separate requirements. More named device examples alone do not establish a complete EDA platform.
