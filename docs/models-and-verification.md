# Compact models and verification boundaries

All lengths inside the compact models are in µm. Input wavelengths use nm and are explicitly divided by 1000 at the backend boundary. The nominal process has layer/datatype 1/0 and no foundry association. Index values are engineering assumptions for exercising the design system, not values derived from a mode solver or a measured SiN stack.

## Waveguide

For reference wavelength λ₀ = 1.55 µm, assumed effective index n₀ = 1.8 and group index n_g = 1.9:

```text
n_eff(λ) = n₀ + (n₀ − n_g) (λ − λ₀) / λ₀
p(λ, L) = 10^(−α L / (10⁴ × 20)) exp(i 2π n_eff(λ) L / λ)
```

α is power loss in dB/cm and is fixed to zero in this milestone. Both transmission directions use p and both reflections are zero. Circuit-only compilation uses nominal lengths from the TypeScript compiler. In a full design run, L is measured from the routed GDSFactory path, rounded to 0.001 µm, and recorded in resolved IR before simulation. Verification independently sums the sampled centerline and allows 0.001 µm annotation error.

## Controlled optical phase

The `phase_shifter` model retains the waveguide's passive propagation over its complete routed length and multiplies it by exp(i φ₀ λ₀ / λ). The specified φ₀ is an optical phase at λ₀, not an electrical bias. The independent verifier instead constructs induced optical-path difference ΔOPL = φ₀ λ₀ / (2π) and evaluates exp(i 2π (n_eff L + ΔOPL) / λ). The change is reciprocal and lossless under the explicit ideal assumptions.

A balanced MZI therefore has output-0 power sin²(φ₀ λ₀ / (2λ)): at λ₀, phases 0, π/2, π and 2π give powers 0, 1/2, 1 and 0. These values and the wavelength dependence are independently tested. Cascades reuse the same controlled primitive and transfer composition.

The active metal length sets a geometry footprint, not an actuator efficiency. There is no calibrated relation between voltage, current, power, temperature, induced refractive index and commanded optical phase. Software bounds do not establish thermal feasibility. Controlled designs explicitly report `phase_actuation_calibration: not_run`.

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

The independent reference multiplies these 2×2 matrices directly without importing SAX models or layout construction. SAX separately solves the flattened primitive network. Both use the resolved physical waveguide lengths. For two stages with equal link lengths, the input-0 output-0 power also satisfies cos²(π n_eff (ΔL₂ − ΔL₁) / λ), covered by a separate test. Complex error, reciprocity, passivity and unitarity limits are unchanged from the single-stage benchmark.

## Layout

Two GDSFactory MMI cells are connected by two circular-bend arms with a 50 µm radius. The generated path changes by the specified imbalance; a negative imbalance lengthens the bottom arm. The waveguide width is 1 µm. MMI width/length are 5/40 µm with 10 µm tapers. This creates actual polygons and port connectivity but does not establish that those MMI dimensions realize a 50:50 splitter in a real material stack.

Cascades place 2–4 such blocks in a row and extrude two straight port-to-port links between adjacent blocks. All primitive references appear in one top-level assembly; logical module hierarchy remains traceable through the source-path map. Layout positions use a 0.001 µm grid. Interconnect-length and backannotation errors must be at most 0.001 µm, and each stage's imbalance error at most 0.002 µm.

Controlled arms use GDSFactory metal cross sections to place a 2.5 µm-wide metal segment on layer/datatype 2/0, centered over the longest straight top-arm segment. Its 20–200 µm length is user specified. Electrical terminals at both metal ends are exposed; vias, bond pads, electrical routing and a qualified material stack are not supplied. KLayout independently compares actual metal polygons with the expected footprint, checks dimensions within 0.001 µm, checks coverage over the optical path and checks metal width/spacing under the demonstration rules. Terminal position/orientation/domain checks are separate. Blue in the static SVG is optical core; orange is metal.

The extracted port netlist is compared with compiler intent. KLayout independently opens the exported GDS, checks nonempty connected core geometry, minimum width/spacing, and that narrow corridors around every arm and interconnect centerline are covered by the core. Bend radii are checked from the sampled centerline. These checks detect missing connections, broken paths and some geometry violations; they do not constitute full polygon-extracted LVS, foundry DRC, density, enclosure, process-corner, packaging or yield checks.

## Evidence interpretation

`passed_with_limitations` means every implemented check passed for the stated model and demonstration geometry rules. Three required capabilities remain `not_run`: electromagnetic calibration, fabricated-device measurement validation, and foundry signoff. They are present in every verification report, including failed reports. Controlled optical calculations also report missing electrical-to-phase calibration. `foundry_signoff` is constrained to `false` in the public report schema.

Tests deliberately corrupt the complex scattering matrix, extracted netlist, GDS geometry and stored artifacts to ensure verification detects failures. Boundary cases include balanced arms and positive/negative imbalances through ±200 µm. Backend exceptions are tested separately from failed engineering checks.

## Add/drop feedback model

Let k₁,k₂ be the two power coupling ratios, tⱼ=√(1−kⱼ), and pᵣ,pₗ the complex propagation factors of the right and left return paths. Ideal reciprocal couplers use through amplitude tⱼ and cross amplitude i√kⱼ. Summing repeated round trips gives D=1−t₁t₂pᵣpₗ and the forward two-bus matrix:

```text
T00 = (t1 − t2 pr pl) / D       T01 = −sqrt(k1 k2) pl / D
T10 = −sqrt(k1 k2) pr / D       T11 = (t2 − t1 pr pl) / D
```

The reverse block is Tᵀ by reciprocity; reflection blocks vanish in this ideal model. Independent verification constructs this full 4×4 matrix without importing SAX. At a symmetric-coupling resonance the drop power reaches one and through power vanishes; asymmetric couplings generally cannot reach unit drop transmission. Tests require optimization to report that target as unmet rather than accepting solver convergence.

For total modeled return length L, reference wavelength λ₀ and commanded phase φ, the assumed linear dispersion gives round-trip phase divided by 2π as A/λ+B, where A=n_g L+φλ₀/(2π) and B=(n_eff−n_g)L/λ₀. Resonance order m has λ_m=A/(m−B). With ρ=t₁t₂, the half-maximum phase offset from resonance is δ=2 asin((1−ρ)/(2√ρ)); exact half-maximum wavelengths use denominators m−B±δ/(2π). The supported coupling interval keeps these real. Spectral verification uses these predictions and independently extracts measured peaks/widths from SAX output. It rejects inadequate resolution and clipped coverage even when sampled complex values agree.

The compact model has zero internal coupler phase/delay, zero propagation/bend loss and prescribed coupling ratios. Physical MMI geometry is illustrative. Predicted extinction, resonant wavelength and loaded Q are properties of these assumptions, not calibrated device or fabrication claims. Actual GDS verification proves geometric/port consistency within the demonstration rules only.
