# Stage 3: generic circuit compilation and simulation

Scope fixed before acceptance execution: reuse the existing Circuit IR, hierarchy
flattening, SAX adapter, runtime and API/MCP. No new primitive, solver, device
recipe or generic placement/routing. Preserve ADR-001 and all existing recipes.

## Acceptance gates

1. `device: circuit` accepts externally supplied instances, parameters, connections,
   external ports, versioned model references and a wavelength sweep. Semantic
   checks reject missing/reused endpoints, incompatible models/domains, disconnected
   networks, invalid names and incomplete/duplicate optical port order.
2. `generic_chain_1550.json` is a two-port chain of three waveguides. At every
   wavelength both transmission amplitudes equal `exp(i beta sum(lengths))` and
   reflections vanish, with maximum complex error below `1e-9`.
3. `generic_coupler_1550.json` is a standalone four-port coupler with coupling
   power 0.27. Its complete complex matrix matches `sqrt(1-k)` through and
   `i sqrt(k)` cross amplitudes below `1e-9`. Both benchmarks use arbitrary
   external names and explicit order different from the port-map insertion order.
4. Real SAX results also agree with an independent NumPy reference that eliminates
   internal waves from primitive matrices. Reciprocity and unitarity errors must
   be below `1e-10`; the largest singular value must be at most `1+1e-10`.
   Port-order, complex-phase, gain and source-artifact corruption must fail.
5. Real HTTP and MCP compile, simulate, persist and reverify both benchmarks.
   Their core artifact hashes must agree. Structured evidence, full complex
   matrices, CSV, provenance, source intent and manifests must be preserved.
6. Generic layout and layout verification are `not_run`, including when GDS is
   requested. No layout task or GDS file is created; direct layout calls reject
   generic inputs. Simulation success does not establish physical validity.
7. Generated contracts, type/lint checks, full TS/Python regressions, six existing
   machine-interface acceptances and eight physics benchmarks pass locally and
   in the Python 3.12/3.13 CI matrix.

## Interface and boundaries

Use existing HTTP `/v1/compile`, `/v1/simulations`, `/v1/designs` and run-verification
routes; MCP `compile_pic`, `simulate_circuit`, `design_pic`, `verify_run`; or CLI
`compile`, `simulate`, `design`, `verify`. Examples are complete input contracts.
The existing `flatten_circuit` result's `circuit` can be supplied unchanged when
within this milestone's limits; hierarchy source paths are not carried by this
flat-input workflow.

`models` maps each used primitive kind to its exact neutral model ID:
`waveguide: ideal_sin_waveguide_v1`, `ideal_coupler: ideal_coupler_v1`,
`phase_shifter: ideal_phase_shifter_v1`. Unknown, missing and unused references
are rejected. This release supports one fixed model per primitive kind under the
illustrative `sin_demo_v1` assumptions, not arbitrary plugins or calibrated PDKs.
At most 32 instances, 16 external optical ports and 1,001 sweep samples are
accepted. Every primitive port is occupied once; the graph must be connected.

`port_order` lists every external optical port exactly once. The complex arrays
have shape `[wavelength][output_port][input_port]`. Electrical ports of existing
phase shifters remain in the IR but are excluded from optical scattering.
Legacy `input_port`/`transmission_out0`/`transmission_out1` summaries are null for
generic circuits; recipe responses retain their previous values. Generic CSV
contains wavelength, output/input names, real and imaginary amplitudes.

There is no generic target tuning, physical backannotation, layout/GDS, foundry
signoff or model calibration. Verification concerns sampled ideal-model responses;
generic feedback-network resonance coverage and convergence are not certified.
Singular references or unsuccessful comparisons fail. There is no general
condition-number or convergence guarantee; `generic_spectral_resolution` is `not_run`.

## Reproduction

```sh
uv sync --locked
npm ci
npm run generate
npm run typecheck
npm test
uv run pytest -q
npm run acceptance -- --specification examples/generic_chain_1550.json --output runs/generic-chain-acceptance
npm run acceptance -- --specification examples/generic_coupler_1550.json --output runs/generic-coupler-acceptance
```

Each acceptance directory includes `acceptance.json`, `independent-reference.json`,
HTTP/MCP verification, circuit-only results and the persisted run artifacts.
CI retains these alongside all existing evidence. See `.github/workflows/ci.yml`
for the complete acceptance commands.

Local execution on 2026-10-17 passed 148 TS tests, 32 Python tests, deterministic
contract regeneration, type/format/lint checks, both new HTTP/MCP acceptances,
all six existing design acceptances and all eight physics benchmark expectations.
Each generic reverification reports 24 passes and six explicit not-run checks.
Chain closed-form error is 1.7057e-13 (independent network error 1.9906e-13);
coupler error is zero. These are ideal-model numerical errors, not measurement
accuracy. The exact commit's hosted CI remains the authority for Linux/Python
3.12 and 3.13 verification.
