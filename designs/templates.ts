/**
 * Design generators. Device knowledge lives here and in tests, never in the engine:
 * core/src and src/agentpic only see the generic circuit, layout plan and measurements
 * these functions emit. `npm run generate:designs` writes the JSON files in this folder.
 */
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import type { DesignSpecSchema, PhaseControl } from '../core/src/contracts.js';

export type DesignInput = z.input<typeof DesignSpecSchema>;
type Tuning = NonNullable<DesignInput['tuning']>;
type Layout = NonNullable<DesignInput['layout']>;
type Control = PhaseControl | null;
interface Sweep {
  wavelength_nm?: number;
  sweep_span_nm?: number;
  sweep_points?: number;
}

const optical = (...names: string[]) => names.map((name) => ({ name }));
const electrical = (...names: string[]) => names.map((name) => ({ name, domain: 'electrical' }));
const endpoint = (instance: string, port: string) => ({ instance, port });
const edge = (a: string, ap: string, b: string, bp: string) => ({
  a: endpoint(a, ap),
  b: endpoint(b, bp),
});
const at = (prefix: string, name: string) => (prefix ? `${prefix}/${name}` : name);
// Cell geometry comes from the PDK data, so these designs follow its declared ports.
const pdk = JSON.parse(readFileSync(new URL('../pdks/sin_demo_v1.json', import.meta.url), 'utf8'));
const mmiPort = (port: string): [number, number] =>
  pdk.components.ideal_coupler.ports.find((p: { name: string }) => p.name === port).position_um;
// Rotating a coupler by 180° and shifting it by o4.x + o1.x puts its o1 under the original o4.
const MMI_FLIP_SHIFT_UM = mmiPort('o4')[0] + mmiPort('o1')[0];
const MMI_LANE_PITCH_UM = mmiPort('o2')[1] - mmiPort('o1')[1];
const BEND_RADIUS_UM: number = pdk.rules.bend_radius_um;

/** Two ideal 50:50 couplers and two arms; `delta` lengthens the top (positive) or bottom arm. */
export function mziCircuit(delta: number, control: Control = null) {
  return {
    instances: [
      ...['splitter', 'combiner'].map((name) => ({
        name,
        kind: 'ideal_coupler' as const,
        ports: optical('o1', 'o2', 'o3', 'o4'),
        coupling_ratio: 0.5,
      })),
      {
        name: 'top_arm',
        kind: control ? ('phase_shifter' as const) : ('waveguide' as const),
        ports: [...optical('o1', 'o2'), ...(control ? electrical('e1', 'e2') : [])],
        length_um: 800 + Math.max(delta, 0),
        phase_control: control,
      },
      {
        name: 'bottom_arm',
        kind: 'waveguide' as const,
        ports: optical('o1', 'o2'),
        length_um: 800 + Math.max(-delta, 0),
      },
    ],
    connections: [
      edge('splitter', 'o3', 'top_arm', 'o1'),
      edge('top_arm', 'o2', 'combiner', 'o2'),
      edge('splitter', 'o4', 'bottom_arm', 'o1'),
      edge('bottom_arm', 'o2', 'combiner', 'o1'),
    ],
    ports: {
      in0: endpoint('splitter', 'o1'),
      in1: endpoint('splitter', 'o2'),
      out0: endpoint('combiner', 'o4'),
      out1: endpoint('combiner', 'o3'),
      ...(control
        ? { phase_e1: endpoint('top_arm', 'e1'), phase_e2: endpoint('top_arm', 'e2') }
        : {}),
    },
  };
}

/** Couplers 650 µm apart; each arm rises (or falls) so the arms differ by `delta`. */
function mziLayout(prefix: string, delta: number, splitter: Layout['placements'][string]) {
  const arm = (sign: number, extra: number) => ({
    steps: [{ dx_um: 100 }, { dy_um: sign * (150 + extra / 2) }, { x_from_end_um: -100 }],
  });
  return {
    placements: {
      [at(prefix, 'splitter')]: splitter,
      [at(prefix, 'combiner')]: {
        anchor: { instance: at(prefix, 'splitter'), port: 'o1' },
        port: 'o1',
        x_um: 650,
      },
    },
    routes: {
      [at(prefix, 'top_arm')]: arm(1, Math.max(delta, 0)),
      [at(prefix, 'bottom_arm')]: arm(-1, Math.max(-delta, 0)),
    },
    constraints: [
      {
        kind: 'length_difference' as const,
        a: at(prefix, 'top_arm'),
        b: at(prefix, 'bottom_arm'),
        value_um: delta,
      },
    ],
  };
}

