/** Sole editable contract source. Python models are generated from its JSON Schema. */
import { z } from 'zod';
import { PhysicsContracts } from './physics/contracts.js';
const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);
// Hierarchical instance path such as "module/instance"; a flat instance is its own path.
const instancePath = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z][A-Za-z0-9_]*)*$/);
const positive = () => z.number().positive();
const pdkName = z.string().regex(/^[a-z][a-z0-9_]*$/);
const record = <T extends z.ZodType>(value: T) => z.record(z.string(), value);
const phase = () =>
  z
    .number()
    .min(-4 * Math.PI)
    .max(4 * Math.PI);
export const TuningSpecSchema = z
  .strictObject({
    targets: z
      .array(
        z.strictObject({
          input_port: name,
          output_port: name,
          wavelength_nm: z.number().min(1450).max(1650),
          power: z.number().min(0).max(1),
        }),
      )
      .min(1)
      .max(16),
    variables: z
      .array(
        z.strictObject({
          instance_path: z.array(name).min(1),
          min_phase_rad: phase(),
          max_phase_rad: phase(),
        }),
      )
      .min(1)
      .max(4),
    power_tolerance: z.number().min(1e-9).max(1e-3).default(1e-6),
    max_evaluations: z.number().int().min(1).max(512).default(128),
  })
  .meta({ id: 'TuningSpec' });
export const ResolvedTuningVariableSchema = z
  .strictObject({
    instance: name,
    min_phase_rad: phase(),
    max_phase_rad: phase(),
  })
  .meta({ id: 'ResolvedTuningVariable' });
export const TuningCandidateSchema = z
  .strictObject({
    controls: record(phase()),
    powers: z.array(z.number().nonnegative()),
  })
  .meta({ id: 'TuningCandidate' });
export const TuningResultSchema = z
  .strictObject({
    backend: z.string().min(1),
    status: z.enum(['target_met', 'target_not_met', 'budget_exhausted']),
    controls: record(phase()),
    predicted_powers: z.array(z.number().nonnegative()),
    maximum_error: z.number().nonnegative(),
    evaluations: z.number().int().min(1).max(512),
    evaluation_trace: z.array(TuningCandidateSchema).min(1).max(512),
    termination_reason: z.string(),
  })
  .meta({ id: 'TuningResult' });
export const PhaseControlSchema = z
  .strictObject({
    phase_rad: z
      .number()
      .min(-4 * Math.PI)
      .max(4 * Math.PI),
    active_length_um: positive().default(100),
  })
  .meta({ id: 'PhaseControl' });
export const PortSchema = z
  .strictObject({
    name,
    domain: z.enum(['optical', 'electrical']).default('optical'),
    direction: z.enum(['input', 'output', 'bidirectional']).default('bidirectional'),
  })
  .meta({ id: 'Port' });
export const ComponentSchema = z
  .strictObject({
    name,
    kind: z.enum(['ideal_coupler', 'waveguide', 'phase_shifter']),
    ports: z.array(PortSchema).min(1),
    length_um: positive().nullable().default(null),
    coupling_ratio: z.number().min(0).max(1).nullable().default(null),
    phase_control: PhaseControlSchema.nullable().default(null),
  })
  .meta({ id: 'Component' });
export const EndpointSchema = z
  .strictObject({ instance: name, port: name })
  .meta({ id: 'Endpoint' });
export const ConnectionSchema = z
  .strictObject({ a: EndpointSchema, b: EndpointSchema })
  .meta({ id: 'Connection' });
export const CircuitSchema = z
  .strictObject({
    instances: z.array(ComponentSchema).min(1),
    connections: z.array(ConnectionSchema),
    ports: record(EndpointSchema),
  })
  .meta({ id: 'Circuit' });
export const ModuleInstanceSchema = z
  .strictObject({ name, definition: name })
  .meta({ id: 'ModuleInstance' });
export const CircuitDefinitionSchema = z
  .strictObject({
    name,
    primitives: z.array(ComponentSchema).max(256),
    modules: z.array(ModuleInstanceSchema).max(256),
    connections: z.array(ConnectionSchema),
    ports: z.record(name, EndpointSchema),
  })
  .meta({ id: 'CircuitDefinition' });
export const CircuitHierarchySchema = z
  .strictObject({
    schema_version: z.literal('1.0').default('1.0'),
    top: name,
    definitions: z.array(CircuitDefinitionSchema).min(1).max(256),
  })
  .meta({ id: 'CircuitHierarchy' });
export const FlattenedCircuitSchema = z
  .strictObject({
    schema_version: z.literal('1.0'),
    top: name,
    circuit: CircuitSchema,
    instance_paths: record(z.array(name).min(1)),
  })
  .meta({ id: 'FlattenedCircuit' });
