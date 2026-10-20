# Compact models and verification boundaries

All lengths inside the compact models are in µm. Input wavelengths use nm and are explicitly divided by 1000 at the backend boundary. Every number below comes from `pdks/sin_demo_v1.json`, which records its source: the waveguide indices are engineering assumptions for exercising the design system, not values derived from a mode solver or a measured SiN stack, and are reported as such in every verification report.

## Waveguide

For reference wavelength λ₀ = 1.55 µm, effective index n₀ = 1.63973 and group index n_g = 2.0723 from the FDTDX characterization of the 1.0 × 0.4 µm strip (`pdks/sin_demo_v1.strip.characterization.json`, ADR-009). These replaced assumed values of 1.8 and 1.9, which were 9.8 % and 8.3 % off:

```text
n_eff(λ) = n₀ + (n₀ − n_g) (λ − λ₀) / λ₀
p(λ, L) = 10^(−α L / (10⁴ × 20)) exp(i 2π n_eff(λ) L / λ)
```

α is power loss in dB/cm and is fixed to zero in this milestone. Both transmission directions use p and both reflections are zero. Circuit-only compilation uses nominal lengths from the TypeScript compiler. In a full design run, L is measured from the routed GDSFactory path, rounded to 0.001 µm, and recorded in resolved IR before simulation. Verification independently sums the sampled centerline and allows 0.001 µm annotation error.

## Controlled optical phase

The `phase_shifter` model retains the waveguide's passive propagation over its complete routed length and multiplies it by exp(i φ₀ λ₀ / λ). The specified φ₀ is an optical phase at λ₀, not an electrical bias. The independent verifier instead constructs induced optical-path difference ΔOPL = φ₀ λ₀ / (2π) and evaluates exp(i 2π (n_eff L + ΔOPL) / λ). The change is reciprocal and lossless under the explicit ideal assumptions.

A balanced MZI therefore has output-0 power sin²(φ₀ λ₀ / (2λ)): at λ₀, phases 0, π/2, π and 2π give powers 0, 1/2, 1 and 0. These values and the wavelength dependence are golden references in `core/tests/simulation.test.ts`.

The active metal length sets a geometry footprint, not an actuator efficiency. There is no calibrated relation between voltage, current, power, temperature, induced refractive index and commanded optical phase. Software bounds do not establish thermal feasibility. Controlled designs explicitly report `phase_actuation_calibration: not_run`.

## Independent reference

Production verification never uses device formulas (ADR-007). `src/agentpic/circuit_reference.py` builds the block-diagonal S-matrix of every primitive from the equations above and eliminates internal waves: S = S_ee + S_ei (I − P S_ii)⁻¹ P S_ie, where P pairs connected internal ports. It shares the compact-model equations with SAX but not its code or network solver, so agreement checks the solver and netlist translation, not the physics of the ideal models. The complex tolerance is 10⁻⁹; reciprocity, passivity and unitarity tolerances are 10⁻¹⁰.

`spectral_sampling` evaluates the same reference at every midpoint of the sweep grid and requires linear interpolation of exported powers to agree within 1/400. A unit-height Lorentzian sampled 20 times per half-maximum width just meets this bound, so undersampled resonances fail even when every exported sample is exact.

The device closed forms below are the golden references the tests compare against.

## Ideal coupler and complete MZI

The ideal reciprocal couplers have through amplitude √(1−κ) and cross amplitude i√κ with κ = 0.5. There is no reflection, loss, coupler dispersion, taper phase or bend-induced phase correction. Port names and the chosen orientation are explicit in the netlist.

Let a = p(λ, L_top), b = p(λ, L_bottom). With ports ordered `[in0, in1, out0, out1]`, the independent analytic transfer block is:

```text
T = 1/2 [[b − a, i(b + a)],
         [i(b + a), a − b]]
S = [[0, transpose(T)],
     [T,            0]]
```

For input `in0`, output powers are |S₂₀|² and |S₃₀|². At 1550 nm with ΔL = 10 µm, they are approximately 0.8793790613 and 0.1206209387. The full complex spectrum is compared with the independent formula, rather than just testing that a solver returned successfully. The complex tolerance is 10⁻⁹; reciprocity, passivity and unitarity tolerances are 10⁻¹⁰. JAX double precision is enabled.

## Cascaded MZIs

For stages numbered from input to output, let T_j be the independent MZI transfer above and D_j = diag(p(λ, L_j,0), p(λ, L_j,1)) represent the two physical interconnects after stage j. The composed forward transfer is:

```text
T_total = T_N D_(N−1) T_(N−1) ... T_2 D_1 T_1
S_total = [[0, transpose(T_total)],
           [T_total,            0]]
```

For two stages with equal link lengths, the input-0 output-0 power also satisfies cos²(π n_eff (ΔL₂ − ΔL₁) / λ), covered by a separate test. Complex error, reciprocity, passivity and unitarity limits are unchanged from the single-stage benchmark.

## Layout

The layout engine places `sin_demo_v1` cells and routes waveguides from a design's layout plan (see `docs/interfaces.md`). Couplers are GDSFactory MMI cells (width/length 5/40 µm, 10 µm tapers); waveguides are 1 µm wide with 50 µm circular bends. This creates actual polygons and port connectivity but does not establish that those MMI dimensions realize the declared coupling ratio in a real material stack.

All primitive references appear in one top-level cell; logical module hierarchy remains traceable through the source-path map. Layout positions use a 0.001 µm grid. Backannotation error must be at most 0.001 µm; declared length constraints default to 0.001 µm and length-difference constraints to 0.002 µm.

