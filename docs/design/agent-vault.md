# Agent Vault

OpenSesame's agent access layer. This is the product surface that competes with
[Infisical Agent Vault](https://infisical.com/docs/documentation/platform/agent-vault/overview)
and its open-source predecessor
[`Infisical/agent-vault`](https://github.com/Infisical/agent-vault). It reuses
the Host authority fabric and the device vault; it does not copy Infisical's
proxy architecture.

## The split

Native and PWA are not two skins for one feature set. They have different
attack surfaces, so they get different mechanisms and the same policy model.

| | Native (`opensesame agent-vault`) | PWA (`apps/pages`) |
|---|---|---|
| Where the boundary is | A forward proxy on a host the agent cannot read | A dedicated worker on the page's origin |
| Credential reaches | The proxy's invoker, never the child process | The worker, never the page's JS context |
| Agent interface | `HTTPS_PROXY`, `HTTP_PROXY`, CA bundle variables | `opensesameFetch()` / WebMCP tool call |
| Works for | Unmodified `curl`, `git`, `gh`, SDKs, CLIs, MCP servers | Browser agents, WebMCP tools, in-page assistants |
| CA / system trust | Per-proxy CA, optional certificate pin | None; no MITM, no system trust |
| Protocol ceiling | HTTP/1.1, HTTP/2 where the proxy supports it | Whatever `fetch` supports on the origin |
| Session proof | DPoP key or mTLS identity, bound at enrollment | Origin-bound worker key and Host grant |
| Logs | Sealed locally by default; optional S3 export | Sealed in the vault; visible in the session page |
| Admin | Service/bundle/session/proxy management | The same records, plus session and log views |

The PWA never opens a listener and never installs a CA. A browser agent cannot
be given a system-wide `HTTPS_PROXY`, and a page that can run an agent can also
read anything on that origin. The worker boundary is therefore the strongest
PWA claim we can make, and it is stated as such.

## What parity means

The table is the contract. "Now" is what this checkout has. The target column
is the feature this design adds.

| Infisical capability | Infisical OSS | Infisical platform | OpenSesame now | OpenSesame target |
|---|---|---|---|---|
| Vaults / credentials | Yes | Yes | Device vault, Host connections, secret backends | Services can bind a vault item or a connection, never one hard-coded shape |
| Services | Service rules | Services + templates | Connections and provider operations | `AgentService`: hosts, schemes, ports, auth, rules, headers, substitutions |
| Access bundles | No | Yes | Local grants / connection grants | `AccessBundle`: ordered services plus grant subjects |
| Sessions | Agent tokens | Time-bound sessions | Run leases, grants, receipts | `AgentSession`: bundle, principal, proof key, TTL, revoke |
| Proxy | Single binary, MITM | Managed proxies, enrollment, CA | `surrogate-proxy` plugin, per-run CA | Native managed proxy with enrollment and pinning |
| Placeholder substitution | Yes | Yes | Surrogate selects a connection; no generic replace | Declared field only, path/query/header/body with caps and response scrub |
| Host rules | Yes | Yes | Connection `egress` and invoke-through fences | Exact host, scheme, port, path prefixes, methods |
| Custom headers | Yes | Yes | Connection/provider headers | Service headers with variable references |
| Variables | Yes | Yes | Vault items, env bindings | `{{KEY}}` references resolved at the invoker |
| Traffic policy | Deny unmatched | Any / bundle hosts only, exceptions | Fail-closed broker paths | Deny-by-default; per-proxy exceptions |
| Session logs | Request logging | Encrypted S3 | Activity log, receipts | Sealed local chunks; optional S3 export |
| Access control | Users, agents | Users, groups, machine identities, admin/member | Local grants, Identity principals | Same subjects and roles on one policy model |
| CLI / API / SDK | CLI + server API | CLI + API + SDK | CLI `dev run`, password-agent, Host API | `agent-vault` CLI and TypeScript SDK for both runtimes |
| External stores | Infisical plugin | Infisical | Secret-backend adapters | Service credentials from any adapter |
| PostgreSQL | Yes | Managed | Host storage | Optional native server store |
| Caller binding | Token | Token, poll interval | Run lease, scoped surrogates | Proof-bound session (DPoP/mTLS); copied token alone is dead |
| Response scrubbing | Not described | Not described | Yes, invoke-through | Keep and test for every service |
| Revocation latency | Token revoke | Poll (60s default) | Run lease ends at once | Immediate at the native proxy; poll only for remote management |

## Where we outperform

1. **A copied session credential is not enough.** Native sessions carry a
   proof key (DPoP or mTLS). Infisical puts a bearer session token in the proxy
   URL; a leaked token is usable until expiry. PWA sessions are origin-bound
   and held in a worker, not in page JS.
2. **No generic find-and-replace.** A surrogate selects a connection and a
   declared site. It does not rewrite the placeholder wherever it appears.
   Response scrubbing closes the reflection oracle.
3. **The proxy is not the secret holder.** Invoke-through writes the credential
   into the provider's own request through the broker; the proxy never returns
   it and the child never receives it.
4. **Deny by default.** Unmatched hosts, wrong ports, wrong methods and
   traversal-shaped paths are refused before egress. "Any host" stays an
   explicit choice.
5. **Logs are not an enterprise add-on.** Sealed local logs are the default;
   S3 is an export target, not the only way to see what happened.
6. **Two honest runtimes.** The PWA does not pretend a browser can provide a
   system proxy or CA trust. Native does not pretend a page can isolate a
   process. Each runtime gets the strongest mechanism it can actually enforce.
7. **Workload identity.** Native can bind an agent to an mTLS/SPIFFE identity,
   not only a token.

## Data model

All records are sealed. No record contains a credential in clear; a service
references a connection or vault item.

```text
AgentService
  id, name, hosts[], schemes[], methods[], paths[]
  auth: bearer | basic | pass-through
  credential: connectionRef | vaultItemId | variableRefs
  headers[], substitutions[]
  variableRefs[]

AccessBundle
  id, name, serviceIds[]
  grants: principalId -> admin | use

AgentSession
  id, bundleId, principalId
  proof: dpopJwk | mtlsIdentity
  expiresAt, revokedAt
  runtime: native | pwa

ProxyEnrollment
  id, name, caFingerprint, statePath
  trafficPolicy: any | bundle-hosts
  exceptions[], pollSeconds

AgentRequestLog
  sessionId, seq, at, method, host, port, path
  status, decision: brokered | passthrough | blocked | error
  serviceId, bytesIn, bytesOut
```

`AgentService` and `AccessBundle` are the only admin-authored records.
`AgentSession` is minted from a bundle and is immutable. `AgentRequestLog` is
append-only and never stores headers, query strings, bodies, or credentials.

Machine identity authentication is specified separately in
[machine identity auth](machine-identity-auth.md): Universal, Token, JWT, OIDC,
SPIFFE, TLS certificate, Kubernetes, AWS, GCP, Azure, Alibaba, OCI and LDAP.
Group provisioning and GitHub team sync are in
[group provisioning](group-provisioning.md).

## Runtime contracts

### Native

```bash
opensesame agent-vault service add --bundle code-review ...
opensesame agent-vault session create --bundle code-review --ttl 1h
opensesame agent-vault run --session <token> --proof <key> -- claude
opensesame agent-vault proxy --enrollment <token>
```

`run` starts or connects to a proxy, sets the CA variables, sets
`HTTPS_PROXY`/`HTTP_PROXY`, and supervises the child. The session token is
passed as the proxy credential plus a proof header; the proxy verifies both.
The child never gets a service credential.

The proxy admits only a declared destination: CONNECT authority, TLS SNI and
inner `Host` agree. It resolves the service, checks method/path, invokes through
the broker, scrubs the response, and records a metadata-only log row.

### PWA

```ts
const session = await agentVault.session.create({ bundle: "code-review" });
const github = agentVault.fetch(session, "https://api.github.com");
await github("/repos/acme/web/issues", { method: "GET" });
```

The worker holds the sealed service credential, verifies the session's origin
and expiry, applies the same service rules, performs the fetch, scrubs the
response, and returns only the response. No credential crosses into the page,
no `HTTPS_PROXY` is set, and no CA is trusted.

Browser agents that use WebMCP call the same worker through a tool whose
arguments are the method, URL, and body. The tool result is the scrubbed
response.

## Delivery slices

1. **Policy core (shared).** Service/bundle/session records, request matching,
   method/path/port rules, variable resolution, log schema, and tests. No
   runtime yet.
2. **PWA console.** Manage services, bundles, sessions, and paired native
   proxies; show logs and out-of-sync state. No credential can be revealed to
   the page.
3. **PWA worker broker.** Sealed worker vault, `opensesameFetch`, WebMCP tool,
   origin/expiry proof, response scrub, local logs.
4. **Native CLI and proxy.** `agent-vault` commands over the existing
   `surrogate-proxy` and `invoke-through` crates; enrollment CA; DPoP proof;
   traffic policy; process supervision.
5. **Access control.** Map bundle grants to Identity users, groups, machine
   identities, and local device principals.
6. **Logs and export.** Sealed local chunks first, optional S3 export with the
   same AES-GCM format and cursor semantics.
7. **Compatibility.** Import an `Infisical/agent-vault` service/vault export
   where the shapes map, and refuse the parts that cannot be honest (opaque
   placeholders rewritten anywhere, bearer-only proxy credentials).

Slices 1 and 2 are the first implementation. They make the product legible
without weakening either runtime. Slice 3 is PWA-only. Slice 4 is native-only.

## Non-goals

- A PWA that installs a CA or opens a local proxy port.
- Replacing a service credential by a global string search.
- Recording request or response bodies as session logs.
- Treating a bearer session token as proof of the agent that presented it.
- Giving an agent a `getSecret()` path in either runtime.

## Acceptance tests

- `curl`, `git`, `gh`, a Python `requests` client and an MCP server work through
  the native proxy with no credential in argv, env, stdout, or the child's
  filesystem.
- A copied native session token without the proof key gets `407`.
- A PWA page script that reads every global and message cannot obtain a service
  credential; only the worker can.
- An unmatched host, wrong port, disallowed method, or traversal path gets
  `403`; the log records `blocked`.
- An upstream that echoes the credential has it scrubbed before the agent sees
  it.
- Revoking a native session closes the next request immediately; a PWA session
  closes at the worker on the next call.
- Logs contain method, host, port, path, status, decision and service only.
- The PWA bundle contains no proxy listener, CA trust call, `HTTPS_PROXY`, or
  native secret.
