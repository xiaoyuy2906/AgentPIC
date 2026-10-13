import { z } from 'zod';
const dict = <T extends z.ZodType>(schema: T) => z.record(z.string(), schema);
export const LengthSchema = z
  .strictObject({
    value: z.number(),
    unit: z.enum(['nm', 'um', 'm']),
    dimension: z.literal('length').default('length'),
  })
  .meta({ id: 'Length' });
export const PhysicalModelSchema = z
  .strictObject({
    kind: z.string(),
    materials: dict(z.strictObject({ refractive_index: z.number() })),
    layers: z.array(z.strictObject({ material: z.string(), thickness: LengthSchema })).min(1),
    background_material: z.string(),
    assumptions: z.strictObject({
      linear: z.boolean(),
      lossless: z.boolean(),
      isotropic: z.boolean(),
      nonmagnetic: z.boolean(),
      propagation_invariant: z.boolean(),
    }),
  })
  .meta({ id: 'PhysicalModel' });
export const HypothesisCauseSchema = z.enum([
  'discretization_error',
  'boundary_truncation',
  'non_reproducibility',
  'reference_disagreement',
  'input_error',
]);
export const ReasoningProposalSchema = z
  .strictObject({
    source: z.literal('external_llm'),
    claim: z.string(),
    cause: HypothesisCauseSchema,
    rationale: z.string(),
  })
  .meta({ id: 'ReasoningProposal' });
export const EngineeringGoalSchema = z
  .strictObject({
    schema_version: z.literal('1.0').default('1.0'),
    goal: z.string().min(1),
    capability_id: z.string(),
    model: PhysicalModelSchema,
    wavelength: LengthSchema,
    polarization: z.enum(['TE', 'TM']),
    numerical: z.strictObject({
      grid_step: LengthSchema,
      padding: LengthSchema,
      max_points: z.number().int().min(64).max(20000).default(12000),
    }),
    experiment_budget: z.number().int().min(1).max(12).default(8),
    reasoning_proposals: z.array(ReasoningProposalSchema).default([]),
  })
  .meta({ id: 'EngineeringGoal' });
export const PhysicsConfigurationSchema = z
  .strictObject({
    model_kind: z.string(),
    wavelength_um: z.number().positive(),
    polarization: z.enum(['TE', 'TM']),
    layers: z
      .array(
        z.strictObject({
          thickness_um: z.number().positive(),
          refractive_index: z.number().positive(),
        }),
      )
      .min(1),
    background_index: z.number().positive(),
    grid_step_um: z.number().positive(),
    padding_um: z.number().positive(),
    max_points: z.number().int().positive(),
  })
  .meta({ id: 'PhysicsConfiguration' });
