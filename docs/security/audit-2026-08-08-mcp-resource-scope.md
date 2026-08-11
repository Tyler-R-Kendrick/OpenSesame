# Audit tick 60 — a resource is not an origin

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny, clippy,
task-security-battle-test) were clean. The reading was `crates/protocol-mcp`,
`crates/protocol-aauth`, and `crates/authn`.

## An origin standing in for a resource (fixed)

`validate_resource_uri` compared the request URI to the protected resource's
audience by scheme, host, and port, and dropped the path. An audience is a
resource indicator (RFC 8707) and is routinely path-scoped — one host serving one
MCP server per tenant, `https://mcp.example/tenant-a`. Under the origin-only
reading a token minted for tenant-a's resource passed the resource check for a
request to tenant-b.

The check now confines a path-scoped audience to its path, at segment boundaries,
so `/tenant-attacker` cannot pass as `/tenant-a`. `crates/authn`'s
`validate_verification_uri_complete` already read paths this way; the two
neighbouring checks now agree. A request URI carrying userinfo is refused as well:
`https://mcp.example@evil.test/` names evil.test, not the resource.

Nothing calls this function outside its tests yet, so this is a fix ahead of the
wiring rather than a live exposure.

## Pinned rather than changed

The scope mappings in both protocol crates are stubs that cannot name a resource,
so they ask for the literal `*`. Selectors are literal (`ResourceSelector` has no
wildcard), which makes that request fail closed against any ceiling confined to
real resources — the safe reading, but an accidental one. Both crates now have a
test that says so, so the stub cannot quietly become permissive when the drafts
settle.

## Read and left alone

- `crates/authn`: device-flow polling, PKCE S256, and the verification-URI origin
  check are all sound; `validate_audience` is an exact match, which is right.
- `apps/gateway/src/routes/aauth.rs` `scope_check` takes the ceiling from the
  request body, but it is advisory (behind the experimental flag and a session or
  operator bearer) and grants nothing.
- Interpolated Host API paths in `apps/mcp-host` are percent-encoded.

## Note for the loop, not the repo

A `cargo test --workspace` run in this worktree failed to compile against a stale
`opensesame-task-access` rmeta from a sibling worktree, because both shared one
`CARGO_TARGET_DIR`. The audit worktree now builds into its own target directory;
the workspace is clean under it.
