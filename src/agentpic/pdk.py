"""Read process facts from the PDK data carried in the Engineering IR."""

from agentpic.ir import EngineeringIR


def component(ir: EngineeringIR, kind: str):
    return ir.technology.components[kind]


def optical_section(ir: EngineeringIR, kind: str = "waveguide"):
    """The cross-section a component kind is drawn and modelled with."""
    return ir.technology.cross_sections[component(ir, kind).cell.cross_section]


def actuator_section(ir: EngineeringIR):
    return ir.technology.cross_sections[component(ir, "phase_shifter").cell.actuator_cross_section]


def layer(ir: EngineeringIR, section) -> tuple[int, int]:
    return tuple(ir.technology.layers[section.layer])
