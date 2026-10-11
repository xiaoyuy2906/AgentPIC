"""Headless command-line entry points with JSON output."""

import argparse
import json
import sys
from pathlib import Path

from pydantic import ValidationError

from agentpic.backends import capabilities
from agentpic.ir import DesignSpec, EngineeringIR
from agentpic.runtime import Runtime


def main() -> None:
    parser = argparse.ArgumentParser(prog="agentpic", description="Agent-native PIC EDA")
    commands = parser.add_subparsers(dest="command", required=True)
    design = commands.add_parser("design", help="Execute an engineering specification")
    design.add_argument("specification", type=Path)
    design.add_argument("--runs-dir", default=None)
    verify = commands.add_parser("verify", help="Independently reverify a saved run")
    verify.add_argument("run_id")
    verify.add_argument("--runs-dir", default=None)
    schema = commands.add_parser("schema", help="Print a machine-readable JSON Schema")
    schema.add_argument("--kind", choices=["specification", "ir"], default="specification")
    commands.add_parser("capabilities")
    server = commands.add_parser("serve", help="Serve the HTTP/OpenAPI interface")
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=int, default=8000)
    server.add_argument("--runs-dir", default=None)
    mcp = commands.add_parser("mcp", help="Serve MCP over stdio")
    mcp.add_argument("--runs-dir", default=None)
    args = parser.parse_args()
    try:
        if args.command == "design":
            spec = DesignSpec.model_validate_json(args.specification.read_text())
            result = Runtime(args.runs_dir).run(spec)
            print(result.model_dump_json(indent=2))
            if result.status != "completed":
                raise SystemExit(1)
        elif args.command == "verify":
            result = Runtime(args.runs_dir).verify_run(args.run_id)
            print(result.model_dump_json(indent=2))
            if result.status == "failed":
                raise SystemExit(1)
        elif args.command == "schema":
            model = DesignSpec if args.kind == "specification" else EngineeringIR
            print(json.dumps(model.model_json_schema(), indent=2))
        elif args.command == "capabilities":
            print(json.dumps(capabilities(), indent=2))
        elif args.command == "serve":
            import uvicorn

            from agentpic.api import create_app

            uvicorn.run(create_app(args.runs_dir), host=args.host, port=args.port)
        elif args.command == "mcp":
            from agentpic.mcp_server import create_server

            create_server(args.runs_dir).run(transport="stdio")
    except (ValidationError, ValueError, OSError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
