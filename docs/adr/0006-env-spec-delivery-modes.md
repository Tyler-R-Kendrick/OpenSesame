# ADR 0006: @env-spec developer contract and credential delivery modes

## Status
Accepted

Amended by: [ADR 0150](0150-surrogate-credentials-at-the-last-hop.md) (the
"MITM proxy is non-goal" line becomes §6.1 there, a per-run surrogate proxy).

Amended 2026-10-13 (decision 2): the Node bridge is started with a `node` found
only among absolute, existing `PATH` entries that nobody else could have put a
`node` in (owned by root or the caller, not writable by others, group-writable
only by root's group or one of the caller's own; on Windows, not the current
directory), run by its absolute path, and with a minimal environment (`PATH`,
`HOME`, `TMPDIR`, `LANG`, `LC_*`; on Windows `SystemRoot`, `PATHEXT`,
`COMSPEC`). An operator may instead name the exact `node` with
`OPENSESAME_NODE` (an absolute path to an executable file): consulted first,
trusted as named like `OPENSESAME_ENV_PARSE`, exempt from the directory and file
checks, never forwarded to the bridge, and an unusable value is an error that
names the variable, not a fallback to `PATH`. The process that reads the schema
may hold the store passphrase, and the bridge never receives it
([audit](../security/audits/2026-10-13-env-spec-bridge-environment.md)).

Amended 2026-10-17: that rule, and the `OPENSESAME_NODE` override, now live in
[`opensesame-trusted-exec`](../../crates/trusted-exec), and the programs
`opensesame` starts by a fixed name were moved onto it in two steps. The first
covered `git`, `gpg`, `gh`, SOPS, the age plugin, `ps`, `tailscale`, the browser
openers and `node`; the second the daemon's discovery CLIs, `tomb`, the
enrollment prompts, `opensesame-id`, the connector-host provider CLIs, the
surrogate-proxy plugin's token source and the password-agent helpers, and the
keepassxc bridge now runs the binary beside `opensesame` or the one `--bin`
names, never a name left to `PATH`. Each is found through its own
`OPENSESAME_<PROGRAM>` variable or a trusted `PATH` entry whose every parent
directory only its owner can change, is run by its real path, and starts from an
empty environment plus an allowlist written beside its spawn. What a person
names on purpose (`dev run`'s command, a `custom-command` program, the
password-agent commands a policy names) keeps its own rules
([audit](../security/audits/2026-10-17-external-program-spawns.md), which lists
each program and says what is not covered).

## Context
Varlock / `@env-spec` provide a durable, MIT-licensed developer config surface (`.env.schema`) with schema/value separation, shaped placeholders, and a credential-proxy preview. OpenSesame already centers agent authority on ConnectionRef + Intent (ADR 0005). Reinventing a custom env DSL would violate anti-NIH; cloning Varlock’s HTTPS MITM as the primary broker would inherit protocol limits and a weak same-UID security boundary.

## Decision
1. **Preferred project contract is committed `.env.schema` (`@env-spec`).** Do not invent `.vault/env.yaml` / `vault.config.json` as the primary surface.
2. Parse via official **`@env-spec/parser`** (Node bridge); Rust consumes JSON AST — no DSL reimplementation.
3. OpenSesame resolvers in schema values:
   - `opensesame(conn://…)`
   - `opensesameConnection(conn://…, projection=legacy-token)`
4. Four **CredentialDeliveryMode** values:
   - `materialize` — real secret (legacy; requires export privilege)
   - `placeholder` — shaped fake + placement-bound egress substitution
   - `handle` — ConnectionRef / opaque handle
   - `native` — federation / signer / SPIFFE (no credential in env)
5. Agent/dev defaults **deny `materialize`**. Placeholder substitution is **placement-constrained** (header/path/query/body field + max occurrences) — never generic string replace.
6. Varlock remains a **compatibility peer** (run/proxy/sandbox prior art). Official `@varlock/opensesame` plugin is Path A (follow-up when third-party plugins open).
7. Optional thin `opensesame.toml` only for delivery policy / grants that `@env-spec` cannot express.
8. Host credential-agent issues short-lived **session capabilities** to WSL/devcontainers — not refresh tokens or secret-zero.

## Consequences
- CLI: `opensesame dev check|resolve|run|--agent`
- Domain + connector-host enforce delivery modes and placement
- REUSE lists `@env-spec/parser`; Varlock is integrate/peer, not fork
- MITM proxy is non-goal for this slice (amended by [ADR 0150](0150-surrogate-credentials-at-the-last-hop.md) §6.1: a per-run surrogate proxy in the daemon, recognize/strip/re-place, never a find-and-replace MITM)
