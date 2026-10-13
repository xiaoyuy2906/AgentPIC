import type {
  EngineeringGoal,
  PhysicsConfiguration,
  Experiment,
  Evidence,
  Criterion,
  Evaluation,
  Hypothesis,
  Diagnostic,
  PhysicsReport,
} from './contracts.js';
import { planarTE } from '../capabilities/planar-te.js';
export interface PhysicsCapability {
  id: string;
  description: string;
  limitations: string[];
  compile(goal: EngineeringGoal): {
    configuration: PhysicsConfiguration | null;
    diagnostics: Diagnostic[];
  };
  criteria: Criterion[];
  plan(configuration: PhysicsConfiguration): Experiment[];
  selectNext(
    goal: EngineeringGoal,
    evidence: Evidence[],
    candidates: Experiment[],
  ): { experiment: Experiment; reason: string } | null;
  checkExperiment(experiment: Experiment, result: NonNullable<Evidence['result']>): Evaluation[];
  assess(
    goal: EngineeringGoal,
    evidence: Evidence[],
  ): Pick<
    PhysicsReport,
    | 'status'
    | 'baseline_verified'
    | 'accepted_configuration'
    | 'checks'
    | 'hypotheses'
    | 'reasoning'
  >;
}
export const physicsCapabilities = new Map<string, PhysicsCapability>([[planarTE.id, planarTE]]);
export function capabilityRegistry() {
  return [...physicsCapabilities.values()].map((c) => ({
    id: c.id,
    description: c.description,
    status: 'implemented',
    verification: 'requires_evidence_for_each_run',
    criteria: c.criteria,
    limitations: c.limitations,
  }));
}
export function developmentRequest(capabilityID: string) {
  return {
    capability_id: capabilityID,
    status: 'requires_implementation' as const,
    technical_specification: `Implement ${capabilityID} behind PhysicsCapability and the JSON scientific-adapter boundary. Define units, valid assumptions, input/output schemas, independent references, resource bounds and predeclared numerical criteria.`,
    library_candidates: [
      { name: 'SciPy numerical algorithms', url: 'https://docs.scipy.org/doc/scipy/' },
      { name: 'FDTDX electromagnetic backend', url: 'https://github.com/ymahlau/fdtdx' },
    ],
    tasks: [
      {
        id: 'research',
        depends_on: [],
        description:
          'Determine whether an existing maintained scientific library provides the capability; record sources and limitations.',
      },
      {
        id: 'contract',
        depends_on: ['research'],
        description:
          'Extend Zod definitions, generate JSON Schema/Pydantic and define acceptance criteria before implementation.',
      },
      {
        id: 'adapter',
        depends_on: ['contract'],
        description:
          'Implement a replaceable adapter using the selected library; do not duplicate a mature solver.',
      },
      {
        id: 'tests',
        depends_on: ['adapter'],
        description: 'Develop valid/invalid/unit/error tests and independent numerical benchmarks.',
      },
      {
        id: 'debug',
        depends_on: ['tests'],
        description:
          'Run benchmarks, diagnose failures and repair implementation without weakening thresholds.',
      },
      {
        id: 'register',
        depends_on: ['debug'],
        description:
          'Register the capability only with reproducible passing evidence, documentation and recorded limitations.',
      },
    ],
    promotion_gate:
      'A declared implementation or LLM explanation is not verification. Registration requires executable adapter code and independently reproducible benchmark artifacts; unimplemented capabilities cannot execute.',
  };
}
