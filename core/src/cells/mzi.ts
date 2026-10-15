import { CircuitSchema, type Circuit, type PhaseControl } from '../contracts.js';

export function mziCircuit(deltaLength: number, phaseControl: PhaseControl | null = null): Circuit {
  const ports = (names: string[]) =>
    names.map((name) => ({ name, domain: 'optical', direction: 'bidirectional' }));
  const endpoint = (instance: string, port: string) => ({ instance, port });
  const connection = (a: string, ap: string, b: string, bp: string) => ({
    a: endpoint(a, ap),
    b: endpoint(b, bp),
  });
  return CircuitSchema.parse({
    instances: [
      ...['splitter', 'combiner'].map((name) => ({
        name,
        kind: 'ideal_coupler',
        ports: ports(['o1', 'o2', 'o3', 'o4']),
        coupling_ratio: 0.5,
      })),
      {
        name: 'top_arm',
        kind: phaseControl ? 'phase_shifter' : 'waveguide',
        ports: [
          ...ports(['o1', 'o2']),
          ...(phaseControl
            ? ['e1', 'e2'].map((name) => ({
                name,
                domain: 'electrical',
                direction: 'bidirectional',
              }))
            : []),
        ],
        length_um: 800 + Math.max(deltaLength, 0),
        phase_control: phaseControl,
      },
      {
        name: 'bottom_arm',
        kind: 'waveguide',
        ports: ports(['o1', 'o2']),
        length_um: 800 + Math.max(-deltaLength, 0),
      },
    ],
    connections: [
      connection('splitter', 'o3', 'top_arm', 'o1'),
      connection('top_arm', 'o2', 'combiner', 'o2'),
      connection('splitter', 'o4', 'bottom_arm', 'o1'),
      connection('bottom_arm', 'o2', 'combiner', 'o1'),
    ],
    ports: {
      in0: endpoint('splitter', 'o1'),
      in1: endpoint('splitter', 'o2'),
      out0: endpoint('combiner', 'o4'),
      out1: endpoint('combiner', 'o3'),
      ...(phaseControl
        ? { phase_e1: endpoint('top_arm', 'e1'), phase_e2: endpoint('top_arm', 'e2') }
        : {}),
    },
  });
}
