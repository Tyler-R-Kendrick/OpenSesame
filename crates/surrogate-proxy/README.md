# opensesame-surrogate-proxy

The surrogate proxy adapter of [ADR 0150](../../docs/adr/0150-surrogate-credentials-at-the-last-hop.md)
§6.1. An unmodified SDK or CLI is given `osr_…` where it expected a token, and
sends it where it would have sent the token. This crate is the last hop: a
per-run forward proxy that terminates the child's TLS, hands each request to
`SurrogateLedger::admit`, and turns an admitted request into an invoke-through
call. The credential is written into the provider's own site by
`Invoker::execute`, and the response is scrubbed of it on the way back. The
surrogate text never becomes the credential; it only selects one.

## Where it fits

- **Ships as:** the optional plugin binary `opensesame-surrogate-proxy`
  (`src/bin/`, `src/plugin/`), installed at runtime and pinned by sha256
  (ADR 0150 §7, [plugins guide](../../docs/operators/plugins.md)).
  `opensesame dev run --agent` spawns it per run while it is switched on.
  Neither `opensesame` nor the daemon links this crate;
  `pnpm audit:plugin-boundary` fails if either does, so ADR 0048 §5's budget
  is unchanged.
- **Builds on:** [`opensesame-invoke-through`](../invoke-through) — the ledger,
  the fence, the invoker and the reflection scrub;
  [`opensesame-session-observe`](../session-observe) (the run lease),
  [`opensesame-rotation-web`](../rotation-web) (login substitution),
  [`opensesame-plugin-settings`](../plugin-settings) (the install gate and the
  login switch) and [`opensesame-agent-events`](../agent-events) (the
  `surrogate.*` notices). `opensesame-transport-security` (with `testkit`) is a
  dev-dependency only, for the loopback TLS upstream.
- One listener per run on `127.0.0.1:0`, one in-memory CA per run, one random
  proxy credential per run, one ledger across runs.

## What it enforces, in order

1. **Caller identity.** Every request to the listener carries the run's
   `Proxy-Authorization: Basic`, compared in constant time, or gets `407`. The
   identity passed to admission is the run instance's, never a client string.
2. **One destination.** The CONNECT authority, the TLS server name and the
   inner `Host` (and an absolute request target, if any) must agree. A server
   name mismatch closes the tunnel before a leaf is minted; a `Host` mismatch
   is `403`.
3. **A whole, bounded body.** Read up to invoke-through's 256 KiB request cap
   before the scan (`413` past it), so nothing forwardable escapes the scan.
4. **Admission.** A refusal goes to the embedder's `RefusalSink` (the
   `surrogate.*` tripwire) and the client gets `Refusal::CLIENT_MESSAGE`.