export function mzi(
  options: Sweep & {
    name?: string;
    delta_length_um?: number;
    phase_control?: Control;
    tuning?: Tuning | null;
  } = {},
): DesignInput {
  const {
    name = 'mzi',
    delta_length_um: delta = 10,
    phase_control = null,
    tuning = null,
  } = options;
  return {
    name,
    ...sweep(options),
    circuit: mziCircuit(delta, phase_control),
    port_order: ['in0', 'in1', 'out0', 'out1'],
    layout: mziLayout('', delta, { x_um: 0, y_um: 0 }),
    tuning,
  };
}

export interface Stage {
  name: string;
  delta_length_um: number;
  phase_control?: Control;
}
/**
 * MZI stages in series; both outputs of a stage feed the next stage. Without an offset the
 * links are straight and equally long. With `stage_offset_um` each stage sits that far above
 * the previous one and the two links are auto-routed together as a bundle, so their lengths
 * come from the router rather than the design.
 */
export function cascade(
  options: Sweep & {
    name?: string;
    stages: Stage[];
    link_length_um?: number;
    stage_offset_um?: number;
    tuning?: Tuning | null;
  },
): DesignInput {
  const {
    name = 'mzi_cascade',
    stages,
    link_length_um: link = 100,
    stage_offset_um: offset = 0,
    tuning = null,
  } = options;
  const links = stages.slice(1).flatMap((stage, i) =>
    [0, 1].map((port) => ({
      name: `interconnect_${i}_${port}`,
      from: stages[i].name,
      to: stage.name,
      port,
    })),
  );
  const layout: Layout = { placements: {}, routes: {}, bundles: [], constraints: [] };
  stages.forEach((stage, i) => {
    const block = mziLayout(
      stage.name,
      stage.delta_length_um,
      i === 0
        ? { x_um: 0, y_um: 0 }
        : {
            anchor: { instance: `${stages[i - 1].name}/combiner`, port: 'o4' },
            port: 'o1',
            x_um: link,
            y_um: offset,
          },
    );
    Object.assign(layout.placements, block.placements);
    Object.assign(layout.routes!, block.routes);
    layout.constraints!.push(...block.constraints);
  });
  for (const l of links) {
    layout.routes![l.name] = { steps: [] };
    if (!offset) layout.constraints!.push({ kind: 'length', instance: l.name, value_um: link });
  }
  if (offset)
    for (let i = 0; i < stages.length - 1; i++)
      layout.bundles!.push({ routes: [0, 1].map((port) => `interconnect_${i}_${port}`) });
  return {
    name,
    ...sweep(options),
    circuit: {
      top: 'assembly',
      definitions: [
        ...stages.map((stage) => {
          const circuit = mziCircuit(stage.delta_length_um, stage.phase_control ?? null);
          return {
            name: `stage_${stage.name}`,
            primitives: circuit.instances,
            modules: [],
            connections: circuit.connections,
            ports: circuit.ports,
          };
        }),
        {
          name: 'assembly',
          primitives: links.map((l) => ({
            name: l.name,
            kind: 'waveguide' as const,
            ports: optical('o1', 'o2'),
            length_um: link,
          })),
          modules: stages.map((stage) => ({ name: stage.name, definition: `stage_${stage.name}` })),
          connections: links.flatMap((l) => [
            edge(l.from, `out${l.port}`, l.name, 'o1'),
            edge(l.name, 'o2', l.to, `in${l.port}`),
          ]),
          ports: {
            in0: endpoint(stages[0].name, 'in0'),
            in1: endpoint(stages[0].name, 'in1'),
            out0: endpoint(stages.at(-1)!.name, 'out0'),
            out1: endpoint(stages.at(-1)!.name, 'out1'),
            ...Object.fromEntries(
              stages.flatMap((stage) =>
                stage.phase_control
                  ? ['e1', 'e2'].map((port) => [
                      `${stage.name}_phase_${port}`,
                      endpoint(stage.name, `phase_${port}`),
                    ])
                  : [],
              ),
            ),
          },
        },
      ],
    },
    port_order: ['in0', 'in1', 'out0', 'out1'],
    layout,
    tuning,
  };
}

