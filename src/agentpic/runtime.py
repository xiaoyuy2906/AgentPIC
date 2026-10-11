"""Persistent local workflow execution, independent of the calling agent."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import platform
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from graphlib import TopologicalSorter
from importlib.metadata import version
from pathlib import Path

from agentpic.backends import CircuitBackend, LayoutBackend
from agentpic.compiler import backannotate, compile_design
from agentpic.ir import Artifact, DesignSpec, RunResult, VerificationReport
from agentpic.verification import verify_artifacts

_ENGINE_LOCK = threading.RLock()
_RUN_ID = re.compile(r"[0-9a-f]{16}-[0-9a-f]{12}\Z")


def write_json(path: Path, data: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, sort_keys=True, allow_nan=False) + "\n")
    temporary.replace(path)


def provenance() -> dict:
    project = Path(__file__).resolve().parents[2]
    source_hash = hashlib.sha256()
    for path in sorted(Path(__file__).parent.rglob("*.py")):
        source_hash.update(str(path.relative_to(Path(__file__).parent)).encode())
        source_hash.update(path.read_bytes())
    lock = project / "uv.lock"
    git_commit = None
    git_dirty = None
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=project, capture_output=True, text=True, check=False
        )
        if commit.returncode == 0:
            git_commit = commit.stdout.strip()
            state = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=project,
                capture_output=True,
                text=True,
                check=False,
            )
            git_dirty = bool(state.stdout.strip()) if state.returncode == 0 else None
    except OSError:
        pass  # Installed wheels can run without a Git executable or source checkout.
    return {
        "python": platform.python_version(),
        "system": platform.system(),
        "architecture": platform.machine(),
        "packages": {
            name: version(name)
            for name in (
                "agentpic",
                "sax",
                "gdsfactory",
                "jax",
                "jaxlib",
                "klayout",
                "numpy",
                "pydantic",
                "mcp",
            )
        },
        "source_sha256": source_hash.hexdigest(),
        "uv_lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else None,
        "git_commit": git_commit,
        "git_dirty": git_dirty,
    }


def _write_spectrum(directory: Path, simulation: dict) -> None:
    with (directory / "spectrum.csv").open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["wavelength_nm", "transmission_out0", "transmission_out1"])
        writer.writerows(
            zip(
                simulation["wavelength_nm"],
                simulation["transmission_out0"],
                simulation["transmission_out1"],
                strict=True,
            )
        )


def _write_preview(directory: Path, metadata: dict) -> None:
    """Static vector preview derived from exported GDS, without a GUI."""
    import klayout.db as kdb

    layout = kdb.Layout()
    layout.read(str(directory / "design.gds"))
    top = layout.top_cell()
    region = kdb.Region(top.begin_shapes_rec(layout.find_layer(*metadata["core_layer"])))
    bbox = region.bbox()
    x, y = bbox.left * layout.dbu - 10, -bbox.top * layout.dbu - 10
    width, height = bbox.width() * layout.dbu + 20, bbox.height() * layout.dbu + 20
    elements = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x} {y} {width} {height}">',
        f'<rect x="{x}" y="{y}" width="{width}" height="{height}" fill="#f8fafc"/>',
        '<g fill="#2563eb" fill-rule="evenodd">',
    ]
    for polygon in region.each():
        rings = [list(polygon.each_point_hull())] + [
            list(polygon.each_point_hole(i)) for i in range(polygon.holes())
        ]
        commands = []
        for ring in rings:
            commands.append(
                "M "
                + " L ".join(f"{p.x * layout.dbu:.3f},{-p.y * layout.dbu:.3f}" for p in ring)
                + " Z"
            )
        elements.append(f'<path d="{" ".join(commands)}"/>')
    elements.extend(["</g>", "</svg>"])
    (directory / "layout.svg").write_text("\n".join(elements))


class Runtime:
    def __init__(
        self,
        runs_dir: str | Path | None = None,
        *,
        layout_backend: LayoutBackend | None = None,
        circuit_backend: CircuitBackend | None = None,
    ):
        from agentpic.backends.circuit import SAXBackend
        from agentpic.backends.layout import GDSFactoryBackend

        self.runs_dir = Path(runs_dir or os.environ.get("AGENTPIC_RUNS_DIR", "runs")).resolve()
        self.layout_backend = layout_backend or GDSFactoryBackend()
        self.circuit_backend = circuit_backend or SAXBackend()

    def run(self, specification: DesignSpec | dict) -> RunResult:
        spec = DesignSpec.model_validate(specification)
        ir = compile_design(spec)
        run_id = f"{ir.design_id}-{uuid.uuid4().hex[:12]}"
        directory = self.runs_dir / run_id
        directory.mkdir(parents=True)
        tasks = {task.name: {**task.model_dump(), "state": "pending"} for task in ir.workflow}
        order = list(
            TopologicalSorter({task.name: task.depends_on for task in ir.workflow}).static_order()
        )
        context: dict = {"ir": ir}
        error = None
        started = datetime.now(timezone.utc).isoformat()

        def event(task: str, state: str, **details) -> None:
            tasks[task].update(state=state, **details)
            write_json(directory / "workflow.json", {"tasks": list(tasks.values())})
            with (directory / "events.jsonl").open("a") as stream:
                stream.write(
                    json.dumps(
                        {
                            "task": task,
                            "state": state,
                            "time": datetime.now(timezone.utc).isoformat(),
                            **details,
                        },
                        allow_nan=False,
                    )
                    + "\n"
                )

        def compile_step() -> None:
            write_json(directory / "specification.json", spec.model_dump(mode="json"))
            write_json(directory / "compiled_ir.json", ir.model_dump(mode="json"))

        def layout_step() -> None:
            context["layout"] = self.layout_backend.build(context["ir"], directory)
            write_json(directory / "layout.json", context["layout"])
            _write_preview(directory, context["layout"])

        def annotate_step() -> None:
            context["ir"] = backannotate(context["ir"], context["layout"]["lengths_um"])
            write_json(directory / "engineering_ir.json", context["ir"].model_dump(mode="json"))
            write_json(directory / "netlist.json", context["ir"].netlist.model_dump(mode="json"))

        def simulate_step() -> None:
            result = self.circuit_backend.simulate(context["ir"])
            write_json(directory / "simulation.json", result)
            _write_spectrum(directory, result)

        def verify_step() -> None:
            context["verification"] = verify_artifacts(directory)
            write_json(directory / "verification.json", context["verification"].model_dump())

        def manifest_step() -> None:
            write_json(directory / "provenance.json", provenance())

        handlers = {
            "compile": compile_step,
            "layout": layout_step,
            "backannotate": annotate_step,
            "simulate": simulate_step,
            "verify": verify_step,
            "manifest": manifest_step,
        }
        # GDSFactory maintains global cell/PDK caches; serialize their use across API requests.
        with _ENGINE_LOCK:
            for index, task in enumerate(order):
                tick = time.perf_counter()
                event(task, "running")
                try:
                    handlers[task]()
                except Exception as exc:
                    error = f"{type(exc).__name__}: {exc}"
                    event(task, "failed", error=error)
                    for blocked in order[index + 1 :]:
                        event(blocked, "blocked", reason=f"Upstream task {task} failed")
                    break
                event(task, "completed", elapsed_seconds=round(time.perf_counter() - tick, 6))

        report = context.get("verification")
        verification_status = report.status if report else "not_run"
        status = (
            "completed"
            if error is None and verification_status == "passed_with_limitations"
            else "failed"
        )
        artifacts = []
        media = {
            ".json": "application/json",
            ".jsonl": "application/x-ndjson",
            ".csv": "text/csv",
            ".gds": "application/octet-stream",
            ".svg": "image/svg+xml",
        }
        for path in sorted(directory.iterdir()):
            if path.is_file():
                artifacts.append(
                    Artifact(
                        name=path.name,
                        sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                        size_bytes=path.stat().st_size,
                        media_type=media.get(path.suffix, "text/plain"),
                    )
                )
        result = RunResult(
            run_id=run_id,
            design_id=ir.design_id,
            artifact_directory=str(directory),
            status=status,
            verification_status=verification_status,
            artifacts=artifacts,
            error=error,
        )
        write_json(
            directory / "manifest.json",
            {
                "schema_version": "1.0",
                "run_id": run_id,
                "design_id": ir.design_id,
                "started_at": started,
                "status": status,
                "requested_outputs": spec.outputs,
                "artifacts": [a.model_dump() for a in artifacts],
                "foundry_signoff": False,
            },
        )
        write_json(directory / "run.json", result.model_dump())
        return result

    def run_directory(self, run_id: str) -> Path:
        if not _RUN_ID.fullmatch(run_id):
            raise FileNotFoundError("Unknown run")
        directory = self.runs_dir / run_id
        if directory.is_symlink() or not (directory / "run.json").is_file():
            raise FileNotFoundError("Unknown run")
        return directory

    def get_run(self, run_id: str) -> RunResult:
        return RunResult.model_validate_json((self.run_directory(run_id) / "run.json").read_text())

    def artifact_path(self, run_id: str, name: str) -> Path:
        directory = self.run_directory(run_id)
        allowed = {a.name for a in self.get_run(run_id).artifacts} | {"manifest.json", "run.json"}
        path = directory / name
        if (
            name not in allowed
            or Path(name).name != name
            or not path.is_file()
            or path.resolve().parent != directory.resolve()
        ):
            raise FileNotFoundError("Unknown artifact")
        return path

    def verify_run(self, run_id: str) -> VerificationReport:
        result = self.get_run(run_id)
        return verify_artifacts(self.run_directory(run_id), result.artifacts)
