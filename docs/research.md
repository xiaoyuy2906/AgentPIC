# Open-source tool assessment

Milestone 1 research and integration decisions, checked 2026-10-11 against primary upstream documentation and the installed APIs. Exact tested versions are in `uv.lock`; this document does not promise compatibility with arbitrary future releases.

| Tool | Relevant capability | AgentPIC decision |
|---|---|---|
| [SAX](https://github.com/gdsfactory/sax) | Frequency-domain S-parameter circuits using JAX; component model functions and dictionary netlists | Pin 0.18.2. Use `sax.circuit` to assemble the MZI from explicit ideal couplers and waveguides; retain AgentPIC's own engineering contracts. |
| [GDSFactory](https://gdsfactory.github.io/gdsfactory/) | Parametric cells, physical ports, cross-sections, routing and GDS generation | Pin 9.51.0. Generate real geometry and extract its port netlist. Explicitly define the demo cross-section instead of treating generic PDK defaults as calibrated SiN. |
| [KLayout database API](https://www.klayout.de/doc-qt5/code/class_Region.html) | GDS readback, polygon regions and geometric width/spacing checks | Reopen the actual output and run a small explicit demonstration rule set without a GUI. This is not a foundry signoff deck. |
| [FDTDX](https://github.com/ymahlau/fdtdx) | Electromagnetic FDTD simulation in JAX | Reserve an adapter contract for a later milestone. No solver dependency, execution, field data or EM-calibrated model is claimed now. |
| [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) | Standard MCP tools, resources and stdio client/server support | Pin stable SDK 1.30.0; expose typed design tools and binary artifacts. Test with a real SDK client and subprocess. |

SAX and GDSFactory both expose useful dictionaries but these are backend contracts, not the complete engineering record. AgentPIC therefore keeps versioned Pydantic IR, units, design intent, assumptions, workflow dependencies and verification status outside those libraries. This avoids conflating a solver result, a physical layout and a validated engineering deliverable.

The main integration finding was that simulation must use actual routed lengths. Layout generation therefore precedes final SAX execution, with a compiler backannotation stage between them. Validation also needs independent equations and GDS readback: successful library calls alone cannot establish either physical connectivity or the model's correctness.
