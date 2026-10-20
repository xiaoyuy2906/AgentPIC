# Project structure and reading guide

About 3,900 lines of TypeScript engine, 2,000 lines of Python backends (plus a 1,100-line generated contract file you never edit) and 2,400 lines of tests. This guide gives the order that makes the code easiest to read, and what each file is for.

## One request, end to end

```
designs/mzi.json ──► compile (TS) ──► EngineeringIR ──► layout (Py) ──► backannotate (TS)
  design = data        compiler.ts      contracts.ts      layout.py        compiler.ts
                       design.ts                          lvs.py (verify)
                       pdk.ts ◄── pdks/sin_demo_v1.json
        ──► [tune (Py)] ──► simulate (Py, SAX) ──► verify (TS + Py) ──► manifest
            tuning.py       circuit.py              verification.ts/.py, circuit_reference.py,
                                                    spectral.py, lvs.py, tuning-verification.ts
```

`runtime.ts` runs these tasks as a DAG and writes every artifact. TypeScript and Python meet at exactly one boundary: `backends.ts` writes one JSON request to `python -m agentpic.worker` and validates the JSON reply.

## Reading order

1. **`core/src/contracts.ts`** (492): every data shape. Read `DesignSpecSchema`, `LayoutPlanSchema`, `PDKSchema` and `EngineeringIRSchema` closely; skim the rest.
2. **`designs/templates.ts`** (457) and **`designs/mzi.json`**: what a design looks like. This is the only place that knows what an MZI or a ring is.
3. **`pdks/sin_demo_v1.json`**: every process fact and its source.
4. **`core/src/compiler.ts`** (183), **`design.ts`** (176), **`pdk.ts`** (134), **`hierarchy.ts`** (150): how a design becomes a validated IR, and every semantic check.
5. **`core/src/runtime.ts`** (261): the workflow DAG, artifacts and provenance.
6. **`core/src/backends.ts`** (106) and **`src/agentpic/worker.py`** (114): the process boundary.
7. **`src/agentpic/backends/layout.py`** (357): placement, routing (steps, auto, bundle), smoothing, extraction, GDS.
8. **`src/agentpic/backends/circuit.py`** (128): the SAX adapter and compact models.
9. **Verification**: `core/src/verification.ts` (318) orchestrates; `src/agentpic/verification.py` (441), `circuit_reference.py` (76), `spectral.py` (88) and `lvs.py` (162) are the independent checks.
10. **Tuning**: `core/src/tuning.ts` (116), `tuning-verification.ts` (108), `src/agentpic/backends/tuning.py` (126).
11. **Physics evidence**: `src/agentpic/characterize.py` (201) and `backends/fdtd.py` (129); the evidence they produced is `pdks/sin_demo_v1.strip.characterization.json`.
12. **Agent surfaces**: `core/src/api.ts` (225), `mcp.ts` (186), `cli.ts` (67), `capabilities.ts` (301).
13. **Tests**: start with `core/tests/architecture.test.ts` (the freeze rule), then `simulation.test.ts` (device golden references) and `layout.test.ts`.

## Directory map

| Path | Purpose |
|---|---|
| `core/src/contracts.ts` | Zod source of every contract; JSON Schema and Python models are generated from it |
| `core/src/compiler.ts` | `compile`, `validateIR`, generic semantic checks, `backannotate` |
| `core/src/design.ts` | Design-input semantics: source intent, port order, layout plan, measurements |
| `core/src/pdk.ts` | Load PDK data; PDK-driven component, validity and geometry checks |
| `core/src/hierarchy.ts` | Flatten module hierarchies with collision-free names and source paths |
| `core/src/tuning.ts`, `tuning-verification.ts` | Tuning variables, operating points and their evidence checks |
| `core/src/runtime.ts` | Workflow execution, artifacts, provenance, run lookup |
| `core/src/verification.ts` | Layout/LVS-lite checks in TS; orchestrates Python checks; builds the report |
| `core/src/backends.ts`, `paths.ts` | Python process boundary; project root |
| `core/src/capabilities.ts` | Capability audit and the README table generator |
| `core/src/api.ts`, `mcp.ts`, `cli.ts` | HTTP, MCP and command-line surfaces over the same functions |
| `core/src/check.ts`, `json.ts` | Check-result helper; canonical JSON for hashing and comparison |
| `core/src/physics/` | Evidence-driven planar TE experiment loop (`planar-te.ts` is its plugin) |
| `src/agentpic/worker.py` | One JSON request per process; dispatches to backends |
| `src/agentpic/backends/layout.py` | GDSFactory placement, routing and extraction |
| `src/agentpic/backends/circuit.py` | SAX circuit simulation |
| `src/agentpic/backends/tuning.py` | SciPy bounded phase search with an exact evaluation budget |
| `src/agentpic/backends/fdtd.py` | FDTDX adapter: effective index from time-domain phase |
| `src/agentpic/backends/planar_modes.py` | 1D planar TE solver and its analytic slab reference |
| `src/agentpic/backends/preview.py` | SVG preview from GDS |
| `src/agentpic/verification.py` | Independent numerical, geometry, actuator, tuning and model-evidence checks |
| `src/agentpic/circuit_reference.py` | Dense network elimination, the independent circuit reference |
| `src/agentpic/spectral.py` | Sampling adequacy and resonance measurement |
| `src/agentpic/lvs.py` | Pin-based layout versus schematic and crossing detection |
| `src/agentpic/characterize.py` | Offline FDTDX characterization of a PDK cross-section |
| `src/agentpic/pdk.py` | Small helpers to read PDK data |
| `src/agentpic/ir.py` | **Generated** Pydantic models; never edit |
| `designs/` | Design generators (`templates.ts`) and the generated design files |
| `pdks/` | PDK data files and characterization evidence |
| `examples/` | Non-design requests: a hierarchy to flatten, a physics goal |
| `scripts/` | Acceptance over HTTP + MCP, generators, physics benchmarks |
| `schemas/` | **Generated** JSON Schema and OpenAPI |
| `core/tests/`, `tests/` | TypeScript and Python tests |
| `docs/` | Architecture decisions, contracts, models, roadmap, progress; `history/` holds superseded milestone records |

## Where a change goes

| You want to | Change | Never change |
|---|---|---|
| Add a device | A generator in `designs/templates.ts`, `npm run generate`, golden tests | Engine code; the architecture test will fail |
| Add a process | A file in `pdks/`, plus characterization evidence for its cross-sections | Engine code |
| Add a primitive kind | `contracts.ts` (kind enum), the PDK, `circuit.py` and `circuit_reference.py` models | Device names anywhere in the engine |
| Add a verification check | `verification.ts` or `verification.py`, a test, and evidence in `capabilities.ts` | Existing check IDs (agents rely on them) |
| Change a contract | `contracts.ts`, then `npm run generate` | `schemas/` or `src/agentpic/ir.py` by hand |

Generated files (`schemas/`, `src/agentpic/ir.py`, `designs/*.json`, the README capability table) are regenerated by `npm run generate`; CI rejects drift.