Phase shifters use GDSFactory metal cross sections to place a 2.5 µm-wide metal segment on layer/datatype 2/0, centered over the longest straight section of their optical path. Its 20–200 µm length is user specified. Electrical terminals at both metal ends are exposed; vias, bond pads, electrical routing and a qualified material stack are not supplied. KLayout independently compares actual metal polygons with the expected footprint, checks dimensions within 0.001 µm, checks coverage over the optical path and checks metal width/spacing under the demonstration rules. Terminal position/orientation/domain checks are separate. Blue in the static SVG is optical core; orange is metal.

`src/agentpic/lvs.py` performs layout versus schematic without using the layout builder. It re-extracts connectivity from physical pins: two pins of one domain that coincide with equal width and opposite orientation form a connection, a lone pin is open, and any other coincidence is ambiguous (a short). The result must equal the schematic netlist exactly, with every external port open and every internal port mated. Each pin must also sit on real GDS geometry (a 0.1 µm probe inside it must be covered by core or metal), and no waveguide's centreline corridor, trimmed 2 µm at each end, may overlap another waveguide or the body of a coupler. Crossing waveguides merge into one connected region, so connectivity-based checks cannot see them; the crossing check can. This is pin-based photonic LVS, not polygon device recognition.

The builder's own extracted port netlist is also compared with compiler intent. KLayout independently opens the exported GDS, checks nonempty connected core geometry, minimum width/spacing, and that narrow corridors around every arm and interconnect centerline are covered by the core. Bend radii are checked from the sampled centerline. These checks detect missing connections, broken paths and some geometry violations; they do not constitute full polygon-extracted LVS, foundry DRC, density, enclosure, process-corner, packaging or yield checks.

## Electromagnetic characterization of the strip

| Case | Grids (nm) | Observed order | Extrapolated n_eff | Check |
|---|---|---|---|---|
| Slab, 0.4 µm, TE, 1550 nm | 50, 40, 25 | 2.04 | 1.744463 | analytic 1.743632; error 8.3 × 10⁻⁴ ≤ 1 × 10⁻³ |
| Strip, 1500 nm | 50, 40, 25 | 2.04 | 1.653791 | |
| Strip, 1550 nm | 50, 40, 25 | 2.02 | 1.639734 | |
| Strip, 1600 nm | 50, 40, 25 | 2.02 | 1.625882 | |

The group index 2.0723 is the central difference of the extrapolated values. Worst phase-fit residual is 0.016 rad and worst projection amplitude spread 3.1 %, against criteria of 0.05 rad and 10 %. The slab criterion of 1 × 10⁻³ (0.06 %) sits below the index shift of a 10 nm width change; at 25 nm the slab result is still pre-asymptotic because of interface staircasing, which finer grids would reduce at higher cost. The twelve FDTD runs took 499 s on one laptop CPU. These are simulations of the nominal cross-section, not measurements: sidewall angle, roughness and process variation are absent.

## Evidence interpretation

`passed_with_limitations` means every implemented check passed for the stated model and demonstration geometry rules. `electromagnetic_characterization` lists which used compact models rest on electromagnetic evidence; it passes only when all of them do, and is `not_run` for any design with an ideal coupler. Fabricated-device measurement validation and foundry signoff are always `not_run`. They are present in every verification report, including failed reports. Controlled optical calculations also report missing electrical-to-phase calibration. `foundry_signoff` is constrained to `false` in the public report schema.

Tests deliberately corrupt the complex scattering matrix, extracted netlist, GDS geometry and stored artifacts to ensure verification detects failures. Boundary cases include balanced arms and positive/negative imbalances through ±200 µm. Backend exceptions are tested separately from failed engineering checks.

## Add/drop feedback model

Let k₁,k₂ be the two power coupling ratios, tⱼ=√(1−kⱼ), and pᵣ,pₗ the complex propagation factors of the right and left return paths. Ideal reciprocal couplers use through amplitude tⱼ and cross amplitude i√kⱼ. Summing repeated round trips gives D=1−t₁t₂pᵣpₗ and the forward two-bus matrix:

```text
T00 = (t1 − t2 pr pl) / D       T01 = −sqrt(k1 k2) pl / D
T10 = −sqrt(k1 k2) pr / D       T11 = (t2 − t1 pr pl) / D
```

The reverse block is Tᵀ by reciprocity; reflection blocks vanish in this ideal model. At a symmetric-coupling resonance the drop power reaches one and through power vanishes; asymmetric couplings generally cannot reach unit drop transmission. Tests require optimization to report that target as unmet rather than accepting solver convergence.

For total modeled return length L, reference wavelength λ₀ and commanded phase φ, the assumed linear dispersion gives round-trip phase divided by 2π as A/λ+B, where A=n_g L+φλ₀/(2π) and B=(n_eff−n_g)L/λ₀. Resonance order m has λ_m=A/(m−B). With ρ=t₁t₂, the half-maximum phase offset from resonance is δ=2 asin((1−ρ)/(2√ρ)); exact half-maximum wavelengths use denominators m−B±δ/(2π). Tests use these predictions as golden references for measured peak spacing; production verification relies on the generic sampling check and the declared `resonances` measurement.

The compact model has zero internal coupler phase/delay, zero propagation/bend loss and prescribed coupling ratios. Physical MMI geometry is illustrative. Predicted extinction, resonant wavelength and loaded Q are properties of these assumptions, not calibrated device or fabrication claims. Actual GDS verification proves geometric/port consistency within the demonstration rules only.
