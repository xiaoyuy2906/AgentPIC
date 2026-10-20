/**
 * Machine-readable capability audit. An agent reads this to see what exists, how far it goes
 * and what is missing. Every implemented or partial capability names the tests that prove it;
 * core/tests/capabilities.test.ts fails if a named test does not exist, and the README table
 * is generated from this list.
 */
import { listPDKs } from './pdk.js';

export type CapabilityStatus = 'implemented' | 'partial' | 'missing';
export interface Capability {
  domain: string;
  name: string;
  status: CapabilityStatus;
  /** Exact TypeScript test titles, or `tests/<file>.py::<function>` for Python tests. */
  evidence: string[];
  limitation: string;
}

export const CAPABILITIES: Capability[] = [
  {
    domain: 'contracts',
    name: 'typed_shared_contracts',
    status: 'implemented',
    evidence: [
      'tests/test_generated_contracts.py::test_python_models_are_generated_from_ts_contract',
      'OpenAPI local schema references resolve',
    ],
    limitation: 'Pre-1.0 contract; version 3.0 artifacts are not migrated from earlier versions.',
  },
  {
    domain: 'design',
    name: 'designs_are_data',
    status: 'implemented',
    evidence: [
      'engine sources never name a device family, device instance or device port',
      'checked-in design files equal their generators and compile without engine changes',
      'cascades of up to four stages simulate without new engine code',
    ],
    limitation: 'Three primitive kinds: ideal coupler, waveguide and phase shifter.',
  },
  {
    domain: 'design',
    name: 'hierarchical_netlists',
    status: 'implemented',
    evidence: [
      'two reused modules flatten to distinct primitives with traceable aliases',
      'a hierarchical design flattens with source paths and keeps its module definitions',
    ],
    limitation: 'At most 32 levels and 10000 expanded primitives.',
  },
  {
    domain: 'design',
    name: 'semantic_validation',
    status: 'implemented',
    evidence: [
      'canonical compilation has stable IDs and native Component/Port/PDK contracts',
      'layout plan rejects a route whose end is not a placed instance',
    ],
    limitation: 'Schema-valid but physically meaningless parameter combinations can still pass.',
  },
  {
    domain: 'pdk',
    name: 'pdk_as_data_with_sources',
    status: 'implemented',
    evidence: [
      'the PDK is loaded from data, binds the design identity and rejects unknown names',
      'tests/test_pdk.py::test_a_cell_that_disagrees_with_its_declared_ports_is_a_pdk_error',
      'tests/test_pdk.py::test_simulation_uses_the_pdk_mode_model',
    ],
    limitation: 'One demonstration SiN PDK; components cover three primitive kinds.',
  },
  {
    domain: 'pdk',
    name: 'foundry_pdk',
    status: 'missing',
    evidence: [],
    limitation:
      'No foundry PDK or rule deck; cspdk and ubcpdk ship only placeholder compact models.',
  },
  {
    domain: 'simulation',
    name: 's_parameter_circuit_solver',
    status: 'implemented',
    evidence: [
      'design → TS IR → semantic validation → JSON → Python SAX → result',
      'a phase shifter keeps its electrical terminals outside the optical matrix',
      'tests/test_pdk.py::test_simulation_uses_the_pdk_mode_model',
    ],
    limitation: 'SAX frequency domain only; reciprocal, lossless ideal models.',
  },
  {
    domain: 'simulation',
    name: 'independent_network_reference',
    status: 'implemented',
    evidence: ['independent verification rejects corrupted phase, gain, dimensions and port order'],
    limitation:
      'Shares the compact-model equations with SAX: it checks the solver, not the physics.',
  },
  {
    domain: 'simulation',
    name: 'spectral_sampling_and_resonances',
    status: 'implemented',
    evidence: [
      'an undersampled spectrum fails although every sampled S-parameter is correct',
      'a clipped window fails the declared resonance measurement',
      'narrow weakly coupled resonances need, and pass with, an explicitly refined grid',
    ],
    limitation: 'Resonance measurement finds peaks only, at half of the peak power.',
  },
  {
    domain: 'simulation',
    name: 'loss_bend_and_dispersion_models',
    status: 'missing',
    evidence: [],
    limitation:
      'Zero propagation and bend loss; bends carry straight-guide phase; linear dispersion.',
  },
  {
    domain: 'simulation',
    name: 'time_domain_circuit',
    status: 'missing',
    evidence: [],
    limitation: 'No transient or modulated-signal circuit simulation.',
  },
  {
    domain: 'physics',
    name: 'cross_section_mode_characterization',
    status: 'implemented',
    evidence: [
      'tests/test_characterization.py::test_fdtdx_reproduces_the_analytic_slab_within_the_validation_criterion',
      'tests/test_characterization.py::test_strip_mode_model_is_the_accepted_characterization_evidence',
      'tests/test_characterization.py::test_verification_accepts_matching_evidence_and_rejects_tampering',
      'engine code reaches FDTDX only through time stepping, never tidy3d or its mode solver',
    ],
    limitation:
      'FDTDX on the nominal geometry; slab method error 8.3e-4; no sidewall angle, roughness or process variation.',
  },
  {
    domain: 'physics',
    name: 'device_level_em_characterization',
    status: 'missing',
    evidence: [],
    limitation: 'MMI couplers use ideal prescribed ratios; no FDTDX S-parameters of fixed cells.',
  },
  {
    domain: 'physics',
    name: 'planar_mode_experiment_loop',
    status: 'implemented',
    evidence: [
      'straight waveguide autonomous evidence loop accepts valid physics',
      'false LLM explanation cannot override numerical evidence',
      'missing capability yields an actionable development DAG, never fake execution',
    ],
    limitation: 'Symmetric planar TE slab only.',
  },
  {
    domain: 'physics',
    name: 'electrothermal_actuation',
    status: 'missing',
    evidence: [],
    limitation:
      'Optical phase is commanded directly; no voltage, power or temperature-to-phase model.',
  },
  {
    domain: 'layout',
    name: 'placement',
    status: 'partial',
    evidence: [
      'anchored placement keeps sub-nanometre link requests within the 1 nm layout grid',
      'negative, zero and large imbalances route in a four-stage series layout',
    ],
    limitation: 'Placement is declared (absolute or port-anchored); no automatic placer.',
  },
  {
    domain: 'layout',
    name: 'routing',
    status: 'implemented',
    evidence: [
      'a route without steps is found by the automatic router and backannotated',
      'bundled routes keep their separation and pass spacing, LVS and crossing checks',
      'the layout engine rejects routes that cannot be drawn with the PDK bend radius',
    ],
    limitation: 'Manhattan routes with circular bends; no waveguide crossings or tapers.',
  },
  {
    domain: 'layout',
    name: 'layout_versus_schematic',
    status: 'implemented',
    evidence: [
      'independent LVS reports opens, shorts and pins without geometry',
      'a crossing waveguide fails even though connectivity-based checks cannot see it',
      'tests/test_lvs.py::test_three_pins_at_one_point_are_ambiguous_and_domains_never_mix',
    ],
    limitation: 'Pin-based extraction with geometric evidence, not polygon device recognition.',
  },
  {
    domain: 'layout',
    name: 'design_rule_checks',
    status: 'partial',
    evidence: [
      'corrupt extraction, geometry, lengths, links and removed GDS segments cannot pass',
      'verification rejects moved/missing metal, swapped terminals, altered phase and controls',
    ],
    limitation: 'Demonstration width, spacing and bend-radius rules; no foundry rule deck.',
  },
  {
    domain: 'layout',
    name: 'length_backannotation',
    status: 'implemented',
    evidence: [
      'arm imbalance and link lengths are measured from the routed geometry',
      'violated layout constraints fail verification with measured evidence',
    ],
    limitation: 'Lengths only; bends are not given separate phase or loss.',
  },
  {
    domain: 'optimization',
    name: 'phase_target_tuning',
    status: 'implemented',
    evidence: [
      'full target design uses measured lengths and preserves exact optical and metal polygons',
      'hard budget failure retains best candidate, GDS, final simulation and independent failed report',
      'tests/test_tuning.py::test_budget_counts_actual_sax_calls_including_jacobian',
    ],
    limitation:
      'Bounded local search over at most four phases; no global optimality or feasibility proof.',
  },
  {
    domain: 'optimization',
    name: 'geometry_inverse_design',
    status: 'missing',
    evidence: [],
    limitation: 'No geometry optimization or adjoint inverse design.',
  },
  {
    domain: 'verification',
    name: 'evidence_provenance_and_integrity',
    status: 'implemented',
    evidence: [
      'same input reproduces GDS and circuit JSON across isolated backend processes',
      'corrupted simulation, topology, GDS and inventory cannot pass verification',
      'trace, target, fixed-state and selected-control corruption fail without relying on artifact hashes',
    ],
    limitation: 'Local SHA-256 inventory; not a signed attestation.',
  },
  {
    domain: 'verification',
    name: 'variability_and_yield',
    status: 'missing',
    evidence: [],
    limitation: 'No process corners, Monte Carlo or yield analysis.',
  },
  {
    domain: 'verification',
    name: 'measurement_validation_and_signoff',
    status: 'missing',
    evidence: [],
    limitation: 'No fabricated-device measurements or foundry signoff.',
  },
  {
    domain: 'integration',
    name: 'http_mcp_cli',
    status: 'implemented',
    evidence: [
      'real HTTP API reuses TS compiler and completes design',
      'real MCP stdio tools use TS contract and retrieve binary GDS',
    ],
    limitation: 'Trusted-local service without authentication or multi-tenant isolation.',
  },
  {
    domain: 'integration',
    name: 'long_running_jobs',
    status: 'missing',
    evidence: [],
    limitation: 'Requests are synchronous; FDTDX characterization runs only as an offline command.',
  },
];

export const missingCapabilities = () => CAPABILITIES.filter((c) => c.status === 'missing');
/** What GET /v1/capabilities, MCP get_capabilities and `agentpic capabilities` return. */
export const capabilityReport = () => ({
  schema_version: '3.0',
  core: 'typescript',
  solvers: { circuit: 'sax', electromagnetic: 'fdtdx (optional em dependency group)' },
  primitives: ['ideal_coupler', 'waveguide', 'phase_shifter'],
  pdks: listPDKs(),
  capabilities: CAPABILITIES,
  missing: missingCapabilities().map((c) => c.name),
});
const mark = { implemented: '✅ implemented', partial: '🟡 partial', missing: '❌ missing' };
/** The README capability table, regenerated by `npm run generate`. */
export const capabilityTable = () =>
  [
    '| Domain | Capability | Status | Limitation |',
    '|---|---|---|---|',
    ...CAPABILITIES.map(
      (c) => `| ${c.domain} | \`${c.name}\` | ${mark[c.status]} | ${c.limitation} |`,
    ),
  ].join('\n');
export const TABLE_START = '<!-- capabilities:start (generated by npm run generate) -->';
export const TABLE_END = '<!-- capabilities:end -->';