export const PlacementSchema = z
  .strictObject({
    x_um: z.number().default(0),
    y_um: z.number().default(0),
    rotation_deg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    // With an anchor, (x_um, y_um) offsets this instance's `port` from the anchor port.
    anchor: z.strictObject({ instance: instancePath, port: name }).nullable().default(null),
    port: name.nullable().default(null),
  })
  .meta({ id: 'Placement' });
export const RouteStepSchema = z
  .union([
    z.strictObject({ dx_um: z.number() }),
    z.strictObject({ dy_um: z.number() }),
    z.strictObject({ x_um: z.number() }),
    z.strictObject({ y_um: z.number() }),
    z.strictObject({ x_from_end_um: z.number() }),
    z.strictObject({ y_from_end_um: z.number() }),
  ])
  .meta({ id: 'RouteStep' });
// Without steps, GDSFactory's Manhattan router chooses the path between the two ports.
export const RouteSchema = z
  .strictObject({ steps: z.array(RouteStepSchema).max(16).default([]) })
  .meta({ id: 'Route' });
export const BundleSchema = z
  .strictObject({
    routes: z.array(instancePath).min(2).max(32),
    separation_um: positive().default(5),
  })
  .meta({ id: 'Bundle' });
export const LayoutConstraintSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('length'),
      instance: instancePath,
      value_um: positive(),
      tolerance_um: positive().default(0.001),
    }),
    z.strictObject({
      kind: z.literal('length_difference'),
      a: instancePath,
      b: instancePath,
      value_um: z.number(),
      tolerance_um: positive().default(0.002),
    }),
  ])
  .meta({ id: 'LayoutConstraint' });
export const LayoutPlanSchema = z
  .strictObject({
    placements: z.record(instancePath, PlacementSchema),
    routes: z.record(instancePath, RouteSchema).default({}),
    // Bundled routes are routed together with a common edge-to-edge separation.
    bundles: z.array(BundleSchema).max(16).default([]),
    constraints: z.array(LayoutConstraintSchema).max(64).default([]),
  })
  .meta({ id: 'LayoutPlan' });
export const MeasurementSchema = z
  .strictObject({
    kind: z.literal('resonances'),
    input_port: name,
    output_port: name,
    min_count: z.number().int().min(1).max(64).default(2),
  })
  .meta({ id: 'Measurement' });
export const DesignSpecSchema = z
  .strictObject({
    schema_version: z.literal('3.0').default('3.0'),
    name,
    // A PDK data file in pdks/; its components, models and validity ranges bind the design.
    pdk: pdkName.default('sin_demo_v1'),
    circuit: z.union([CircuitSchema, CircuitHierarchySchema]),
    port_order: z.array(name).min(1).max(64),
    wavelength_nm: z.number().min(1500).max(1600).default(1550),
    sweep_span_nm: z.number().positive().max(100).default(40),
    sweep_points: z.number().int().min(3).max(10001).default(201),
    outputs: z
      .array(z.enum(['netlist', 'simulation', 'gds', 'verification']))
      .min(1)
      .default(['netlist', 'simulation', 'gds', 'verification']),
    layout: LayoutPlanSchema.nullable().default(null),
    tuning: TuningSpecSchema.nullable().default(null),
    measurements: z.array(MeasurementSchema).max(16).default([]),
  })
  .meta({ id: 'DesignSpec' });
const range = () => z.tuple([z.number(), z.number()]);
export const SourceSchema = z
  .strictObject({
    kind: z.enum(['assumption', 'literature', 'characterization', 'measurement', 'foundry']),
    reference: z.string().min(1),
    calibrated: z.boolean(),
    // Repository path of the evidence behind a characterized or measured value.
    evidence: z.string().nullable().default(null),
  })
  .meta({ id: 'Source' });
export const MaterialSchema = z
  .strictObject({
    // n² = 1 + Σ b λ² / (λ² − c²), with λ and c in µm.
    model: z.literal('sellmeier'),
    terms: z
      .array(z.strictObject({ b: z.number(), c_um: z.number().nonnegative() }))
      .min(1)
      .max(6),
    validity_wavelength_um: range(),
    source: SourceSchema,
  })
  .meta({ id: 'Material' });
export const ModeModelSchema = z
  .strictObject({
    reference_wavelength_um: positive(),
    effective_index: positive(),
    group_index: positive(),
    loss_db_per_cm: z.number().nonnegative(),
    source: SourceSchema,
  })
  .meta({ id: 'ModeModel' });
export const CrossSectionSchema = z
  .strictObject({
    layer: name,
    width_um: positive(),
    thickness_um: positive().nullable().default(null),
    core_material: name.nullable().default(null),
    cladding_material: name.nullable().default(null),
    mode: ModeModelSchema.nullable().default(null),
  })
  .meta({ id: 'CrossSection' });
