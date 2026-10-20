# Autonomous physical reasoning and verification

## Reusable engineering loop

TypeScript owns goal validation, unit normalization, model compilation, criteria, experiment selection, hypothesis evaluation and engineering status. `PhysicsRuntime` is domain independent; registered `PhysicsCapability` plugins supply model-specific policy. `ExperimentBackend` is replaceable and its Python implementation transports typed JSON. The initial plugin is a straight planar waveguide benchmark, not a device-specific runtime architecture.

The workflow records the submitted goal and compiles a valid numerical configuration. It persists criteria and candidate experiments before executing anything. After the baseline and independent reference, it evaluates hypotheses and selects the next experiment. Observed reference disagreement with short padding prioritizes boundary expansion; otherwise grid refinement is tested first. Each result triggers evidence evaluation. The bounded loop ends with all required evidence or an explicit inconclusive verdict.

Five distinct records identify physical principles, external LLM proposals, solver evidence, deterministic checks and the final engineering judgment. LLM text cannot change a tolerance, replace a solver result or mark a check passed. The default policy requires no LLM service; integrating an internal model-provider reasoning agent is future work.

## Scientific method and independent reference

The Python adapter uses [SciPy `eigh_tridiagonal`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.linalg.eigh_tridiagonal.html) to solve a real symmetric tridiagonal matrix. The adapter assembles the one-dimensional scalar TE Helmholtz operator with cell-averaged dielectric permittivity and zero field at finite domain boundaries:

```text
[d²/dx² + k₀² n(x)²] E(x) = β² E(x)
k₀ = 2π / λ,  n_eff = β / k₀
```

SciPy/LAPACK supplies the numerical eigensolver; AgentPIC does not implement a new eigensolver or FDTD engine. Core geometry and cladding thickness determine the domain; refinement changes grid spacing while retaining the physical model.

For the symmetric single-layer benchmark, an independent equation uses a different algorithm, [SciPy `brentq`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.brentq.html). With half-thickness a, core index n_c and background index n_b:

```text
V = k₀ a sqrt(n_c² − n_b²)
u tan(u) = sqrt(V² − u²),  0 < u < min(V, π/2)
n_eff = sqrt(n_c² − (u/(k₀ a))²)
```

This is the fundamental even TE mode. Both calculations assume linear, lossless, isotropic, nonmagnetic, propagation-invariant materials. Refractive indices are explicit constants, not a measured dispersion model. The reference validates this mathematical model and numerical implementation; it does not validate fabrication or a finite-width channel.

## Predeclared acceptance criteria

| Property | Criterion |
|---|---|
| Guided mode | n_background < n_eff < maximum core index |
| Propagation units | Relative β versus 2π n_eff/λ error ≤ 10⁻¹² |
| Solver equation residual | Relative residual ≤ 10⁻⁸ |
| Baseline spatial sampling | At least 20 cells across the thinnest core |
| Independent reference | Absolute n_eff error ≤ 10⁻⁴ |
| Grid convergence | Difference between two consecutive refinements ≤ 10⁻⁴ |
| Domain convergence | Difference after a second domain expansion ≤ 10⁻⁵ |
| Reproducibility | Repeated identical configuration differs by ≤ 10⁻¹² |

These are fixed policy criteria, persisted in every experiment before execution. They are not relaxed to make a benchmark pass. Small algebraic residual alone cannot pass the workflow. The baseline is checked separately from the final refined configuration.

## Outcomes and diagnosis

- `accepted`: the submitted baseline passes and the required independent experiment set supports the result.
- `improved`: the submitted baseline is not verified, but a revised numerical configuration passes all required evidence checks.
- `rejected`: completed experiments contradict physical or numerical acceptance criteria.
- `inconclusive`: required evidence is missing, experiments failed, or the budget is insufficient.
- `invalid`: input structure, units, material references or assumptions cannot produce a supported valid configuration.
- `unsupported`: the requested capability is absent; a development request is persisted.

Causes are hypotheses, not certainty beyond the evidence. A suspected unit error is reported with the explicit conversion and supported interval; the system never silently changes the wavelength. Corrupted output, coarse grids and boundary truncation are deliberate negative tests. False LLM explanations must be contradicted when numerical evidence disagrees.

## Reproducibility and resources

Each run includes goal/configuration JSON, experiment plan, per-experiment criteria and evidence, a structured report, event log, file hashes, source/schema/lock hashes, Node/Python package versions and Git state. Resource reporting includes wall time, accumulated solver time, experiment count, largest grid and estimated array storage. Array storage is an estimate, not peak process RSS; import/runtime overhead appears in wall time.

The benchmark registry records valid/invalid configurations, unit consistency, convergence, physical constraints, reproducibility, diagnosis and hypothesis evaluation. The test suite additionally checks error injection and real HTTP/MCP transports. A capability is not globally declared physically verified merely because it is registered; the benchmark artifact records exactly what evidence was produced for a particular revision.

The analytic slab reference of this workflow also validates the FDTDX characterization method before its channel-guide results enter the PDK (ADR-009).
