# Milestone 1 progress

Goal: machine-interface-driven SiN MZI design → simulation → layout → verification → GDS.

| Task | Depends on | State |
|---|---|---|
| Research SAX/GDSFactory and define IR | — | Implemented; sources in research.md and generated contracts in schemas/ |
| Implement compiler and local runtime | IR | Implemented; dependency execution, persistent state, failure evidence |
| Integrate physical layout and length backannotation | compiler | Verified with real GDSFactory geometry and GDS readback |
| Integrate SAX and independent compact-model checks | backannotation | Verified against independent complex analytic MZI |
| API + MCP contracts and executions | runtime | Verified through HTTP and real MCP stdio integration tests |
| Test, execute acceptance case, CI and documentation | all implementations | 31 local tests pass; real HTTP/MCP acceptance passes; hosted CI publication in progress |
| Create and publish GitHub AgentPIC repository | GitHub CLI authentication | Public repository created; initial code publication in progress |

The initial FDTD-first work was superseded by the user's explicit PIC EDA milestone. uv environment management is retained. No FDTD simulation or Nanobeam work is included in milestone 1.

## Acceptance evidence

`scripts/acceptance.py` is the repeatable acceptance procedure. It submits the unmodified milestone JSON through both real transports, downloads GDS, repeats independent verification, and compares core output hashes. GitHub Actions preserves the resulting evidence for each Python version. Local `runs/` and development `work/` directories are intentionally untracked.

Local acceptance on macOS arm64 / Python 3.13.5 produced matching HTTP/MCP artifacts for design `6abdcca29ad17e43`: physical arm lengths 814.157 and 804.157 µm; powers at 1550 nm of 0.8793790613461524 and 0.12062093865384789; 19 passing checks including integrity and three explicitly unperformed checks. The generated GDS SHA-256 is `e46b85250aa54be06e61c32675c9f244fcb35d27f76d05ccdd8d22e73b9ac11c`. These are demonstration-model results.

## Deferred work and dependencies

| Work | Prerequisite |
|---|---|
| EM-calibrated compact models | Defined material stack, validated solver adapter, convergence and reference tests |
| FDTDX / FEM / EME / mode solver | Extend the reserved EM contract with numerical and material specifications |
| More devices / arbitrary circuits | Extend topology compiler, layout adapters and independent verification policies |
| Foundry PDK integration | Appropriate PDK access, licensed model/rule data and supported signoff execution |
| Optimization and autonomous design exploration | Objective/constraint IR, calibrated models and reproducible study runtime |
| Distributed execution and resume | Durable task scheduling, interruption recovery and cancellation semantics |
