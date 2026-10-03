# Agent-hooks policy presets

Named, ready-made `opensesame hooks policy` documents (ADR 0159). Each file is
`{ "preset": 1, "name": <file stem>, "summary": …, "policy": <HookPolicy> }`;
`policy` is exactly what `PUT /api/v1/agent-hooks/policy` takes.

This directory is the single source (ADR 0139). The `opensesame` CLI embeds it
(`hooks policy preset ls|show`, `hooks policy put --preset`), the gateway
serves it (`GET /api/v1/agent-hooks/presets`), and each has a drift test that
fails when a file here is missing from the embedded table or the other way
round. Add a preset by adding a file here and a row to both tables.

| Preset | What it is for |
|--------|----------------|
| `rotation-web-login` | Hosted web-login rotation and capture runs: the eleven verbs of the tool boundary, page reads labelled, credential flow refused |
| `strict` | Deny everything unnamed; deny credential-shaped content |
| `observe` | Allow everything; redact credential shapes; keep the audit |
