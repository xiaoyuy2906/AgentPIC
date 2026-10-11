# Compact models and verification boundaries

All lengths inside the compact models are in µm. Input wavelengths use nm and are explicitly divided by 1000 at the backend boundary. The nominal process has layer/datatype 1/0 and no foundry association. Index values are engineering assumptions for exercising the design system, not values derived from a mode solver or a measured SiN stack.

## Waveguide

For reference wavelength λ₀ = 1.55 µm, assumed effective index n₀ = 1.8 and group index n_g = 1.9:

```text
n_eff(λ) = n₀ + (n₀ − n_g) (λ − λ₀) / λ₀
p(λ, L) = 10^(−α L / (10⁴ × 20)) exp(i 2π n_eff(λ) L / λ)
```

α is power loss in dB/cm and is fixed to zero in this milestone. Both transmission directions use p and both reflections are zero. The length L is measured from the routed GDSFactory path, rounded to 0.001 µm, and recorded in resolved IR before simulation. Verification independently sums the sampled centerline and allows 0.001 µm annotation error.

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

## Layout

Two GDSFactory MMI cells are connected by two circular-bend arms with a 50 µm radius. The generated path changes by the specified imbalance; a negative imbalance lengthens the bottom arm. The waveguide width is 1 µm. MMI width/length are 5/40 µm with 10 µm tapers. This creates actual polygons and port connectivity but does not establish that those MMI dimensions realize a 50:50 splitter in a real material stack.

The extracted port netlist is compared with compiler intent. KLayout independently opens the exported GDS, checks nonempty connected core geometry, minimum width/spacing, and that narrow corridors around both arm centerlines are covered by the core. Bend radii are checked from the sampled centerline. These checks detect missing connections, broken paths and some geometry violations; they do not constitute full polygon-extracted LVS, foundry DRC, density, enclosure, process-corner, packaging or yield checks.

## Evidence interpretation

`passed_with_limitations` means every implemented check passed for the stated model and demonstration geometry rules. Three required capabilities remain `not_run`: electromagnetic calibration, fabricated-device measurement validation, and foundry signoff. They are present in every verification report, including failed reports. `foundry_signoff` is constrained to `false` in the public report schema.

Tests deliberately corrupt the complex scattering matrix, extracted netlist, GDS geometry and stored artifacts to ensure verification detects failures. Boundary cases include balanced arms and positive/negative imbalances through ±200 µm. Backend exceptions are tested separately from failed engineering checks.
