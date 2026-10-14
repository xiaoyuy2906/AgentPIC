# Stage 3 benchmark: two cascaded MZIs

Status: implemented and all local acceptance gates passed on 2026-10-14. Hosted results are published per revision in [CI](https://github.com/xiaoyuy2906/AgentPIC/actions/workflows/ci.yml). The complete Stage 1–2 evidence baseline remains commit `1262411ffc31f6a21ca35d941e332370d4945998`, CI run https://github.com/xiaoyuy2906/AgentPIC/actions/runs/38414150524.

## Capability gap exposed by the design

Two independently parameterized MZI blocks joined by two optical interconnects require reusable module definitions, distinct instance paths, flattened circuit semantics, module-aware layout extraction and an independent composed transfer reference. The earlier code assumed one four-port MZI in compilation, layout and numerical verification. Merely concatenating two GDS files cannot establish connectivity or simulation/layout consistency.

## Existing implementations reviewed

- [SAX hierarchical circuits](https://gdsfactory.github.io/sax/nbs/examples/11_hierarchical_circuits/) supports nested circuit composition. Keep that representation inside the SAX adapter; AgentPIC owns the module contract and semantic compilation.
- [GDSFactory netlist extraction](https://gdsfactory.github.io/gplugins/notebooks/11_get_netlist/) supports recursive extraction and hierarchy inspection. Normalize extracted results to the shared IR before comparison.
- [GDSFactory routing](https://gdsfactory.github.io/gdsfactory/api_routing/) supplies port-to-port physical routing. Reuse established layout operations and backannotate actual connecting lengths.

## Fixed acceptance gates

1. Repeated module instances must have unique, deterministic primitive names and recoverable instance paths. Reject duplicate definitions/names, missing modules/ports, recursive definitions, incompatible/double-connected/dangling ports and disconnected circuits.
2. Validate a generic hierarchy contract without device names or solver-owned structures. Zod remains the only editable schema source.
3. The complete cascade must execute through API and MCP, export real connected GDS and backannotate every waveguide length, including interconnects.
4. Compare the full complex cascade S-matrix to an independent composition of the two analytic MZI transfer matrices and propagation links; maximum complex error < 1e-9. Reciprocity/unitarity errors < 1e-10 and maximum singular value <= 1 + 1e-10.
5. Compare extracted physical connectivity to the flattened intended circuit. Preserve existing demonstration width, spacing, bend, port and length checks without relaxing tolerances.
6. Corrupt one module reference, one interconnect, one optical result and one geometry artifact; each must be rejected at the appropriate validation layer.
7. Existing single-MZI HTTP/MCP acceptance and all prior regression tests must remain passing. Mathematical model consistency does not constitute EM calibration or foundry signoff.

## Dependency order

Generic module IR and compiler → topology/alias tests → cascade specification compiler → backend composition and physical extraction → independent numerical/geometry checks → API/MCP acceptance → publish reproducible evidence.

Do not report this benchmark complete until all gates have executed successfully. Hierarchy compilation alone is an intermediate capability.

## Executed evidence

`examples/cascaded_mzi_1550.json` runs through the same compile/design API and MCP interfaces as the single MZI. The two stages have 10/20 µm imbalances and two 100 µm connecting waveguides; the compiled network contains 10 primitives, 12 internal connections and four external ports. Supported series assemblies contain 2–4 stages.

```sh
npm run acceptance -- --specification examples/cascaded_mzi_1550.json --output runs/cascade-acceptance
```

- Full HTTP and MCP runs generated connected GDS and identical hashes for eight engineering artifacts, including the logical hierarchy, source paths and physical plan.
- Reverification: 30 passes, three `not_run` items and no failures. Single-MZI regression acceptance remains 27 passes and three `not_run` items.
- Maximum full-complex SAX/reference error: 1.9327e-12 against the fixed 1e-9 threshold. Reciprocity error: 4.45e-16; unitarity error: 1.33e-15; maximum singular value: 1.0000000000000009.
- Both links measure 100 µm. Maximum centerline/backannotation error: 0.000263 µm. KLayout readback finds one connected core, no demonstration width/spacing violations and no missing centerline corridor area.
- Four-stage execution covers negative, balanced and positive imbalances. A three-stage boundary case covers ±200 µm and 10.0004 µm links; GDS grid rounding is accepted only within the predeclared 0.001 µm physical-length tolerance.
- Corrupted module intent, extracted interconnect, complex optical result and GDS each fail verification. Independent hierarchy tests cover recursion, unresolved ports, naming collisions and bounded expansion.
- Complete local suite: 79 TypeScript tests, 11 Python tests, original and cascade machine-interface acceptance, and all eight existing physics benchmark expectations passed. Generation, type and formatting checks also passed.

These are ideal-model and demonstration-geometry results. Arbitrary hierarchical placement/routing, calibrated MMI behavior, phase-shifter physics, qualified PDK rules and foundry signoff remain unsupported.