/**
 * MMI-coupled add/drop feedback ring. Coupler centres are `loop_height_um` apart and the two
 * return paths extend `side_extension_um` beyond the couplers; for excitation at in0, out0 is
 * the through port and out1 the drop port.
 */
export function ring(
  options: Sweep & {
    name?: string;
    loop_height_um?: number;
    side_extension_um?: number;
    coupling_ratios?: [number, number];
    phase_control?: Control;
    tuning?: Tuning | null;
  } = {},
): DesignInput {
  const {
    name = 'ring',
    loop_height_um: height = 300,
    side_extension_um: extension = 200,
    coupling_ratios = [0.5, 0.5],
    phase_control: control = null,
    tuning = null,
  } = options;
  // Two quarter circles replace four radius-length straight sections on each return path.
  const length = height - MMI_LANE_PITCH_UM + 2 * extension + (Math.PI - 4) * BEND_RADIUS_UM;
  return {
    name,
    ...sweep({ sweep_span_nm: 4, sweep_points: 1001, ...options }),
    circuit: {
      instances: [
        ...['top_coupler', 'bottom_coupler'].map((name, i) => ({
          name,
          kind: 'ideal_coupler' as const,
          ports: optical('o1', 'o2', 'o3', 'o4'),
          coupling_ratio: coupling_ratios[i],
        })),
        {
          name: 'right_return',
          kind: control ? ('phase_shifter' as const) : ('waveguide' as const),
          ports: [...optical('o1', 'o2'), ...(control ? electrical('e1', 'e2') : [])],
          length_um: length,
          phase_control: control,
        },
        { name: 'left_return', kind: 'waveguide', ports: optical('o1', 'o2'), length_um: length },
      ],
      connections: [
        edge('top_coupler', 'o4', 'right_return', 'o1'),
        edge('right_return', 'o2', 'bottom_coupler', 'o1'),
        edge('bottom_coupler', 'o4', 'left_return', 'o1'),
        edge('left_return', 'o2', 'top_coupler', 'o1'),
      ],
      ports: {
        in0: endpoint('top_coupler', 'o2'),
        in1: endpoint('bottom_coupler', 'o2'),
        out0: endpoint('top_coupler', 'o3'),
        out1: endpoint('bottom_coupler', 'o3'),
        ...(control
          ? { phase_e1: endpoint('right_return', 'e1'), phase_e2: endpoint('right_return', 'e2') }
          : {}),
      },
    },
    port_order: ['in0', 'in1', 'out0', 'out1'],
    layout: {
      placements: {
        top_coupler: { x_um: 0, y_um: height },
        bottom_coupler: { x_um: MMI_FLIP_SHIFT_UM, y_um: 0, rotation_deg: 180 },
      },
      routes: {
        right_return: { steps: [{ dx_um: extension }] },
        left_return: { steps: [{ dx_um: -extension }] },
      },
      constraints: [
        { kind: 'length_difference', a: 'right_return', b: 'left_return', value_um: 0 },
      ],
    },
    tuning,
    measurements: [{ kind: 'resonances', input_port: 'in0', output_port: 'out1', min_count: 2 }],
  };
}

function sweep(options: Sweep) {
  return {
    wavelength_nm: options.wavelength_nm ?? 1550,
    sweep_span_nm: options.sweep_span_nm ?? 40,
    sweep_points: options.sweep_points ?? 201,
  };
}

