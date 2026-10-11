from agentpic.runtime import provenance


def test_provenance_works_without_git(monkeypatch):
    def no_git(*args, **kwargs):
        raise FileNotFoundError("git is not installed")

    monkeypatch.setattr("agentpic.runtime.subprocess.run", no_git)
    result = provenance()
    assert result["git_commit"] is None
    assert result["git_dirty"] is None
    assert len(result["source_sha256"]) == 64
