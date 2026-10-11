from fastapi.testclient import TestClient

from agentpic.api import create_app


def test_http_machine_interface_executes_and_downloads_real_gds(tmp_path, example_spec):
    client = TestClient(create_app(tmp_path))
    response = client.post("/v1/designs", json=example_spec)
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "completed", result
    run_id = result["run_id"]
    gds = client.get(f"/v1/runs/{run_id}/artifacts/design.gds")
    assert gds.status_code == 200 and len(gds.content) > 1000
    assert gds.content[:4] == b"\x00\x06\x00\x02"
    assert client.get(f"/v1/runs/{run_id}").json() == result
    report = client.post(f"/v1/runs/{run_id}/verify").json()
    assert report["status"] == "passed_with_limitations"
    assert not report["foundry_signoff"]
    assert client.get(f"/v1/runs/{run_id}/artifacts/unknown").status_code == 404


def test_http_validation_schema_and_discovery(tmp_path):
    client = TestClient(create_app(tmp_path))
    assert client.post("/v1/designs", json={"device": "nanobeam"}).status_code == 422
    assert client.post("/v1/compile", json={}).json()["layout_resolved"] is False
    assert client.get("/v1/capabilities").json()["electromagnetic"]["fdtdx"] == "not_implemented"
    assert "DesignSpec" in client.get("/openapi.json").json()["components"]["schemas"]
    assert client.get("/v1/runs/unknown").status_code == 404