5. **Forwardable headers only.** An admitted request keeps the provider's
   allowlisted headers (`accept`, `content-type`, `user-agent`, and e.g.
   GitHub's `x-github-api-version`); `accept-encoding`, cookies and the rest
   are dropped.
6. **Un-surrogated traffic** is refused unless the run named the host as
   passthrough (port 443 only), in which case it is tunnelled on with no
   credential of ours. Plain HTTP is scanned (a surrogate in it trips
   `surrogate.cleartext`) and never forwarded.
7. **Fail closed.** A certificate-pinning client, a client that ignored the
   trust variables, or an h2-only client fails its handshake. Nothing falls
   back to a blind tunnel or a credential.

The CA key never leaves process memory and is never returned. The CA
certificate reaches the child only through its own trust variables
(`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
`CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`); no system or user trust store is touched.

## Surface

| Item | Role |
|---|---|
| `SurrogateRuns::new(ProxyConfig)` | The registry: one ledger over the invoker's own egress rules |
| `SurrogateRuns::create_run(run_id, &RunSpec)` | Mint the run CA, issue surrogates from OS entropy, open the listener |
| `SurrogateRuns::end_run(run_id)` | Revoke the run's surrogates and logins, stop its listener, close its tunnels; also its `RunCredentials::revoke` |
| `SurrogateRuns::credentials()` | A `RunRevoker`: the `RunCredentials` that revokes a run and leaves its listener up, so a late use reads `surrogate.revoked` |
| `SurrogateRuns::lease(run_id)` | Where the run's `ControlLease` stands |
| `RunSpec`, `SurrogateGrant`, `LoginGrant` | Grants (env var, provider, `conn://…`, site, methods, path prefixes, ttl), web logins (env var, origin, action, field, credential, trust), passthrough hosts, `watched` |
| `RunObserver`, `Tripped`, `LoginEvent` | What the embedder hears: a tripwire that revoked a run, a login substituted or refused |
| `RunHandle` | `proxy_url()` (secret), `ca_pem()`, `surrogates()`, `child_env(ca_file)`; `Debug` names neither secret |
| `ProxyConfig` | Invoker, `TokenSources`, `RefusalSink`; optional `ReceiptSink`, `Clock`, `PassthroughClient`, CA validity, `RunObserver`, and the plugin's `PluginState` that arms login substitution |
| `TokenSources`, `ProviderSources` | Pick the credential source for an admission (per provider by default) |
| `RefusalSink`, `ReceiptSink`, `Clock`, `SystemClock` | The embedder's ports |
| `env` | The trust, proxy and `NO_PROXY` variable names; `is_reserved`, `is_valid_name` |
| `plugin::main_entry` | The plugin binary: gate, then one run over stdio |
| `plugin::gate::admit` | Refuse unless the settings file says the plugin is active and this executable hashes to its pin |
| `plugin::wire` | The control protocol: one spec line in (logins' passwords ride only here), one reply line out |
| `plugin::serve::serve` | Start the run, reply, write event lines while serving until stdin EOF, a signal or the TTL, then `end_and_revoke` and remove the CA file |
| `plugin::source::CliTokenSource` | invoke-through's `source_tool` per provider, scrubbed env, timeout, capped capture |
| `plugin::notices::NoticeLog` | `RefusalSink` writing vetted `surrogate.*` notices as JSON lines, `0600`: noise to `notices.jsonl` (capped, rotated once), evidence to `tripwires.jsonl` (capped, never rotated) |

## The run lease and the tripwire (ADR 0150 §6.2)

Every run gets a `ControlLease` from `opensesame-session-observe` and a
`watched` flag. Every refusal — invoke-through's and a login form's — goes
through `tripwire_verdict`: a `surrogate.misdirected` naming a watched run
that the agent still drives parks it (or suspends it inside a critical
section) and `apply_tripwire` revokes through `RunRevoker`. The listener keeps
serving, so the next use of any of the run's surrogates is refused as
`surrogate.revoked`. The embedder's `RunObserver` hears it; the plugin writes
it to its parent as `{"event":"tripwire",…}`.

## Login forms (ADR 0150 §6.3)

A run may declare logins. Each is `opensesame-rotation-web`'s
`LoginSubstitution`, armed by `LoginRoad::choose` over the plugin's own
switch — this crate is the only one that enables `rotation-web`'s
`login-surrogate` feature. Every request is first read for a login
surrogate, raw or percent-encoded, anywhere: one that carries it goes to
`ArmedSubstitution::egress` and nowhere else (substituted once into the one
declared field, or refused — misdirected and misplaced are tripwires); one
bound for a declared login origin without it is forwarded with no credential.
Every login-origin response is buffered (8 MiB cap), refused if it is not
identity-encoded, and scrubbed by `ResponseScrub` before the child sees it.

## Residual, stated

- `HTTPS_PROXY` is advisory. A process that bypasses the proxy holds only a
  dead string, so confidentiality survives; detection does not. Confining the
  network is the sandbox's job.
- Passthrough request bodies are bounded by the same 256 KiB cap as every
  scanned request.
- A surrogate is the connection's authority on its host, within its scope;
  misuse inside scope is bounded by the grant, not by this crate.

## Develop

```bash
cargo +1.88.0 test -p opensesame-surrogate-proxy
```

`tests/end_to_end.rs` is ADR 0150's acceptance run against a loopback TLS
upstream; `tests/destination.rs` covers misdirection, SNI/`Host`
disagreement, pinning and plain HTTP; `tests/lifecycle.rs` covers the proxy
credential, run end, foreign callers, expiry, passthrough and the body cap.
`tests/plugin_tripwire.rs` runs the built plugin binary through a
misdirected surrogate and proves the next, correct use is refused as revoked;
`tests/plugin_login.rs` runs it against a loopback HTTPS login site and
proves the password crossed the wire once, in its field, and appears in no
file, argv, environment, notice, stdout or stderr of the plugin.
`tests/plugin_process.rs` runs the built plugin binary as a person's machine
does: the install gate (not installed, off, forced off, pin mismatch), the
reply, the TTL, `SIGTERM`, stdin close, and a misdirected surrogate becoming
a notice line that never carries it.
