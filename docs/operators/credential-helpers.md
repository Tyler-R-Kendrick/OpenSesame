# Credential helpers (ADR 0049)

Four helpers let standard tooling (git, docker, the AWS CLI, kubectl)
authenticate through OpenSesame **derived tokens** — provider-minted,
short-lived, revocable — instead of a long-lived token sitting in a plaintext
file. They are not separate binaries: `opensesame` answers as each one when it
is started under the helper's name, and `opensesame helpers link [--dir <dir>]`
creates those names as links to it (default: the binary's own directory). They
are thin Unix-socket clients of the daemon's mint passthrough and carry no
crypto, storage, or credential handling of their own.

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
      → gateway mints a derived token (a GitHub App installation token, or
        STS credentials for an aws connection's bound role, ADR 0217)
```

The helpers send **no token**, and never read `OPENSESAME_OPERATOR_TOKEN`, so a
process that replaced the socket would learn nothing from a helper that
authorizes anything. On the Unix socket the daemon's `/v1/mint` first
authenticates the caller by its kernel-attested peer credentials (ADR 0138 §2):
the peer UID must be one of `OPENSESAME_DAEMON_ALLOWED_UIDS` (default: the
daemon's own UID). A request with an `Origin` header is `401`, a peer outside
the allowed UIDs is `401 uds_peer_unauthorized` even if it presents a valid
operator token, and a peer the kernel did not attest is `503
uds_peer_unattested`.

Peer credentials say who asks, not what it should get, so **the operator
grants what a helper may mint**: a connection and, for a GitHub App
connection, the one installation it is for. The list starts empty:

```bash
export OPENSESAME_OPERATOR_TOKEN=…                          # the daemon's operator token
opensesame daemon helpers allow conn_… --installation 12345678   # a GitHub App connection
opensesame daemon helpers allow conn_…                      # a connection that takes no installation
opensesame daemon helpers list
opensesame daemon helpers revoke conn_…
```

A GitHub App's key reaches every installation of the App, and each may be
another account's repositories, so the installation is part of the grant: a
helper's `OPENSESAME_GITHUB_INSTALLATION_ID` must match it exactly, and a grant
that names no installation admits a mint that names none. The installation is
the only field a helper sends that selects what is minted; the rest of the
request names the connection or, for an AWS connection, asks for a shorter
lifetime under the binding's cap. The daemon keeps the grants owner-only in its
state directory (`helper-mints.json`), so they survive a restart. The file
carries an HMAC under a key derived from the operator token, so only the token
can write grants the daemon will read back: a file edited by hand, one written
under a previous token, one it cannot read and one in another shape all admit
nothing, and `helpers list` shows `"stored": "unauthenticated"` (or
`"unreadable"`) instead of an empty list with no reason. **Rotating the
operator token invalidates every grant**: allow each again under the new token.
The tag is only as strong as the token's custody. The daemon reads the token
from its environment, and a process running as the same user can usually read
that (`/proc/<pid>/environ`) or the file you keep it in, so the tag keeps out
a process that can write the state directory but does not hold the token.
That token can write grants anyway. `helpers revoke` takes effect at once in
the running daemon; to end a grant against a same-user process that may have
copied the grant file, rotate the operator token or revoke the connection at
the Host. A token-less mint of any
other connection or installation is `403 helper_mint_not_allowed`. A socket caller that presents the operator token may
mint any connection, as before. The daemon then forwards to the Host with its
own operator token (`operator_forward`, loopback Host only) and names the peer
in `on_behalf_of`; the Host records `operator on_behalf_of=uid:<uid>,pid:<pid>`
as the actor of the mint, in its answer and on the connection's event trail.
Over TCP the route demands the operator token, as every other operator route
does on both transports. Any non-200 from the daemon is a hard failure:
non-zero exit, nothing on stdout, only a failure class on stderr.

**Residual risk.** Any process running as an allowed user can mint every
granted connection and installation on the socket, an agent run included. Give a sandbox or an
agent run its own narrower path (ADR 0099's launch capability), never the raw
socket, and allow only the connections the helpers on this machine need.

## Socket location

The helpers read `OPENSESAME_AGENT_SOCK`; when unset they default to
`$XDG_RUNTIME_DIR/opensesame/agent.sock`, then `~/.opensesame/agent.sock`.
Run the daemon with a matching `--sock` (or set `OPENSESAME_AGENT_SOCK`):

```bash
opensesame daemon run --sock "$XDG_RUNTIME_DIR/opensesame/agent.sock"
# no XDG_RUNTIME_DIR: --sock "$HOME/.opensesame/agent.sock"
```

v1 is unix-only (ADR 0048 §8: Windows has no UDS daemon mode).

## git — `git-credential-opensesame`

```bash
git config --global credential.helper opensesame
# per-connection configuration:
export OPENSESAME_GIT_CONNECTION_ID="conn_…"            # required
export OPENSESAME_GITHUB_INSTALLATION_ID="12345678"     # github App connections
# export OPENSESAME_GIT_USERNAME="x-access-token"       # override default
# export OPENSESAME_GIT_HOSTS="github.com,ghe.example.com:8443"  # default github.com
```

The helper answers `get` only when git asks for `protocol=https` and a `host`
that exactly matches an entry in `OPENSESAME_GIT_HOSTS` (comma-separated, port
included when git sends one). Anything else — another host, a submodule on an
attacker's server, plain `http` — gets an empty answer, so git falls through to
its next helper and the minted token never reaches a host it was not minted for.

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
# export OPENSESAME_AWS_DURATION_SECONDS=1800           # 900 up to the binding's cap
opensesame daemon helpers allow conn_…                  # once, with the operator token
```

The Host assumes an IAM role with STS and the helper prints STS's temporary
credential in the `credential_process` shape (`Version`, `AccessKeyId`,
`SecretAccessKey`, `SessionToken`, `Expiration`). The IAM key pair it signs
with stays sealed in the Host (ADR 0217).

**Configure a binding** (an operator or the connection's owner, administrator
role). The connection is an `aws`, `aws-kms`, `aws-ps` or `aws-bedrock`
connection whose configuration holds `access_key_id` and `secret_access_key`
(and `session_token` when the key is itself temporary), opted in to
`materialization = derived_short_lived`:

```bash
curl -sS -X PUT "$OPENSESAME_HOST_API/api/v1/connections/conn_…/aws-sts-binding" \
  -H "X-OpenSesame-Operator: $OPENSESAME_OPERATOR_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "role_arn": "arn:aws:iam::123456789012:role/Deployer",
    "region": "eu-west-1",
    "max_duration_seconds": 1800,
    "session_policy": {"Version": "2012-10-17", "Statement": [
      {"Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::deploy-bucket/*"}
    ]},
    "external_id": "…"
  }'
```

- `role_arn` and `region` are required. The region must be one with a
  regional STS endpoint; the mint talks to `sts.<region>.amazonaws.com` and
  nowhere else.
- `max_duration_seconds` caps every mint (900–3600, default 900). A mint asks
  for 900 unless the caller sends `duration_seconds`; a request above the cap
  is refused, not shortened.
- `session_policy` is optional. STS intersects it with the role's own policy,
  so it can only narrow what a minted credential may do (at most 2048
  characters once minified).
- `external_id` is optional, sealed with the binding, and never shown again:
  `GET` on the same path answers only whether one is set. `DELETE` removes the
  binding, after which the connection is `422 unmintable` again.
- The role's trust policy must let the source principal call
  `sts:AssumeRole` **and** `sts:SetSourceIdentity`: every mint sets
  `SourceIdentity` to the calling principal (never the `on_behalf_of` note
  the receipt records), and `RoleSessionName` to `opensesame-<grant id>`, the
  id the Host's receipt records.

Every mint writes a value-blind receipt (role, session name, source identity,
duration, expiry, STS request id) as the connection's `materialized` event, and
its expiry is published on the `lifecycle.*` feed. A refusal is one stable code
and none of STS's words: `aws.sts.access_denied`, `aws.sts.expired_source`,
`aws.sts.region_disabled`, `aws.sts.throttled`, `aws.sts.malformed_response`,
`aws.sts.unreachable`. Nothing is retried; on `throttled` or `unreachable`, run
the AWS command again.

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