const fullTurn = 2 * Math.PI;
/** Every checked-in design file, keyed by file name without extension. */
export const designs: Record<string, DesignInput> = {
  mzi: mzi(),
  mzi_tunable: mzi({
    name: 'mzi_tunable',
    delta_length_um: 0,
    phase_control: { phase_rad: Math.PI, active_length_um: 100 },
  }),
  mzi_target: mzi({
    name: 'mzi_target',
    delta_length_um: 0,
    phase_control: { phase_rad: 0, active_length_um: 100 },
    tuning: {
      targets: [{ input_port: 'in0', output_port: 'out0', wavelength_nm: 1550, power: 0.8 }],
      variables: [{ instance_path: ['top_arm'], min_phase_rad: 0, max_phase_rad: fullTurn }],
    },
  }),
  mzi_cascade: cascade({
    stages: [
      { name: 'first', delta_length_um: 10 },
      { name: 'second', delta_length_um: 20 },
    ],
  }),
  mzi_cascade_tunable: cascade({
    name: 'mzi_cascade_tunable',
    stages: [
      {
        name: 'first',
        delta_length_um: 0,
        phase_control: { phase_rad: Math.PI / 2, active_length_um: 100 },
      },
      {
        name: 'second',
        delta_length_um: 0,
        phase_control: { phase_rad: Math.PI, active_length_um: 150 },
      },
    ],
  }),
  mzi_cascade_target: cascade({
    name: 'mzi_cascade_target',
    stages: [
      { name: 'first', delta_length_um: 0, phase_control: { phase_rad: 0, active_length_um: 100 } },
      {
        name: 'second',
        delta_length_um: 0,
        phase_control: { phase_rad: 0, active_length_um: 150 },
      },
    ],
    tuning: {
      targets: [
        { input_port: 'in0', output_port: 'out0', wavelength_nm: 1550, power: 0.8 },
        { input_port: 'in0', output_port: 'out1', wavelength_nm: 1550, power: 0.2 },
        { input_port: 'in1', output_port: 'out1', wavelength_nm: 1540, power: 0.7975860169790084 },
      ],
      variables: [
        { instance_path: ['first', 'top_arm'], min_phase_rad: 0, max_phase_rad: fullTurn },
        { instance_path: ['second', 'top_arm'], min_phase_rad: 0, max_phase_rad: fullTurn },
      ],
    },
  }),
  ring: ring(),
  ring_target: ring({
    name: 'ring_target',
    phase_control: { phase_rad: 0, active_length_um: 100 },
    tuning: {
      targets: [
        { input_port: 'in0', output_port: 'out1', wavelength_nm: 1550, power: 1 },
        { input_port: 'in0', output_port: 'out0', wavelength_nm: 1550, power: 0 },
      ],
      variables: [{ instance_path: ['right_return'], min_phase_rad: 0, max_phase_rad: fullTurn }],
    },
  }),
  waveguide_chain: {
    name: 'waveguide_chain',
    circuit: {
      instances: [
        { name: 'first', kind: 'waveguide', length_um: 11.25, ports: optical('o1', 'o2') },
        { name: 'second', kind: 'waveguide', length_um: 35.5, ports: optical('o1', 'o2') },
        { name: 'third', kind: 'waveguide', length_um: 80, ports: optical('o1', 'o2') },
      ],
      connections: [edge('first', 'o2', 'second', 'o1'), edge('second', 'o2', 'third', 'o1')],
      ports: { LaunchB: endpoint('first', 'o1'), ReceiveA: endpoint('third', 'o2') },
    },
    port_order: ['ReceiveA', 'LaunchB'],
    // The outer straights are placed; the router finds the middle waveguide's S-shaped path,
    // so its nominal 35.5 µm is replaced by the measured length after layout.
    layout: {
      placements: { first: { x_um: 0, y_um: 0 }, third: { x_um: 300, y_um: 150 } },
      routes: { second: {} },
    },
  },
  mzi_cascade_offset: cascade({
    name: 'mzi_cascade_offset',
    stages: [
      { name: 'first', delta_length_um: 10 },
      { name: 'second', delta_length_um: 20 },
    ],
    link_length_um: 300,
    stage_offset_um: 300,
  }),
  coupler: {
    name: 'coupler',
    circuit: {
      instances: [
        {
          name: 'splitter',
          kind: 'ideal_coupler',
          coupling_ratio: 0.27,
          ports: optical('o1', 'o2', 'o3', 'o4'),
        },
      ],
      connections: [],
      ports: {
        west: endpoint('splitter', 'o1'),
        north: endpoint('splitter', 'o2'),
        drop: endpoint('splitter', 'o3'),
        through: endpoint('splitter', 'o4'),
      },
    },
    port_order: ['drop', 'west', 'through', 'north'],
    outputs: ['netlist', 'simulation', 'verification'],
  },
};
