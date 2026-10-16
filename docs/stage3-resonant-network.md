# Stage 3: feedback networks and wavelength-selective PICs

Status: implemented and locally verified, 2026-10-16. The gates below were declared before implementation. Baseline: `1de026e9a47d39c5b4d22a1989aadb364f4cde51`.

## Design challenge and reuse

Extend the same engineering workflow to a four-port add/drop resonant feedback network, composed from existing ideal couplers, waveguides and optional phase control. Reuse SAX's circuit solver, GDSFactory MMI/path primitives and SciPy spectral analysis; do not write another network solver. The GDS uses explicit MMI-coupled return paths, not an evanescent microring with an inferred gap-to-coupling calibration.

Primary references: [SAX circuit construction](https://gdsfactory.github.io/sax/nbs/internals/02_circuit/), [GDSFactory ring workflow](https://gdsfactory.github.io/gplugins/notebooks/workflow_2_ring/), [GDSFactory port conventions](https://gdsfactory.github.io/gdsfactory/notebooks/01_references/). [SciPy peak extraction](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.find_peaks.html) finds sampled local maxima; half-maximum crossings are interpolated explicitly rather than confused with half-prominence widths. Installed source versions remain pinned in uv.lock.

## Predeclared gates

1. Add a typed `ring_add_drop` design recipe with two ideal power-coupling ratios, explicit physical loop dimensions and optional controlled phase. Use the existing neutral Circuit primitives and machine interfaces. The four-port graph contains a real feedback cycle; reject altered topology, ratios, dimensions, unsupported hierarchy and control settings. Zod remains the single contract source.
2. Generate actual GDS from two MMI polygons and two routed return paths, independently extract connections/ports, backannotate measured paths and verify geometry. Optical and metal checks retain their existing thresholds (1 nm centerline/port tolerance, explicit demonstration width/spacing/bend rules). Requested dimensions must be verified independently from layout metadata. Changing optical operating phase must preserve geometry.
3. Compare every complex external S-parameter against independent closed-form feedback summation. Require maximum complex error <1e-9 and reciprocity, passivity/unitarity errors within existing 1e-10 limits. Exercise symmetric and asymmetric coupling and control phase; expose mathematical assumptions separately from physical calibration.
4. Independently predict resonant wavelengths from measured path lengths, dispersion and applied phase. Extract actual drop peaks and half-maximum widths from the exported SAX spectrum using SciPy/NumPy. Verify peak locations within one grid step and adjacent spacing/linewidth within two grid steps. Require at least two fully observed resonances and at least 20 samples per theoretical linewidth. Coarse or clipped sweeps must explicitly fail spectral verification, even if complex values at sampled points are correct.
5. Demonstrate passive wavelength selection and automatic phase tuning to a requested drop/through target using the existing bounded optimization workflow. Verify every recorded candidate independently and retain failed-target/budget evidence. Never infer voltage, heating efficiency, intrinsic Q or fabrication readiness from this ideal model.
6. Real HTTP and MCP must emit matching netlist, GDS, resolved IR, spectrum, controls and optimization evidence. Fresh artifact reverification must pass. Fault tests must reject broken feedback, modified path length, coupling/phase errors, swapped ports, corrupted GDS and undersampled spectra.
7. Run the complete existing MZI/cascade/control/tuning/physics regression suite, generated-contract checks and two-Python-version CI. Preserve a clean-source reproducible delivery bundle and exact-revision evidence.

Dependencies: typed recipe/semantic intent → physical feedback assembly → independent complex reference → spectral sampling/features → existing tuning integration → corruption and transport tests → CI/delivery.

## Model boundary

The compact couplers have prescribed real through and quadrature cross amplitudes, with zero internal delay. Return waveguides use the existing assumed linear effective-index dispersion and zero loss. The modeled round-trip propagation length excludes MMI internal phase/delay; physical resonant frequency, extinction, loaded Q and loss therefore require separate EM or measurement calibration. Ratios are compact-model assumptions, not geometry-derived calibration. The four existing unperformed checks remain explicit when phase control is used.

## Executed evidence

- The passive ring completes actual HTTP/MCP design, binary GDS retrieval and fresh reverification with **31 pass / 3 not_run**. Its two measured return paths are 654.579 µm each. Maximum full complex-reference error is **5.3905473317941234e-12**.
- Four fully observed passive resonances lie at approximately 1548.372, 1549.336, 1550.300 and 1551.268 nm. Maximum peak error is **0.0019081 nm** on a **0.004 nm** grid; maximum spacing error is 0.0016424 nm and half-maximum linewidth error is 0.0001045 nm. Minimum resolution is 55.4 samples per theoretical linewidth, above the predeclared 20.
- The existing optimizer aligns a controlled drop resonance to 1550 nm in **36 network evaluations**, with phase **4.319214972123355 rad**, achieved drop power **0.9999997208687782** and maximum target error **2.791312221776228e-7**. Real HTTP/MCP artifacts match; fresh reverification gives **43 pass / 4 not_run**. Complex reference error is **4.487500370698491e-12**.
- KLayout compares actual optical/metal polygons before and after tuning and finds no difference. Geometry/actuator boundary tests at 200/150 µm and 600/500 µm loop dimensions pass; the larger measured loop exhibits the smaller free spectral range.
- Symmetric and asymmetric coupling cases satisfy independent on-resonance power equations and full-matrix checks. Unit drop transmission requested from asymmetric [0.3,0.6] coupling is correctly reported unmet.
- A coarse 21-point full workflow and a clipped 0.1 nm window produce failed spectral reports while retaining correct sampled S-parameters, GDS and evidence. Weak [0.05,0.05] coupling fails coarse sampling; a 2.4 nm/5001-point circuit passes independent spectral verification.
- Fault tests reject broken feedback, altered return length/coupling, swapped optical ports, corrupted complex data, changed loop dimensions and a removed physical return segment. Generated contracts preserve the ring's wider sampling range without broadening the MZI range.

Twelve new TypeScript tests and six Python contract tests cover this increment. Complete regression and exact-revision CI/delivery evidence are recorded with the revision. The mathematical model remains uncalibrated: spectral agreement does not establish physical coupler ratio, real resonant wavelength/Q, electrothermal efficiency or fabrication readiness.
