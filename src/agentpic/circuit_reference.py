"""Verification-only dense network elimination, independent of SAX and its models.

For b = S a, connected internal ports obey a_i = P b_i. Eliminating
internal waves gives S_ee + S_ei (I - P S_ii)^-1 P S_ie.
This reference checks ideal sampled responses, not electromagnetic calibration
or adequate sampling of every possible resonant network.
"""

import numpy as np

from agentpic.ir import EngineeringIR


def circuit_reference(ir: EngineeringIR, wavelengths: np.ndarray) -> np.ndarray:
    ports = [
        (instance.name, port.name)
        for instance in ir.netlist.instances
        for port in instance.ports
        if port.domain == "optical"
    ]
    indices = {port: index for index, port in enumerate(ports)}
    matrix = np.zeros((len(wavelengths), len(ports), len(ports)), dtype=complex)
    tech = ir.technology
    wl = wavelengths / 1000
    index = tech.effective_index + (tech.effective_index - tech.group_index) * (
        wl / tech.reference_wavelength_um - 1
    )
    for instance in ir.netlist.instances:
        if instance.kind == "ideal_coupler":
            through, cross = (
                np.sqrt(1 - instance.coupling_ratio),
                1j * np.sqrt(instance.coupling_ratio),
            )
            pairs = [
                ("o1", "o4", through),
                ("o2", "o3", through),
                ("o1", "o3", cross),
                ("o2", "o4", cross),
            ]
        else:
            phase = (
                instance.phase_control.phase_rad * tech.reference_wavelength_um / wl
                if instance.phase_control is not None
                else 0
            )
            propagation = np.exp(1j * (2 * np.pi * index * instance.length_um / wl + phase))
            pairs = [("o1", "o2", propagation)]
        for left, right, value in pairs:
            a, b = indices[(instance.name, left)], indices[(instance.name, right)]
            matrix[:, a, b] = matrix[:, b, a] = value
    external = [
        indices[(ir.netlist.ports[name].instance, ir.netlist.ports[name].port)]
        for name in ir.specification.port_order
    ]
    internal = [i for i in range(len(ports)) if i not in external]
    see = matrix[:, external][:, :, external]
    if not internal:
        return see
    internal_indices = {ports[index]: local for local, index in enumerate(internal)}
    permutation = np.zeros((len(internal), len(internal)))
    for edge in ir.netlist.connections:
        left, right = (edge.a.instance, edge.a.port), (edge.b.instance, edge.b.port)
        if left not in indices:  # Electrical connections are outside this optical reference.
            continue
        a, b = internal_indices[left], internal_indices[right]
        permutation[a, b] = permutation[b, a] = 1
    sii = matrix[:, internal][:, :, internal]
    sie = matrix[:, internal][:, :, external]
    sei = matrix[:, external][:, :, internal]
    internal_waves = np.linalg.solve(np.eye(len(internal)) - permutation @ sii, permutation @ sie)
    return see + sei @ internal_waves
