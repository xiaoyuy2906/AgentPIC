# Persistent development progress

Current goal: minimum viable autonomous physics reasoning and verification, using a straight optical waveguide as a benchmark. The latest scope preserves ADR-001 and the completed MZI circuit/layout capabilities while adding an extensible experiment/evidence workflow.

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

The final local TypeScript suite passed 50 tests and Python passed 8 tests, with zero failures. Strict TypeScript compilation, schema generation, formatting and Python lint checks passed. The eight-case physics benchmark suite passed its expected outcomes; the acceptance runner also requires every registered check for the valid baseline to pass. Hosted CI runs both Python 3.12 and 3.13 and uploads physics and MZI evidence. See [the current CI results](https://github.com/xiaoyuy2906/AgentPIC/actions/workflows/ci.yml), `docs/roadmap.md` for dependencies and `benchmarks/registry.json` for benchmark acceptance requirements.

No foundry signoff, full-vector channel solver, 3D EM implementation, fabricated-device calibration, embedded code-writing agent, or production solver deployment is claimed. uv continues to manage `.venv`; both dependency lock files are committed.
