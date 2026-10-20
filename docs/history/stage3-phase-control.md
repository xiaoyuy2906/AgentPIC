# Stage 3 benchmark: programmable MZI and cascade

Status: implemented; local gates executed on 2026-10-15. Gates were declared before implementation on 2026-10-14. Baseline: `c110f2cd951e43fda96e6e21c1cfb1736b3c67f5` (complete passive cascade). Hosted evidence is published per revision in [CI](https://github.com/xiaoyuy2906/AgentPIC/actions/workflows/ci.yml).

## Design need and missing capability

Switching a balanced MZI between output ports without changing its geometry requires a controlled optical phase primitive. The passive compiler currently accepts only waveguides/couplers, the circuit adapter assumes every port is optical, and layout verification only reads the optical core. Extend the shared component model, mixed-domain port handling, physical actuator geometry and independent verification together. This must remain a complete machine-interface design workflow.

## Reuse and model boundary

- [SAX parameterized models](https://gdsfactory.github.io/sax/nbs/examples/01_quick_start/) implement reciprocal scattering functions and solve their interconnected network. Reuse this circuit engine.
- [GDSFactory heater cross sections](https://gdsfactory.github.io/gdsfactory/api/) provide metal heater sections and electrical ports. Reuse GDSFactory path/straight/extrusion operations and typed optical/electrical ports; no bespoke polygon solver is needed.
- The initial control is an explicitly specified phase in radians at the PDK reference wavelength. It represents a constant induced optical-path difference, so extra phase scales as reference wavelength / wavelength. It is not a voltage, current, power or temperature prediction.
- Put a metal actuator on a straight part of the top arm, with two exposed electrical terminals. No via/pad stack, thermal model, actuator efficiency, electrical circuit solution or fabrication qualification is implied. Reports must expose the missing electrical-to-optical calibration.

## Fixed acceptance gates

1. Zod remains the sole contract source. Optional phase-control specifications must carry units and bounds; reject malformed controls, inconsistent model kinds, missing electrical terminals and optical/electrical misconnection.
2. The same reusable primitive must work in single MZIs and 2–4 stage cascades. Preserve logical source paths and physical length backannotation. SAX receives optical ports only; electrical terminals remain in engineering IR and GDS port metadata.
3. A balanced MZI must route input 0 to output 1 at phase 0, split power at π/2, route to output 0 at π and return at 2π (power error < 1e-9 at 1550 nm). Full complex response must agree with independent analytic propagation/interference within 1e-9 across the wavelength sweep. Reciprocity, unitarity and passivity retain their 1e-10 limits.
4. Complete HTTP/MCP runs must create real core and metal GDS, retrieve binary artifacts and independently reverify connectivity, lengths and control intent. Numerical tuning must not change the physical geometry.
5. Independently reopen GDS to check every intended metal actuator region, dimensions and exposed terminal positions. Removing or moving metal, swapping a terminal, changing phase intent or corrupting optical response must fail verification even without artifact-hash checks.
6. Existing single/cascade acceptance and all regression suites must pass. Retain explicit EM/measurement/signoff limitations, adding unperformed electrical-to-phase calibration for controlled designs.

## Dependencies

Typed control/model contracts → compiler and domain semantics → SAX optical projection → GDSFactory actuator geometry and terminals → independent optical/metal verification → negative and transport tests → CI and reproducible evidence.

## Executed evidence

`examples/tunable_mzi_1550.json` requests a balanced MZI with π phase and a 100 µm metal actuator. `examples/tunable_cascade_1550.json` requests two balanced stages with π/2 and π phases and 100/150 µm metal actuators.

```sh
npm run acceptance -- --specification examples/tunable_cascade_1550.json --output runs/phase-acceptance
```

- Balanced single-MZI tests at phases 0, π/2, π, 2π and −π/2 satisfy the independent sin² power law across the wavelength sweep. The optical S-matrix remains 4×4 while IR/layout expose the extra electrical ports.
- Full layout runs at 0 and π have identical core and metal polygons under KLayout symmetric-difference comparison, while the center-wavelength power changes from 0 to 1 at output 0.
- Controlled cascade HTTP/MCP acceptance: 35 passing checks, four `not_run` items, identical hashes for nine engineering artifacts and verified binary GDS retrieval. Center transmission is 0.5/0.5.
- Full complex reference error: 2.4162e-12 (limit 1e-9); reciprocity error 4.44e-16 and unitarity error 1.11e-15. Actual metal comprises two regions with zero symmetric-difference area against intended footprints and zero actuator-length error for this example.
- Missing/moved metal, swapped terminals, altered phase intent, changed control artifacts, corrupted complex output and malformed matrix shape are rejected. Missing calibration remains explicit in failed optical reports.
- A four-stage design mixes controlled and passive blocks, ±200 µm imbalances and 20/200 µm actuator lengths. Original single/passive-cascade acceptance remains passing.
- Local suite: 96 TypeScript tests, 15 Python tests; all eight auxiliary physics benchmark expectations pass. Generated schemas/models reproduce without drift.

No electrical or thermal solver, calibrated phase efficiency, via/pad stack, physical loss model or foundry signoff is included. The next functional design should require bounded optimization from an optical transmission target, retaining these evidence boundaries.
