# Stage 3: target-driven optical control

Status: implemented and locally verified, 2026-10-16. The gates below were declared before implementation. Baseline: `3ca3670bf91c377f6c50dcb653a94bf364460d8b`.

## Capability gap and reuse

The controlled MZI/cascade workflow accepts optical phase but cannot yet choose it from a desired transmission. Add bounded control-variable and transmission-target contracts, a numerical optimization adapter, explicit operating-point state, and independent verification within the complete design workflow. Geometry and source intent must remain intact.

[SciPy least_squares](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.least_squares.html) supplies bounded local nonlinear least squares; [SAX parameterized circuits](https://gdsfactory.github.io/sax/nbs/examples/01_quick_start/) supply network responses. Reuse both. An optimizer's success flag does not establish that engineering targets were met, and unsuccessful local search does not prove physical infeasibility.

## Predeclared gates

1. Typed targets specify optical input/output ports, wavelength in nm and normalized power. Variables use source instance paths and explicit phase bounds. Reject unknown/noncontrolled instances, duplicate variables/targets, invalid bounds, out-of-grid wavelengths and nonoptical targets. Zod remains the contract source.
2. Optimize actual backannotated optical paths in a full design. Preserve original specification/hierarchy and a pre-tuning IR; record applied operating point, every evaluated candidate, residuals, evaluation budget and termination reason. Only selected phase values may change. Do not regenerate geometry to meet a target.
3. Reuse SciPy and SAX for optimization. Count all network evaluations, including numerical Jacobian probes, against a hard budget. Deterministic starting points address stationary initial settings; make no global-optimality or uniqueness claim.
4. A balanced single MZI must reach specified output powers (including 0, 0.2, 0.5, 0.8 and 1); a controlled cascade must support multiple variables and optical targets. Default maximum absolute target-power error is 1e-6, with user-declared supported tolerance 1e-9 to 1e-3. Full complex independent reference error remains below 1e-9; passivity/reciprocity/unitarity limits remain 1e-10.
5. Independently derive achieved powers from the final exported complex S-matrix, compare backend predictions and selected trace entry, and enforce control bounds/budget/state consistency. A forged optimizer success, altered phase, changed target/trace, out-of-bound result or unreachable/under-budget request must not pass.
6. Real HTTP/MCP requests must produce matching engineering results, actual optical/metal GDS, machine-readable optimization evidence and fresh reverification. Failure reports must retain candidate evidence and all existing calibration/signoff limitations.
7. Original passive, cascade and fixed-phase acceptance and the complete regression suite remain passing. The circuit-only path may tune nominal lengths, but must distinguish that from the physical full-design result.

Dependencies: request/result contracts → phase-variable resolution and operating-point semantics → reusable SAX evaluator and SciPy adapter → runtime DAG and artifacts → independent checks → fault/transport tests → CI and reproducible delivery.

## Executed evidence

- Real HTTP/MCP acceptance on `examples/target_cascade_1550.json` produces identical GDS, netlist, full simulation, controls, original measured IR and search trace. Fresh reverification gives **42 pass / 4 not_run**.
- Two variables and three targets (two input ports and two wavelengths) meet tolerance in **30 network evaluations**. Maximum final target error is **7.98763319820317e-7**, below 1e-6. Full complex reference error is **3.493446838070748e-12**; independent replay of all candidate powers differs by at most **8.206768598029157e-13**.
- Single-MZI targets 0, 0.2, 0.5, 0.8 and 1 pass the stricter **1e-9** requested tolerance from a stationary zero phase. The analytic sin² power law is checked independently of the SAX implementation.
- A four-stage, four-variable design meets all sixteen input/output power targets at **1e-8** tolerance within a 512-evaluation budget, using signed phase bounds. A separate subset-variable case preserves the unselected phase and source hierarchy.
- KLayout comparison proves identical nonempty core and metal polygons before and after automatic tuning. Full optimization uses measured arm lengths, while circuit-only results explicitly report nominal lengths.
- Four instrumented numerical tests count actual SAX calls at budgets 1, 2, 9 and 13, including finite-difference probes. A one-call full workflow fails its optical target while preserving GDS, final simulation, best candidate and independent failed report.
- Fault tests reject changed intermediate trace powers, budget counts, status, predictions, target, applied phase, pre-tuning lengths and out-of-bound controls without relying solely on file hashes. Internally consistent fabricated success is rejected by final S-matrix checks and independent trace replay. Contradictory powers and unreachable bounds never pass on optimizer termination.
- Backend exceptions and invalid returned controls fail the tuning task, block downstream tasks and preserve prior artifacts. Generated Python contract round trips and limits are covered.

This is local optical control optimization of the declared compact model. The four explicit unperformed checks remain EM calibration, fabricated-device measurement, foundry signoff and electrical-to-phase calibration. It is not a proof of global optimality or physical feasibility. Dependency sequence is implemented through machine-interface acceptance; CI and per-revision delivery evidence are recorded separately.
