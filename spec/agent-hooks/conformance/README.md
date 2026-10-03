# Agent Hooks 0.1 conformance vectors (vendored)

The language-neutral Conformance Test Kit (CTK) corpus of
[Agent Hooks 0.1](https://github.com/responsibleai/agent-hooks/blob/v0.1.0-alpha.5/spec/AGENT-HOOKS-0.1.md),
copied byte for byte from upstream so OpenSesame's host adapter
(`crates/rotation-web`, `src/hooks/`) runs the exact corpus the pinned runner
understands. The published `agent-hooks-sdk` crate ships the runner (`ctk`
feature) but not the vectors, so they live here.

| | |
|---|---|
| Source | <https://github.com/responsibleai/agent-hooks> |
| Tag | `v0.1.0-alpha.5` (annotated tag object `2e3d5ede7718f68fce5e0fe5eba61146d52aa54d`) |
| Commit | `61952932e52d5dab091a64677f19272daae619f8` |
| Matches | `agent-hooks-sdk = "=0.1.0-alpha.5"` — the tag's `sdk/rust/core/src` is identical to the crates.io source |
| License | MIT, Copyright (c) Microsoft Corporation — [`LICENSE`](LICENSE), kept beside the files it covers |

## What is here

| Path | Upstream path | Read by |
|---|---|---|
| `vectors/AH-CTK-*.json` (47) | `conformance/vectors/` | `crates/rotation-web/tests/agent_hooks_ctk.rs` (the rotation host, as it is) and `tests/agent_hooks_ctk_mock_loop.rs` (the emission engine through a mock-agent loop), each through `agent_hooks::ctk::run_vector`; `tests/ctk_tool_seam.rs` replays the tool-seam `interceptor_script`s (not part of either claim) |
| `vectors.schema.json` | `conformance/vectors.schema.json` | reference only — the vectors' JSON Schema |
| `golden/identity.json` | `conformance/golden/identity.json` | `agent_hooks_ctk.rs`'s identity test, against `agent_hooks::context_identity` (§10.2 applies because the declared provider is `jcs-sha256`) |

Nothing here is edited. A vector that fails is fixed in the adapter, never
here, and never filtered out of the run. The declared surface, the observed
per-part report and the limits of what a pass means are in
[`docs/validation/agent-hooks-conformance.md`](../../../docs/validation/agent-hooks-conformance.md).

## Re-pin

Move this directory and the exact `agent-hooks-sdk` pin (in
`crates/rotation-web/Cargo.toml` and `crates/agent-hooks/Cargo.toml`) together,
then update the tag and SHAs above:

```bash
T=v0.1.0-alpha.N; D=$(mktemp -d) && git clone -q --branch "$T" https://github.com/responsibleai/agent-hooks "$D" && rm -rf spec/agent-hooks/conformance/{vectors,golden,vectors.schema.json} && cp -r "$D"/conformance/{vectors,golden,vectors.schema.json} spec/agent-hooks/conformance/ && cp "$D"/LICENSE spec/agent-hooks/conformance/LICENSE
```
