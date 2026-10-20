# Open-source tool assessment

Milestone 1 research and integration decisions, checked 2026-10-11 against primary upstream documentation and the installed APIs. Exact tested versions are in `uv.lock`; this document does not promise compatibility with arbitrary future releases.

| Tool | Relevant capability | AgentPIC decision |
|---|---|---|
| [SAX](https://github.com/gdsfactory/sax) | Frequency-domain S-parameter circuits using JAX; component model functions and dictionary netlists | Pin 0.18.2. Use `sax.circuit` to assemble the MZI from explicit ideal couplers and waveguides; retain AgentPIC's own engineering contracts. |
| [GDSFactory](https://gdsfactory.github.io/gdsfactory/) | Parametric cells, physical ports, cross-sections, routing and GDS generation | Pin 9.51.0. Generate real geometry and extract its port netlist. Explicitly define the demo cross-section instead of treating generic PDK defaults as calibrated SiN. |
| [KLayout database API](https://www.klayout.de/doc-qt5/code/class_Region.html) | GDS readback, polygon regions and geometric width/spacing checks | Reopen the actual output and run a small explicit demonstration rule set without a GUI. This is not a foundry signoff deck. |
| [FDTDX](https://github.com/ymahlau/fdtdx) | Electromagnetic FDTD simulation in JAX | Reserve an adapter contract for a later milestone. No solver dependency, execution, field data or EM-calibrated model is claimed now. |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Standard MCP tools, resources and stdio transport | Serve tools from TS Core using shared Zod contracts. Test with a real SDK client and subprocess. |
| [Zod](https://zod.dev/json-schema) | Typed schemas and native JSON Schema export | Sole editable Engineering IR definition; generate Python Pydantic models from its schemas. |
| [SciPy linear algebra](https://docs.scipy.org/doc/scipy/reference/generated/scipy.linalg.eigh_tridiagonal.html) | LAPACK-backed symmetric tridiagonal eigenproblems | Use the existing eigensolver for the scalar planar TE benchmark; retain configuration, convergence policy and evidence in AgentPIC. |
| [SciPy root finding](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.brentq.html) | Bracketed scalar root solving | Solve the independent symmetric-slab dispersion relation with a different numerical method; compare against the discretized mode calculation. |

SAX and GDSFactory both expose useful dictionaries but these are backend contracts, not the complete engineering record. AgentPIC therefore keeps versioned TypeScript/Zod IR, units, design intent, assumptions, workflow dependencies and verification status outside those libraries. This avoids conflating a solver result, a physical layout and a validated engineering deliverable.

The main integration finding was that simulation must use actual routed lengths. Layout generation therefore precedes final SAX execution, with a compiler backannotation stage between them. Validation also needs independent equations and GDS readback: successful library calls alone cannot establish either physical connectivity or the model's correctness.

## Open PDK assessment (2026-10-20)

Both candidates were installed into an isolated environment next to the pinned gdsfactory 9.51.0 and SAX 0.18.2 and their model sources read directly.

| PDK | Version | Compact models found | Decision |
|---|---|---|---|
| [cspdk](https://github.com/gdsfactory/cspdk) (Cornerstone) | 2.1.0 | `sin300.models.straight` uses constant `neff=1.60`, `ng=1.95`; MMIs are generic Gaussian `sax.models` with `fwhm=0.2`; `coupler_straight` and `coupler_symmetric` raise `NotImplementedError`. No measured or simulated S-parameter data. | Not a model source. Its layer maps and cells could later become a second PDK data file whose models come from characterization. |
| [ubcpdk](https://github.com/gdsfactory/ubcpdk) (SiEPIC EBeam) | 1.3.4 | `simulation/circuits/waveguide.py` is a polynomial `neff(λ)` with n1=2.4; no S-parameter data files ship with the package. | Not a model source. |

Neither ships calibrated compact models, so adopting one would replace one placeholder with another. AgentPIC instead keeps its PDK as a data file (`pdks/sin_demo_v1.json`) in which every model, material and rule names its source, and replaces assumed values with characterization evidence (ADR-008).
