/** Sole editable contract source. Python models are generated from its JSON Schema. */
import { z } from 'zod';
import { PhysicsContracts } from './physics/contracts.js';
const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const positive = () => z.number().positive();
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
    active_length_um: z.number().min(20).max(200).default(100),
  })
  .meta({ id: 'PhaseControl' });
const DesignFields = {
  tuning: TuningSpecSchema.nullable().default(null),
  platform: z.literal('sin').default('sin'),
  wavelength_nm: z.number().min(1500).max(1600).default(1550),
  outputs: z
    .array(z.enum(['netlist', 'simulation', 'gds', 'verification']))
    .min(1)
    .default(['netlist', 'simulation', 'gds', 'verification']),
  sweep_span_nm: z.number().positive().max(100).default(40),
  sweep_points: z.number().int().min(3).max(2001).default(201),
};
export const MZISpecSchema = z
  .strictObject({
    ...DesignFields,
    device: z.literal('mzi').default('mzi'),
    delta_length_um: z.number().min(-200).max(200).default(10),
    phase_control: PhaseControlSchema.nullable().default(null),
  })
  .meta({ id: 'MZISpec' });
export const CascadeStageSchema = z
  .strictObject({
    name,
    delta_length_um: z.number().min(-200).max(200),
    phase_control: PhaseControlSchema.nullable().default(null),
  })
  .meta({ id: 'CascadeStage' });
export const CascadeSpecSchema = z
  .strictObject({
    ...DesignFields,
    device: z.literal('mzi_cascade'),
    stages: z.array(CascadeStageSchema).min(2).max(4),
    link_length_um: z.number().min(10).max(1000).default(100),
  })
  .meta({ id: 'CascadeSpec' });
export const RingSpecSchema = z
  .strictObject({
    ...DesignFields,
    device: z.literal('ring_add_drop'),
    loop_height_um: z.number().min(200).max(600).default(300),
    side_extension_um: z.number().min(150).max(500).default(200),
    coupling_ratios: z
      .tuple([z.number().min(0.05).max(0.8), z.number().min(0.05).max(0.8)])
      .default([0.5, 0.5]),
    phase_control: PhaseControlSchema.nullable().default(null),
    sweep_span_nm: z.number().positive().max(100).default(4),
    sweep_points: z.number().int().min(3).max(10001).default(1001),
  })
  .meta({ id: 'RingSpec' });
export const DesignSpecSchema = z
  .union([MZISpecSchema, CascadeSpecSchema, RingSpecSchema])
  .meta({ id: 'DesignSpec' });
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
export const PDKSchema = z
  .strictObject({
    name: z.literal('sin_demo_v1').default('sin_demo_v1'),
    foundry: z.null().default(null),
    calibrated: z.literal(false).default(false),
    core_layer: z
      .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      .default([1, 0]),
    width_um: positive().default(1),
    thickness_um: positive().default(0.4),
    bend_radius_um: positive().default(50),
    minimum_width_um: positive().default(0.5),
    minimum_spacing_um: positive().default(0.5),
    heater_layer: z
      .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      .default([2, 0]),
    heater_width_um: positive().default(2.5),
    reference_wavelength_um: positive().default(1.55),
    effective_index: positive().default(1.8),
    group_index: positive().default(1.9),
    loss_db_per_cm: z.literal(0).default(0),
    model_version: z.literal('ideal_sin_v1').default('ideal_sin_v1'),
    supported_components: z
      .array(z.enum(['ideal_coupler', 'waveguide', 'phase_shifter']))
      .default(['ideal_coupler', 'waveguide', 'phase_shifter']),
  })
  .meta({ id: 'PDK' });
export const TaskSchema = z
  .strictObject({ name, depends_on: z.array(name), backend: z.string() })
  .meta({ id: 'Task' });
export const LayoutBlockSchema = z
  .strictObject({
    name,
    cell: z.literal('mzi'),
    primitives: z.record(name, name),
    delta_length_um: z.number().min(-200).max(200),
  })
  .meta({ id: 'LayoutBlock' });
export const AssemblyPlanSchema = z
  .strictObject({
    arrangement: z.literal('series'),
    blocks: z.array(LayoutBlockSchema).min(2).max(4),
    link_length_um: positive(),
    links: z.array(z.strictObject({ instance: name, a: EndpointSchema, b: EndpointSchema })),
  })
  .meta({ id: 'AssemblyPlan' });
export const EngineeringIRSchema = z
  .strictObject({
    schema_version: z.literal('2.0').default('2.0'),
    design_id: z.string().regex(/^[0-9a-f]{16}$/),
    specification: DesignSpecSchema,
    technology: PDKSchema,
    netlist: CircuitSchema,
    hierarchy: CircuitHierarchySchema.nullable().default(null),
    instance_paths: record(z.array(name).min(1)).default({}),
    assembly: AssemblyPlanSchema.nullable().default(null),
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
    schema_version: z.literal('2.0'),
    top_cell: z.string(),
    technology: z.string(),
    core_layer: z.tuple([z.number().int(), z.number().int()]),
    lengths_um: record(positive()),
    centerlines_um: record(z.array(z.tuple([z.number(), z.number()])).min(2)),
    ports: record(record(PhysicalPortSchema)),
    extracted_circuit: CircuitSchema,
    bend_radius_um: positive(),
    delta_length_um: z.number().nullable(),
    path_imbalances_um: record(z.number()).default({}),
    actuators: record(ActuatorLayoutSchema).default({}),
  })
  .meta({ id: 'LayoutResult' });
export const SimulationResultSchema = z
  .strictObject({
    schema_version: z.literal('2.0'),
    backend: z.string(),
    model_version: z.string(),
    wavelength_nm: z.array(positive()),
    ports: z.array(z.string()),
    s_real: z.array(z.array(z.array(z.number()))),
    s_imag: z.array(z.array(z.array(z.number()))),
    input_port: z.string(),
    transmission_out0: z.array(z.number()),
    transmission_out1: z.array(z.number()),
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
    schema_version: z.literal('2.0').default('2.0'),
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
    schema_version: z.literal('2.0').default('2.0'),
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
  MZISpec: MZISpecSchema,
  CascadeSpec: CascadeSpecSchema,
  RingSpec: RingSpecSchema,
  CascadeStage: CascadeStageSchema,
  LayoutBlock: LayoutBlockSchema,
  AssemblyPlan: AssemblyPlanSchema,
  Port: PortSchema,
  Component: ComponentSchema,
  Endpoint: EndpointSchema,
  Connection: ConnectionSchema,
  Circuit: CircuitSchema,
  ModuleInstance: ModuleInstanceSchema,
  CircuitDefinition: CircuitDefinitionSchema,
  CircuitHierarchy: CircuitHierarchySchema,
  FlattenedCircuit: FlattenedCircuitSchema,
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
export type PhaseControl = z.infer<typeof PhaseControlSchema>;
export type TuningResult = z.infer<typeof TuningResultSchema>;
export type ResolvedTuningVariable = z.infer<typeof ResolvedTuningVariableSchema>;
export type RingSpec = z.infer<typeof RingSpecSchema>;
export type CascadeSpec = z.infer<typeof CascadeSpecSchema>;
export type AssemblyPlan = z.infer<typeof AssemblyPlanSchema>;
export type EngineeringIR = z.infer<typeof EngineeringIRSchema>;
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
