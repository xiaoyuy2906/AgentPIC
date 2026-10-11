# Architecture and decisions

## Mission and milestone

AgentPIC is an API/MCP-first photonic EDA system. Milestone 1 accepts a typed 1550 nm SiN MZI specification and produces a real netlist, SAX simulation, GDSFactory layout/GDS and machine-readable verification evidence. No GUI or language-model API is needed to execute a workflow. An external agent calls deterministic tools; model-provider orchestration is outside this milestone.

## ADR-001: Reuse engines, own the engineering contracts

SAX solves compact-model circuits and GDSFactory builds layouts. AgentPIC owns the Engineering IR, compiler, dependency runtime, API/MCP and independent verification. FDTDX/FEM/EME remain explicit unsupported backend contracts. The superseded FDTD-first scaffold is removed from runtime dependencies.

## ADR-002: Layout precedes final simulation

The compiler emits a four-instance MZI (two ideal 2x2 couplers and two waveguides). The layout adapter measures actual arm centerlines; the compiler backannotates those lengths before SAX simulation. This avoids simulation of a different length imbalance from the generated GDS. Port connectivity is extracted from placed geometry and compared with the intended netlist.

## ADR-003: Explicit model validity

`sin_demo_v1` is an illustrative process with a 1 µm wide, 0.4 µm thick core, 50 µm bend radius, layer 1/0, assumed neff=1.8 and ng=1.9 at 1550 nm, and zero loss. These values are NOT a calibrated material/device model. Ideal 50:50 couplers are mathematically validated, not EM-validated representations of the MMI polygons. No foundry signoff or fabrication readiness is claimed.

## ADR-004: Reproducible and observable local execution

uv owns `.venv` and `uv.lock`. Runtime records task states/dependencies, normalized input, resolved IR, exact backend versions, source/lock hashes, artifact hashes and failures. Each invocation gets a separate run directory. GDSFactory's global cell state is serialized within one process. API binds to localhost by default; MCP uses stdio. No hidden network simulation jobs are submitted.

## ADR-005: Independent verification

Verification reads saved artifacts and exported GDS. It checks topology, physical port connectivity, centerline lengths, SAX predictions against a separately coded analytic MZI, reciprocity/passivity and demonstration geometry rules. Checks that require calibrated models or a foundry PDK are reported as not run, never silently passed. Verification can be rerun on existing artifacts.
