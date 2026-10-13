# Development roadmap and dependency tracking

| Task | Depends on | State |
|---|---|---|
| ADR-001: TypeScript engineering / Python science | — | Implemented |
| Shared Zod IR → JSON Schema → generated Pydantic | ADR-001 | Implemented; drift checked by CI |
| Canonical circuit compiler and semantic validation | shared contract | Implemented |
| SAX and GDSFactory adapters | compiler, JSON transport | Implemented; preserved circuit milestone |
| Generic evidence/experiment runtime and capability registry | shared contract, transport | Implemented |
| Planar TE SciPy backend and independent dispersion reference | experiment runtime | Implemented |
| Hypothesis diagnosis and adaptive experiment selection | physics backend | Implemented |
| Negative benchmarks and predeclared verification policy | reasoning, reference | Implemented |
| HTTP/MCP physics workflows and evidence retrieval | physics runtime | Implemented |
| Reproducible evidence bundle and hosted CI | all above | Implemented; acceptance/benchmark commands and CI artifact uploads |

## Capability development protocol

An unknown capability creates a machine-readable technical specification, candidate-library references, required contracts, test/benchmark gates and a dependency DAG. It is persisted as `development-request.json`. An external coding agent then researches, implements, tests and registers the adapter through the repository. This iteration itself used that pattern to add the previously missing SciPy mode-analysis capability.

Registration alone is not verification. A new numerical capability must bring independent reference evidence, valid and corrupted configuration tests, unit tests, convergence tests, resource bounds and documentation. Unimplemented capabilities cannot be invoked or promoted by an LLM explanation. The current platform does not embed an autonomous code-writing LLM or automatically install and deploy arbitrary new solvers.

## Next milestones

1. Extend mode analysis to vector 2D channel-waveguide models, with independent comparisons, dispersive materials and broader numerical policies.
2. Add optional LLM reasoning-provider orchestration that produces constrained hypotheses, while retaining deterministic numerical gates.
3. Expand scientific adapters (FDTDX, FEM, EME), calibrated compact models and device/PDK catalogs after establishing independent verification references.
4. Add durable scheduling, checkpoint recovery and cancellation for long computations.
5. Add optimization and fabrication-aware verification only when validated models and appropriate PDK/rule data exist.