export const PDKComponentSchema = z
  .strictObject({
    // Fixed cells declare local port positions; path-extruded cells have none.
    ports: z
      .array(
        z.strictObject({
          name,
          domain: z.enum(['optical', 'electrical']),
          position_um: z.tuple([z.number(), z.number()]).nullable().default(null),
          orientation_deg: z.number().nullable().default(null),
        }),
      )
      .min(1),
    cell: z.strictObject({
      // A GDSFactory component name, or "extrusion" for a path along the cross-section.
      factory: z.string().min(1),
      cross_section: name,
      settings: record(z.number()).default({}),
      actuator_cross_section: name.nullable().default(null),
    }),
    model: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
    validity: z.strictObject({
      wavelength_um: range(),
      parameters: record(range()).default({}),
    }),
    source: SourceSchema,
  })
  .meta({ id: 'PDKComponent' });
export const PDKSchema = z
  .strictObject({
    schema_version: z.literal('1.0'),
    name: pdkName,
    description: z.string(),
    foundry: z.string().nullable(),
    database_unit_um: positive(),
    layers: z.record(
      name,
      z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    ),
    rules: z.strictObject({
      minimum_width_um: positive(),
      minimum_spacing_um: positive(),
      bend_radius_um: positive(),
    }),
    materials: z.record(name, MaterialSchema),
    cross_sections: z.record(name, CrossSectionSchema),
    components: z.partialRecord(
      z.enum(['ideal_coupler', 'waveguide', 'phase_shifter']),
      PDKComponentSchema,
    ),
  })
  .meta({ id: 'PDK' });
export const TaskSchema = z
  .strictObject({ name, depends_on: z.array(name), backend: z.string() })
  .meta({ id: 'Task' });
export const EngineeringIRSchema = z
  .strictObject({
    schema_version: z.literal('3.0').default('3.0'),
    design_id: z.string().regex(/^[0-9a-f]{16}$/),
    specification: DesignSpecSchema,
    technology: PDKSchema,
    netlist: CircuitSchema,
    hierarchy: CircuitHierarchySchema.nullable().default(null),
    instance_paths: record(z.array(name).min(1)),
    operating_point: record(phase()).nullable().default(null),
    workflow: z.array(TaskSchema),
    layout_resolved: z.boolean().default(false),
    length_source: z.enum(['specification', 'layout']).default('specification'),
    assumptions: z.array(z.string()),
  })
  .meta({ id: 'EngineeringIR' });
export const PhysicalPortSchema = z
  .strictObject({
    center_um: z.tuple([z.number(), z.number()]),
    orientation_deg: z.number(),
    width_um: positive(),
    domain: z.enum(['optical', 'electrical']).default('optical'),
  })
  .meta({ id: 'PhysicalPort' });
export const ActuatorLayoutSchema = z
  .strictObject({
    centerline_um: z.tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])]),
    layer: z.tuple([z.number().int(), z.number().int()]),
    width_um: positive(),
  })
  .meta({ id: 'ActuatorLayout' });
export const LayoutResultSchema = z
  .strictObject({
    schema_version: z.literal('3.0'),
    top_cell: z.string(),
    technology: z.string(),
    core_layer: z.tuple([z.number().int(), z.number().int()]),
    lengths_um: record(positive()),
    centerlines_um: record(z.array(z.tuple([z.number(), z.number()])).min(2)),
    ports: record(record(PhysicalPortSchema)),
    extracted_circuit: CircuitSchema,
    bend_radius_um: positive(),
    actuators: record(ActuatorLayoutSchema).default({}),
    routers: record(z.enum(['steps', 'auto', 'bundle'])).default({}),
  })
  .meta({ id: 'LayoutResult' });
export const SimulationResultSchema = z
  .strictObject({
    schema_version: z.literal('3.0'),
    backend: z.string(),
    model_version: z.string(),
    wavelength_nm: z.array(positive()),
    ports: z.array(z.string()),
    s_real: z.array(z.array(z.array(z.number()))),
    s_imag: z.array(z.array(z.array(z.number()))),
    physical_calibration: z.literal('not_performed'),
  })
  .meta({ id: 'SimulationResult' });
export const CheckResultSchema = z
  .strictObject({
    id: z.string(),
    status: z.enum(['pass', 'fail', 'not_run']),
    detail: z.string(),
    evidence: record(z.unknown()).default({}),
  })
  .meta({ id: 'CheckResult' });
export const VerificationReportSchema = z
  .strictObject({
    schema_version: z.literal('3.0').default('3.0'),
    design_id: z.string(),
    status: z.enum(['passed_with_limitations', 'failed']),
    checks: z.array(CheckResultSchema),
    foundry_signoff: z.literal(false).default(false),
    limitations: z.array(z.string()),
  })
  .meta({ id: 'VerificationReport' });