export const PhysicalResultSchema = z
  .strictObject({
    backend: z.string(),
    method: z.string(),
    effective_index: z.number(),
    beta_per_um: z.number(),
    units: z.strictObject({
      effective_index: z.literal('1'),
      beta_per_um: z.literal('um^-1'),
      coordinates: z.literal('um'),
      field: z.literal('arbitrary_normalized'),
    }),
    x_um: z.array(z.number()),
    field_amplitude: z.array(z.number()),
    diagnostics: z.strictObject({
      grid_points: z.number().int(),
      actual_grid_step_um: z.number(),
      relative_residual: z.number(),
      edge_amplitude_ratio: z.number(),
      elapsed_seconds: z.number().nonnegative(),
      estimated_array_bytes: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'PhysicalResult' });
export const CriterionSchema = z
  .strictObject({
    id: z.string(),
    observable: z.string(),
    comparison: z.enum(['lt', 'lte', 'gte', 'range']),
    thresholds: z.array(z.number()),
    unit: z.string(),
    rationale: z.string(),
  })
  .meta({ id: 'Criterion' });
export const ExperimentSchema = z
  .strictObject({
    id: z.string(),
    operation: z.string(),
    purpose: z.string(),
    hypothesis_ids: z.array(z.string()),
    configuration: PhysicsConfigurationSchema,
    criteria: z.array(CriterionSchema),
  })
  .meta({ id: 'Experiment' });
export const ConstraintEvaluationSchema = z
  .strictObject({
    criterion_id: z.string(),
    status: z.enum(['pass', 'fail', 'not_evaluated']),
    value: z.number().nullable(),
    evidence_ids: z.array(z.string()),
    detail: z.string(),
  })
  .meta({ id: 'ConstraintEvaluation' });
export const ExperimentEvidenceSchema = z
  .strictObject({
    experiment: ExperimentSchema,
    configuration_sha256: z.string(),
    result: PhysicalResultSchema.nullable(),
    checks: z.array(ConstraintEvaluationSchema),
    error: z.string().nullable(),
  })
  .meta({ id: 'ExperimentEvidence' });
export const HypothesisSchema = z
  .strictObject({
    id: z.string(),
    source: z.enum(['deterministic_physics', 'external_llm']),
    statement: z.string(),
    cause: HypothesisCauseSchema,
    status: z.enum(['supported', 'contradicted', 'inconclusive']),
    evidence_ids: z.array(z.string()),
    explanation: z.string(),
  })
  .meta({ id: 'Hypothesis' });
export const PhysicsDiagnosticSchema = z
  .strictObject({
    code: z.string(),
    message: z.string(),
    possible_cause: z.string(),
    suggested_action: z.string(),
  })
  .meta({ id: 'PhysicsDiagnostic' });
export const DevelopmentRequestSchema = z
  .strictObject({
    capability_id: z.string(),
    status: z.literal('requires_implementation'),
    technical_specification: z.string(),
    library_candidates: z.array(z.strictObject({ name: z.string(), url: z.string() })),
    tasks: z.array(
      z.strictObject({ id: z.string(), depends_on: z.array(z.string()), description: z.string() }),
    ),
    promotion_gate: z.string(),
  })
  .meta({ id: 'DevelopmentRequest' });
export const PhysicsReportSchema = z
  .strictObject({
    schema_version: z.literal('1.0'),
    run_id: z.string(),
    goal_sha256: z.string(),
    status: z.enum(['accepted', 'improved', 'rejected', 'inconclusive', 'invalid', 'unsupported']),
    artifact_directory: z.string(),
    criteria: z.array(CriterionSchema),
    diagnostics: z.array(PhysicsDiagnosticSchema),
    evidence: z.array(ExperimentEvidenceSchema),
    hypotheses: z.array(HypothesisSchema),
    checks: z.array(ConstraintEvaluationSchema),
    baseline_verified: z.boolean(),
    accepted_configuration: PhysicsConfigurationSchema.nullable(),
    development_request: DevelopmentRequestSchema.nullable(),
    reasoning: z.array(
      z.strictObject({
        kind: z.enum([
          'physical_principle',
          'llm_proposal',
          'numerical_evidence',
          'deterministic_verification',
          'engineering_judgment',
        ]),
        statement: z.string(),
        evidence_ids: z.array(z.string()),
      }),
    ),
    provenance: dict(z.unknown()),
    resource_usage: z.strictObject({
      experiments_executed: z.number().int(),
      wall_seconds: z.number(),
      solver_seconds: z.number(),
      maximum_grid_points: z.number().int(),
      peak_estimated_array_bytes: z.number().int(),
    }),
    limitations: z.array(z.string()),
    foundry_signoff: z.literal(false),
  })
  .meta({ id: 'PhysicsReport' });
export const CapabilityRegistrySchema = z
  .strictObject({
    capabilities: z.array(
      z.strictObject({
        id: z.string(),
        description: z.string(),
        status: z.literal('implemented'),
        verification: z.literal('requires_evidence_for_each_run'),
        criteria: z.array(CriterionSchema),
        limitations: z.array(z.string()),
      }),
    ),
  })
  .meta({ id: 'CapabilityRegistry' });
export const PhysicsContracts = {
  CapabilityRegistry: CapabilityRegistrySchema,
  Length: LengthSchema,
  PhysicalModel: PhysicalModelSchema,
  ReasoningProposal: ReasoningProposalSchema,
  EngineeringGoal: EngineeringGoalSchema,
  PhysicsConfiguration: PhysicsConfigurationSchema,
  PhysicalResult: PhysicalResultSchema,
  Criterion: CriterionSchema,
  Experiment: ExperimentSchema,
  ConstraintEvaluation: ConstraintEvaluationSchema,
  ExperimentEvidence: ExperimentEvidenceSchema,
  Hypothesis: HypothesisSchema,
  PhysicsDiagnostic: PhysicsDiagnosticSchema,
  DevelopmentRequest: DevelopmentRequestSchema,
  PhysicsReport: PhysicsReportSchema,
};
export type EngineeringGoal = z.infer<typeof EngineeringGoalSchema>;
export type PhysicsConfiguration = z.infer<typeof PhysicsConfigurationSchema>;
export type PhysicalResult = z.infer<typeof PhysicalResultSchema>;
export type Experiment = z.infer<typeof ExperimentSchema>;
export type Evidence = z.infer<typeof ExperimentEvidenceSchema>;
export type Criterion = z.infer<typeof CriterionSchema>;
export type Evaluation = z.infer<typeof ConstraintEvaluationSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type Diagnostic = z.infer<typeof PhysicsDiagnosticSchema>;
export type PhysicsReport = z.infer<typeof PhysicsReportSchema>;
