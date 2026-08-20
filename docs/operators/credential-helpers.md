# Credential helpers (ADR 0049)

Four helper binaries let standard tooling (git, docker, the AWS CLI, kubectl)
authenticate through OpenSesame **derived tokens** — provider-minted,
short-lived, revocable — instead of a long-lived token sitting in a plaintext
file. They are thin Unix-socket clients of the daemon's mint passthrough and
carry no crypto, storage, or credential handling of their own.

**Mint mode only.** Every helper requires a connection whose owner opted into
`materialization = derived_short_lived` (see `POST /v1/promote` with
`mode: mint`, or `PATCH /api/v1/connections/{id}`). A provider without a
native mint path answers `422 unmintable` and the helper fails closed — no
helper ever decrypts a stored credential.

## How the call flows

```
helper (git/docker/aws/kubectl)
  → POST /v1/mint  over the daemon's Unix socket
    → daemon forwards to POST /api/v1/connections/{id}/mint (operator_forward)
      → gateway mints a derived token (github App installation token in v1)
```

Authentication is the socket itself: the daemon authorizes UDS callers by
kernel-attested peer UID (`OPENSESAME_DAEMON_ALLOWED_UIDS`, default
same-user), so helpers need **no token**. Any non-200 from the daemon is a
hard failure: non-zero exit, nothing on stdout, only a failure class on
stderr.

## Socket location

The helpers read `OPENSESAME_AGENT_SOCK`; when unset they default to
`$XDG_RUNTIME_DIR/opensesame/agent.sock`, then `~/.opensesame/agent.sock`.
Run the daemon with a matching `--sock`:

```bash
opensesame-daemon --sock "${XDG_RUNTIME_DIR:-$HOME/.opensesame}/opensesame/agent.sock"
```

v1 is unix-only (ADR 0048 §8: Windows has no UDS daemon mode).

## git — `git-credential-opensesame`

```bash
git config --global credential.helper opensesame
# per-connection configuration:
export OPENSESAME_GIT_CONNECTION_ID="conn_…"            # required
export OPENSESAME_GITHUB_INSTALLATION_ID="12345678"     # github App connections
# export OPENSESAME_GIT_USERNAME="x-access-token"       # override default
```

On `get` the helper mints and prints `username` / `password` in the git
credential protocol. `store` and `erase` are deliberate no-ops: nothing is
persisted, ever. The minted token is what git caches in memory for the
operation; the next operation mints again.

## docker — `docker-credential-opensesame`

```jsonc
// ~/.docker/config.json
{
  "credHelpers": { "ghcr.io": "opensesame" }
}
```

```bash
export OPENSESAME_DOCKER_CONNECTION_ID="conn_…"         # required
export OPENSESAME_GITHUB_INSTALLATION_ID="12345678"     # github App connections
# export OPENSESAME_DOCKER_USERNAME="x-access-token"    # override default
```

`get` prints `{"ServerURL","Username","Secret"}`; `list` prints `{}` (the
helper holds nothing to list); `store`/`erase` no-op.

## AWS — `opensesame-credential-process`

```ini
# ~/.aws/config
[profile opensesame]
credential_process = opensesame-credential-process
```

```bash
export OPENSESAME_AWS_CONNECTION_ID="conn_…"            # required
```

**Fails closed in v1.** The gateway's aws mint arm (STS
GetSessionToken/AssumeRole) is a `422 unmintable` follow-up (ADR 0049 §3), so
this binary exits non-zero with a clear message until that arm lands; the
credential_process JSON output path is already implemented and lights up
unchanged when it does.

## kubectl — `opensesame-kube-exec`

```yaml
# kubeconfig
users:
- name: opensesame
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: opensesame-kube-exec
      interactiveMode: Never
```

```bash
export OPENSESAME_KUBE_CONNECTION_ID="conn_…"           # required
# export OPENSESAME_GITHUB_INSTALLATION_ID="12345678"   # github App connections
```

**Fails closed in v1** the same way: no kubernetes-mintable provider exists
yet, so the daemon answers `422` and the plugin exits non-zero. A minted
token is printed as an `ExecCredential` with `expirationTimestamp` from the
mint response.
