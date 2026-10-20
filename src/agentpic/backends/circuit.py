"""SAX circuit adapter with explicit ideal compact-model assumptions."""

import numpy as np

from agentpic.ir import EngineeringIR
from agentpic.pdk import component, optical_section

# Compact models this backend implements, keyed by PDK model name, with their versions.
IMPLEMENTED = {
    "ideal_coupler": "ideal_coupler_v1",
    "waveguide": "ideal_sin_waveguide_v1",
    "phase_shifter": "ideal_phase_shifter_v1",
}


def model_versions(ir: EngineeringIR) -> str:
    """Check every used PDK model is implemented here and name the combination."""
    used = {}
    for kind in sorted({i.kind for i in ir.netlist.instances}):
        model = component(ir, kind).model
        if IMPLEMENTED.get(model.name) != model.version:
            raise ValueError(f"SAX backend does not implement {model.name} {model.version}")
        used[model.name] = model.version
    return "+".join(used.values())


class SAXBackend:
    name = "sax"

    def simulate(self, ir: EngineeringIR) -> dict:
        return simulate(ir)


def build_circuit(ir: EngineeringIR):
    """Build once; callers may override per-instance phase settings for each evaluation."""
    if any(i.length_um is None for i in ir.netlist.instances if i.kind != "ideal_coupler"):
        raise ValueError("waveguide lengths must be resolved before circuit simulation")
    import jax

    jax.config.update("jax_enable_x64", True)
    import jax.numpy as jnp
    import sax

    def ideal_coupler(wl=1.55, coupling=0.5):
        through = jnp.sqrt(1 - coupling) * jnp.ones_like(jnp.asarray(wl))
        cross = 1j * jnp.sqrt(coupling) * jnp.ones_like(jnp.asarray(wl))
        return sax.reciprocal(
            {("o1", "o4"): through, ("o2", "o3"): through, ("o1", "o3"): cross, ("o2", "o4"): cross}
        )

    def waveguide(wl=1.55, length_um=1.0, neff=1.8, ng=1.9, wl0=1.55, loss=0.0):
        wl = jnp.asarray(wl)
        index = neff + (neff - ng) * (wl - wl0) / wl0
        amplitude = 10 ** (-loss * length_um / 1e4 / 20)
        propagation = amplitude * jnp.exp(2j * jnp.pi * index * length_um / wl)
        return sax.reciprocal({("o1", "o2"): propagation})

    def phase_shifter(wl=1.55, length_um=1.0, neff=1.8, ng=1.9, wl0=1.55, loss=0.0, phase_rad=0.0):
        passive = waveguide(wl, length_um, neff, ng, wl0, loss)
        # Commanded optical path change; no electrical-to-phase calibration is implied.
        tuning = jnp.exp(1j * phase_rad * wl0 / jnp.asarray(wl))
        return {ports: value * tuning for ports, value in passive.items()}

    model_versions(ir)
    instances = {}
    for instance in ir.netlist.instances:
        if instance.kind == "ideal_coupler":
            settings = {"coupling": instance.coupling_ratio}
        else:
            mode = optical_section(ir, instance.kind).mode
            settings = {
                "length_um": instance.length_um,
                "neff": mode.effective_index,
                "ng": mode.group_index,
                "wl0": mode.reference_wavelength_um,
                "loss": mode.loss_db_per_cm,
            }
            if instance.kind == "phase_shifter":
                settings["phase_rad"] = instance.phase_control.phase_rad
        model = component(ir, instance.kind).model.name
        instances[instance.name] = {"component": model, "settings": settings}
    domains = {(i.name, p.name): p.domain for i in ir.netlist.instances for p in i.ports}
    netlist = {
        "instances": instances,
        "connections": {
            f"{edge.a.instance},{edge.a.port}": f"{edge.b.instance},{edge.b.port}"
            for edge in ir.netlist.connections
            if domains[(edge.a.instance, edge.a.port)] == "optical"
        },
        "ports": {
            name: f"{endpoint.instance},{endpoint.port}"
            for name, endpoint in ir.netlist.ports.items()
            if domains[(endpoint.instance, endpoint.port)] == "optical"
        },
    }
    model, _ = sax.circuit(
        netlist=netlist,
        models={
            "ideal_coupler": ideal_coupler,
            "waveguide": waveguide,
            "phase_shifter": phase_shifter,
        },
    )
    return model, list(ir.specification.port_order)


def simulate(ir: EngineeringIR) -> dict:
    model, ports = build_circuit(ir)
    spec = ir.specification
    wavelengths = np.linspace(
        spec.wavelength_nm - spec.sweep_span_nm / 2,
        spec.wavelength_nm + spec.sweep_span_nm / 2,
        spec.sweep_points,
    )
    scattering = model(wl=wavelengths / 1000)
    matrix = np.zeros((len(wavelengths), len(ports), len(ports)), dtype=complex)
    for (output_port, input_port), value in scattering.items():
        matrix[:, ports.index(output_port), ports.index(input_port)] = np.asarray(value)
    return {
        "schema_version": "3.0",
        "backend": "sax",
        "model_version": model_versions(ir),
        "wavelength_nm": wavelengths.tolist(),
        "ports": ports,
        "s_real": matrix.real.tolist(),
        "s_imag": matrix.imag.tolist(),
        "physical_calibration": "not_performed",
    }
