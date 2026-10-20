/** PDK data files in pdks/ hold every process fact; the engine hard-codes none of them. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.js';
import { canonical } from './json.js';
import { projectRoot } from './paths.js';
import { PDKSchema, type CheckResult, type EngineeringIR, type PDK } from './contracts.js';

const directory = () => path.join(projectRoot, 'pdks');
export const listPDKs = () =>
  readdirSync(directory())
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
export function loadPDK(name: string): PDK {
  const pdk = PDKSchema.parse(
    JSON.parse(readFileSync(path.join(directory(), `${name}.json`), 'utf8')),
  );
  if (pdk.name !== name) throw new Error(`pdks/${name}.json declares PDK ${pdk.name}`);
  return pdk;
}
type Kind = keyof PDK['components'];
/** The mode model of the cross-section a component kind is drawn with. */
export const componentMode = (pdk: PDK, kind: Kind) => {
  const component = pdk.components[kind];
  return component ? (pdk.cross_sections[component.cell.cross_section]?.mode ?? null) : null;
};
/** Every PDK source that is not calibrated, as "where: reference". */
export function uncalibratedSources(pdk: PDK) {
  return [
    ...Object.entries(pdk.materials).map(([n, m]) => [`material ${n}`, m.source] as const),
    ...Object.entries(pdk.cross_sections).flatMap(([n, x]) =>
      x.mode ? [[`cross-section ${n} mode`, x.mode.source] as const] : [],
    ),
    ...Object.entries(pdk.components).map(([n, c]) => [`component ${n}`, c!.source] as const),
  ]
    .filter(([, source]) => !source.calibrated)
    .map(([where, source]) => `${pdk.name} ${where} (${source.kind}): ${source.reference}`);
}

const inside = (value: number, [low, high]: [number, number]) => value >= low && value <= high;

/** Instances, geometry and sweep must agree with the PDK declarations and validity ranges. */
export function pdkChecks(ir: EngineeringIR): CheckResult[] {
  const pdk = ir.technology;
  const spec = ir.specification;
  const models: string[] = [];
  const validity: string[] = [];
  const geometry: string[] = [];
  const sweep: [number, number] = [
    (spec.wavelength_nm - spec.sweep_span_nm / 2) / 1000,
    (spec.wavelength_nm + spec.sweep_span_nm / 2) / 1000,
  ];
  for (const i of ir.netlist.instances) {
    const component = pdk.components[i.kind];
    if (!component) {
      models.push(`${i.name}: ${pdk.name} has no ${i.kind}`);
      continue;
    }
    const declared = component.ports.map((p) => `${p.name}:${p.domain}`).sort();
    if (canonical(i.ports.map((p) => `${p.name}:${p.domain}`).sort()) !== canonical(declared))
      models.push(`${i.name}: ports must be ${declared.join(', ')}`);
    // Parameters each primitive model needs; their allowed values come from the PDK below.
    const shape =
      i.kind === 'ideal_coupler'
        ? i.coupling_ratio !== null && i.length_um === null && i.phase_control === null
        : i.length_um !== null &&
          i.coupling_ratio === null &&
          (i.phase_control !== null) === (i.kind === 'phase_shifter');
    if (!shape) models.push(`${i.name}: parameters do not match the ${i.kind} model`);
    const values: Record<string, number | null | undefined> = {
      coupling_ratio: i.coupling_ratio,
      length_um: i.length_um,
      phase_rad: i.phase_control?.phase_rad,
      active_length_um: i.phase_control?.active_length_um,
    };
    for (const [parameter, bounds] of Object.entries(component.validity.parameters)) {
      const value = values[parameter];
      if (typeof value === 'number' && !inside(value, bounds))
        validity.push(`${i.name}.${parameter}=${value} outside [${bounds.join(', ')}]`);
    }
    if (
      !inside(sweep[0], component.validity.wavelength_um) ||
      !inside(sweep[1], component.validity.wavelength_um)
    )
      validity.push(
        `${i.kind} is valid for ${component.validity.wavelength_um.join('–')} µm, not the ${sweep.join('–')} µm sweep`,
      );
  }
  const phase = pdk.components.phase_shifter?.validity.parameters.phase_rad;
  for (const v of spec.tuning?.variables ?? [])
    if (phase && !(inside(v.min_phase_rad, phase) && inside(v.max_phase_rad, phase)))
      validity.push(`tuning bounds of ${v.instance_path.join('/')} exceed the phase validity`);
  for (const [name, x] of Object.entries(pdk.cross_sections)) {
    if (!pdk.layers[x.layer]) geometry.push(`cross-section ${name} uses unknown layer ${x.layer}`);
    if (x.width_um < pdk.rules.minimum_width_um)
      geometry.push(`cross-section ${name} is narrower than the minimum width`);
    for (const material of [x.core_material, x.cladding_material])
      if (material && !pdk.materials[material])
        geometry.push(`cross-section ${name} uses unknown material ${material}`);
  }
  for (const [kind, component] of Object.entries(pdk.components)) {
    const optical = pdk.cross_sections[component!.cell.cross_section];
    if (!optical)
      geometry.push(`${kind} uses unknown cross-section ${component!.cell.cross_section}`);
    else if (kind !== 'ideal_coupler' && !optical.mode)
      geometry.push(`${kind} cross-section ${component!.cell.cross_section} has no mode model`);
    const actuator = component!.cell.actuator_cross_section;
    if ((kind === 'phase_shifter') !== (actuator !== null))
      geometry.push(`${kind} must declare an actuator cross-section exactly when it has one`);
    else if (actuator && pdk.cross_sections[actuator]?.layer === optical?.layer)
      geometry.push(`${kind} actuator shares the optical layer`);
  }
  return [
    check(
      'component_models',
      models.length === 0,
      'Every instance kind exists in the PDK with its declared ports and the parameters its model needs.',
      { problems: models },
    ),
    check(
      'model_validity',
      validity.length === 0,
      'Sweep, instance parameters and tuning bounds lie inside each PDK model validity range.',
      { problems: validity },
    ),
    check(
      'pdk_geometry',
      geometry.length === 0,
      'PDK cross-sections, layers, materials and minimum widths are internally consistent.',
      { problems: geometry },
    ),
  ];
}
