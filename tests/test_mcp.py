import base64
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def test_real_mcp_stdio_design_and_binary_artifact(tmp_path, example_spec):
    server = StdioServerParameters(
        command=sys.executable,
        args=["-m", "agentpic.cli", "mcp", "--runs-dir", str(tmp_path)],
    )
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert {"design_pic", "compile_pic", "verify_run", "get_capabilities"} <= {
                tool.name for tool in tools.tools
            }
            result = await session.call_tool("design_pic", {"specification": example_spec})
            assert not result.isError, result
            data = result.structuredContent
            assert data["status"] == "completed", data
            verification = await session.call_tool("verify_run", {"run_id": data["run_id"]})
            assert verification.structuredContent["status"] == "passed_with_limitations"
            resource = await session.read_resource(f"agentpic://runs/{data['run_id']}/design.gds")
            assert base64.b64decode(resource.contents[0].blob)[:4] == b"\x00\x06\x00\x02"
            invalid = await session.call_tool("design_pic", {"specification": {"platform": "bad"}})
            assert invalid.isError