export const ArtifactSchema = z
  .strictObject({
    name: z.string(),
    sha256: z.string(),
    size_bytes: z.number().int(),
    media_type: z.string(),
  })
  .meta({ id: 'Artifact' });
export const RunResultSchema = z
  .strictObject({
    schema_version: z.literal('3.0').default('3.0'),
    run_id: z.string(),
    design_id: z.string(),
    artifact_directory: z.string(),
    status: z.enum(['completed', 'failed']),
    verification_status: z.enum(['passed_with_limitations', 'failed', 'not_run']),
    artifacts: z.array(ArtifactSchema),
    error: z.string().nullable().default(null),
  })
  .meta({ id: 'RunResult' });
export const ElectromagneticRequestSchema = z
  .strictObject({
    geometry_artifact: z.string(),
    wavelength_nm: z.array(positive()).min(1),
    material_map: record(z.string()),
    ports: z.array(z.string()),
  })
  .meta({ id: 'ElectromagneticRequest' });
export const ElectromagneticResultSchema = z
  .strictObject({
    backend: z.string(),
    model_artifact: z.string(),
    verification_artifact: z.string(),
  })
  .meta({ id: 'ElectromagneticResult' });
export const CircuitSimulationSchema = z
  .strictObject({
    tuning: TuningResultSchema.nullable().default(null),
    ir: EngineeringIRSchema,
    simulation: SimulationResultSchema,
    verification: VerificationReportSchema,
  })
  .meta({ id: 'CircuitSimulation' });
export const Contracts = {
  TuningSpec: TuningSpecSchema,
  TuningCandidate: TuningCandidateSchema,
  TuningResult: TuningResultSchema,
  ResolvedTuningVariable: ResolvedTuningVariableSchema,
  ...PhysicsContracts,
  DesignSpec: DesignSpecSchema,
  PhaseControl: PhaseControlSchema,
  ActuatorLayout: ActuatorLayoutSchema,
  Placement: PlacementSchema,
  RouteStep: RouteStepSchema,
  Route: RouteSchema,
  Bundle: BundleSchema,
  LayoutConstraint: LayoutConstraintSchema,
  LayoutPlan: LayoutPlanSchema,
  Measurement: MeasurementSchema,
  Port: PortSchema,
  Component: ComponentSchema,
  Endpoint: EndpointSchema,
  Connection: ConnectionSchema,
  Circuit: CircuitSchema,
  ModuleInstance: ModuleInstanceSchema,
  CircuitDefinition: CircuitDefinitionSchema,
  CircuitHierarchy: CircuitHierarchySchema,
  FlattenedCircuit: FlattenedCircuitSchema,
  Source: SourceSchema,
  Material: MaterialSchema,
  ModeModel: ModeModelSchema,
  CrossSection: CrossSectionSchema,
  PDKComponent: PDKComponentSchema,
  PDK: PDKSchema,
  Task: TaskSchema,
  EngineeringIR: EngineeringIRSchema,
  PhysicalPort: PhysicalPortSchema,
  LayoutResult: LayoutResultSchema,
  SimulationResult: SimulationResultSchema,
  CheckResult: CheckResultSchema,
  VerificationReport: VerificationReportSchema,
  Artifact: ArtifactSchema,
  RunResult: RunResultSchema,
  CircuitSimulation: CircuitSimulationSchema,
  ElectromagneticRequest: ElectromagneticRequestSchema,
  ElectromagneticResult: ElectromagneticResultSchema,
};
export type DesignSpec = z.infer<typeof DesignSpecSchema>;
export type LayoutPlan = z.infer<typeof LayoutPlanSchema>;
export type PhaseControl = z.infer<typeof PhaseControlSchema>;
export type TuningResult = z.infer<typeof TuningResultSchema>;
export type ResolvedTuningVariable = z.infer<typeof ResolvedTuningVariableSchema>;
export type EngineeringIR = z.infer<typeof EngineeringIRSchema>;
export type PDK = z.infer<typeof PDKSchema>;
export type Circuit = z.infer<typeof CircuitSchema>;
export type CircuitHierarchy = z.infer<typeof CircuitHierarchySchema>;
export type CircuitDefinition = z.infer<typeof CircuitDefinitionSchema>;
export type FlattenedCircuit = z.infer<typeof FlattenedCircuitSchema>;
export type Endpoint = z.infer<typeof EndpointSchema>;
export type LayoutResult = z.infer<typeof LayoutResultSchema>;
export type SimulationResult = z.infer<typeof SimulationResultSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
export type RunResult = z.infer<typeof RunResultSchema>;
