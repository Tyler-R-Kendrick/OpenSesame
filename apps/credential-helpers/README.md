# opensesame-credential-helpers

Four credential-helper binaries for git, Docker, AWS and kubectl on the
Host/authority plane. Each is a thin Unix-socket client of the daemon's mint
path: it asks the daemon for a provider-minted, short-lived derived token and
prints it in the tool's own protocol. The helpers hold no crypto, no storage
and no secret of their own.

## Where it fits

- **Used by:** git, Docker, the AWS CLI and kubectl, configured to call these
  binaries. No workspace crate depends on it.
- **Builds on:** only `serde`, `serde_json` and `zeroize`. It talks to
  [`apps/daemon`](../daemon) `POST /v1/mint`, which forwards to the gateway's
  `POST /api/v1/connections/{id}/mint`.
- Mint mode only: the connection must be opted into
  `materialization = derived_short_lived`. A provider with no native mint path
  answers `422 unmintable` and the helper fails closed; nothing decrypts a
  stored credential.
- Authentication is the socket. The kernel attests the peer UID and the daemon
  authorizes same-UID callers, so the helpers carry no token. Unix only.
- On any failure a helper exits non-zero with nothing on stdout and only a
  failure class on stderr, never a token or response body.

## Surface

| Binary | Protocol | Configuration |
|---|---|---|
| `git-credential-opensesame` | git credential helper: `get` answers only `protocol=https` on an allowed host; `store`/`erase` are no-ops | `OPENSESAME_GIT_CONNECTION_ID`, `OPENSESAME_GIT_HOSTS` (default `github.com`), `OPENSESAME_GIT_USERNAME` |
| `docker-credential-opensesame` | Docker credential helper: `get`; `list` prints `{}`; `store`/`erase` are no-ops | `OPENSESAME_DOCKER_CONNECTION_ID`, `OPENSESAME_DOCKER_USERNAME` |
| `opensesame-credential-process` | AWS `credential_process` JSON | `OPENSESAME_AWS_CONNECTION_ID` |
| `opensesame-kube-exec` | client-go `ExecCredential` | `OPENSESAME_KUBE_CONNECTION_ID` |

All helpers read `OPENSESAME_GITHUB_INSTALLATION_ID` for GitHub App
connections, and `OPENSESAME_AGENT_SOCK` for the socket (default
`$XDG_RUNTIME_DIR/opensesame/agent.sock`, else `~/.opensesame/agent.sock`).
The AWS and kubectl helpers fail closed today: the gateway has no AWS or
Kubernetes mint arm yet, so the daemon answers `422 unmintable`.

The library (`src/lib.rs`) exposes the shared plumbing: `default_sock_path`,
`required_env`, the daemon client's `mint`, per-protocol renderers and `fail`.

## Develop

```bash
cargo +1.88.0 build -p opensesame-credential-helpers
cargo +1.88.0 test -p opensesame-credential-helpers
```

`tests/helpers.rs` runs each binary as a subprocess against a stub daemon on a
temporary Unix socket and asserts the exact stdout shape on success and empty
stdout on refusal.

## Related

- [ADR 0049](../../docs/adr/0049-derived-short-lived-materialization.md) — derived short-lived materialization
- [ADR 0048](../../docs/adr/0048-capability-moded-connector-discovery.md) — UDS peer attestation (§8)
- [Operators: credential helpers](../../docs/operators/credential-helpers.md)
