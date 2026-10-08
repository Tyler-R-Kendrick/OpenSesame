# Optional plugins

Some features are advanced, and most people will never use them. They are not
in the default `opensesame` binary, the daemon or the Pages bundle. Each one is
a **plugin**: a separate artifact a person installs at runtime, pinned by
sha256, recorded **off**, and run only once switched on
([ADR 0150](../adr/0150-surrogate-credentials-at-the-last-hop.md) §7).

The catalog is [`spec/plugins/catalog.json`](../../spec/plugins/catalog.json):

| Plugin | Kind | What it adds | Settings capability |
|---|---|---|---|
| `surrogate-proxy` | native binary `opensesame-surrogate-proxy` | `opensesame dev run --agent` hands a child `osr_…` surrogates instead of placeholders, redeemed at the last hop (ADR 0150 §6.1), and signs its browser in to declared login forms without handing it the password (§6.3) | `agents.surrogate-credentials` |
| `browser-autofill` | companion browser extension `@opensesame/browser-extension-autofill` | fill a login field by reference from extension-owned UI (ADR 0150 §6.4); answers the daemon's `/v1/fill` only while on | `vault.browser-autofill` |

## Install

Installing is done by a person at a terminal. The daemon has no install route.

```bash
# Native plugin: a local file or an https URL, and the sha256 you expect.
opensesame plugins install surrogate-proxy \
  --from https://example.test/releases/opensesame-surrogate-proxy-linux-x86_64 \
  --sha256 <64 hex characters> --version 0.1.0

# Browser extension: the packed zip (its sha256), and the extension id.
opensesame plugins install browser-autofill \
  --from ./opensesame-autofill.zip --sha256 <hex> \
  --extension-id <id> --version 0.1.0
```

What `install` does, in order:

1. It checks that the plugin id is in the catalog, that `--sha256` is 64 hex
   characters, and that `--version` is one plain path segment.
2. It fetches `--from` into a partial file beside its destination. Only
   `https://` URLs are fetched. A redirect is followed only on the same host,
   over https, at most five times. Downloads are capped at 256 MiB.
3. It hashes the partial file. **If the hash is not the pin, nothing is
   installed and nothing is recorded**, and the partial file is deleted.
4. It moves the file into place, mode `0755` for a native binary, and records
   the install **off**. Reinstalling or upgrading records it off again.

For a browser extension installed from its store, pass the store id as both
`--from` and `--extension-id`. Only the store verifies that package.

## Switch on, switch off

```bash
opensesame plugins enable surrogate-proxy
opensesame plugins disable surrogate-proxy
opensesame plugins list                 # every catalog plugin's state
opensesame plugins status surrogate-proxy   # state, location, pin: ok | mismatch | missing
opensesame plugins notices surrogate-proxy  # recent tripwires, newest first
```

Settings does the same through the daemon's plugin routes. A caller with no
`Origin` needs the operator token, or the Unix-socket peer check. A browser
needs the key its page was paired with (next section), sent from exactly the
origin it was paired at:

```text
GET  /v1/plugins                 -> {"plugins":[PluginState,…]}   catalog order
PUT  /v1/plugins/{id}            {"enabled":bool} -> PluginState
                                  | 404 {"error":"not_installed"} | 400 {"error":"unknown_plugin"}
                                  | 409 {"error":"pin_mismatch"}
GET  /v1/plugins/{id}/notices    -> {"notices":[{event_type,severity,occurred_at,summary,subject_id?}]}
```

Enabling a plugin that is not installed fails, and says how to install it.
Enabling a native plugin re-checks its pin first, from the terminal and from
Settings alike. A file that changed since install is left off.

## Pairing Settings with the daemon

Settings in Pages reaches these routes only after a person pairs that page,
at the daemon's terminal:

```bash
opensesame plugins pair --origin https://vault.example.org \
  --url https://desk.tail4c2e.ts.net     # the daemon's Tailscale Serve URL
opensesame plugins pair --origin http://localhost:5180   # Pages on this machine
opensesame plugins unpair --origin https://vault.example.org
opensesame plugins unpair --all
opensesame plugins list                  # also lists pairings: origin and time, never a key
```

`pair` prints a code (`opensesame-plugins:v1:…`, the wire form is
`spec/conformance/plugin-pairing.json`). Paste it into the pairing field of
the plugin's tile in Settings › Capabilities. The code:

- works **once**, within **five minutes**, and only from the page at exactly
  `--origin` (`https://host[:port]`, or `http://localhost:port`). A code
  presented from any other origin is spent on the spot;
- names a daemon address on this machine or the tailnet. Pages refuses any
  other;
- is taken only by a deployment that may hold local authority: Pages on its
  own dedicated origin, or on this machine. The shared GitHub Pages origin
  pairs nothing, because every page under it shares the origin a key would
  be bound to;
- is kept only as a SHA-256, in `plugin-pairings.json` beside `plugins.json`
  (mode `0600`).

The page trades the code (`POST /v1/plugins/pairing`, five tries at once then
one every twelve seconds, for the whole daemon) for a key the daemon also keeps
only as a SHA-256. The page seals the key in its open vault, never in plain
storage, and a guest cannot pair. The key:

- opens `GET /v1/plugins`, `PUT /v1/plugins/{id}` and
  `GET /v1/plugins/{id}/notices`, and nothing else. Every other daemon route
  still refuses a browser, and no other route knows this key;
- is accepted only with the `Origin` it was paired at;
- cannot install anything, and cannot switch on a plugin that is not
  installed or whose pin no longer matches;
- ends with `opensesame plugins unpair`, or when the page forgets the pairing
  (`DELETE /v1/plugins/pairing` revokes that page's key alone).

CORS on these routes answers only an origin that holds a key or a code still
waiting. It echoes that exact origin, never `*`, allows no credentials, and
always sends `Vary: Origin`. A preflight that asks for private-network access
is answered for that origin alone.

## Forcing a plugin off

`OPENSESAME_PLUGIN_<ID>=off` turns a plugin off for any process that sees it,
whatever the settings file says. `<ID>` is the id uppercased, with `-` changed
to `_`, for example `OPENSESAME_PLUGIN_SURROGATE_PROXY=off`. The override fails
toward off: any value that is not empty and not `on`, `1`, `true` or `yes`
counts (`off`, `0`, `false`, `no` and `disabled` among them), and those four
words only leave the settings file in charge. **No value turns a plugin on.** An
operator can withdraw a plugin from a process, but no environment can enable
something a person did not. `PluginState.forced_off` reports it.

## Pins are checked at every launch, not only at install

- `opensesame dev run --agent` re-hashes the installed binary before it spawns
  it. If an **enabled** plugin no longer matches its pin, or is missing, the
  run **fails**. It does not quietly fall back to placeholders, because the
  person who asked for surrogates would then be running without them and not
  know it.
- The plugin checks again from inside. It will not start unless the settings
  file says it is active **and its own executable hashes to the recorded
  pin**. Run directly, from a copied path, while switched off or forced off,
  or after its bytes changed, it prints `{"error":"plugin_not_active"}` or
  `{"error":"plugin_pin_mismatch"}`, exits `3`, and opens no listener.
- When the plugin is not installed or not switched on, `dev run --agent` works
  exactly as before plugins existed. It delivers placeholders and prints one
  line saying surrogate delivery is available as an optional plugin.

## Where the files live

| What | Where |
|---|---|
| Settings file (which plugins are installed, pinned, on) | `<config dir>/plugins.json`. A shipped build reads no environment variable for this path; `OPENSESAME_PLUGINS_FILE` is honoured only by test builds (cargo feature `path-override`) |
| Installed native plugin | `<data dir>/plugins/<id>/<version>/<binary>`, or under `OPENSESAME_PLUGINS_DIR` |
| Installed extension package | `<data dir>/plugins/<id>/<version>/<id>.zip` |
| Plugin state: notices | `<dir of plugins.json>/plugin-state/<id>/notices.jsonl` (`0600`, capped at 1 MiB, rotated once to `notices.jsonl.1`) |
| Plugin state: tripwires | `<dir of plugins.json>/plugin-state/<id>/tripwires.jsonl` (`0600`, Error-severity refusals only, capped at 512 KiB, never rotated: once full it drops new lines) |
| One run's CA certificate | `<dir of plugins.json>/plugin-state/<id>/runs/<run id>/ca.pem` (`0600`, removed when the run ends) |

`<config dir>` and `<data dir>` are the platform directories for
`dev.OpenSesame.opensesame`. On Linux these are `~/.config/opensesame` and
`~/.local/share/opensesame`.

`opensesame plugins remove <id>` deletes `<data dir>/plugins/<id>/` and the
record. A recorded location outside that directory is reported, not deleted,
so a tampered settings file cannot aim `remove` at an arbitrary path.

## The surrogate-proxy run

`opensesame dev run --agent -- <cmd>` with the plugin active:

1. It collects the env-spec entries delivered as `Placeholder`, the
   legacy-token projections, placed in one header, and the web logins
   (below), each with the scope its env-spec entry declared ([Scope](#scope-of-a-surrogate)).
2. It spawns the plugin in its own process group and writes one JSON line to
   its stdin:
   `{run_id, ttl_secs, entries:[{env_var, provider_id, connection_ref, site, methods, path_prefixes}], logins:[{env_var, origin, action, field, secret, ca_pem?}], passthrough_hosts, watched, notices_path}`.
3. The plugin answers with one line: `{proxy_url, ca_pem_path, env, unserved}`.
   `env` carries the surrogates, the run CA's trust variables
   (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
   `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`) and the proxy variables. An entry whose
   provider this build cannot broker is listed in `unserved` and keeps its
   placeholder.
4. The child runs with that environment. It never inherits
   `OPENSESAME_STORE_PASSWORD`. Its HTTPS goes through the run's proxy, and a
   request that carries no surrogate is refused (ADR 0150 §6.1:
   un-surrogated traffic is refused by default). If the plugin can broker none
   of the entries and there is no web login, it is not used: the run keeps
   its placeholders and no proxy is set.
5. While the child runs, the plugin writes one JSON line per event:
   `{"event":"tripwire",…}` or `{"event":"login",…}` (next two sections).
6. The run ends when the child exits and the CLI closes the plugin's stdin.
   It also ends when the CLI is killed, because the kernel closes the pipe;
   when the plugin gets `SIGTERM` or `SIGINT`; or at the run's TTL. At the end
   every surrogate and login is revoked, the listener stops and the CA file is
   deleted.

### Scope of a surrogate

A surrogate is an attenuation of its connection, and ADR 0150 section 8
requires the narrowest operation scope, so a run never issues one for "any
path on the provider's host". The scope is what the env-spec entry declares:

```
GITHUB_TOKEN=opensesameConnection(conn://org/github, projection=legacy-token, paths="/repos/acme,/user", methods="GET,POST")
```

- `paths=` is a comma-separated list of absolute path prefixes. They match on
  segment boundaries (`/repos/acme` admits `/repos/acme/app`, never
  `/repos/acme-private`). It has no default.
- `methods=` names the HTTP methods the surrogate may be used with
  (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, upper case on
  the plugin's wire). A `paths=` declaration requires it, so a scope is
  complete when it is declared and a read-only run never inherits write
  verbs from a default; `paths=` without `methods=` fails the schema. An
  entry with `methods=` and no `paths=` is still unscoped and, for a served
  provider, refused by the plugin.
- The root is not a scope. A prefix that is `/`, empty, relative, or has an
  empty, `.` or `..` segment, a query, a fragment, a backslash, a semicolon,
  whitespace or a control character fails the schema (`opensesame dev
  resolve`) before any run starts. A method that is not in the list above
  fails it too. The rule is one definition,
  `spec/conformance/surrogate-scope.json`, run by the env-spec resolver and
  again by the plugin, which refuses a served entry with no methods, a method
  outside the list, or an unbounded prefix (`spec_path_scope:<ENV_VAR>`).
- An entry that declares no `paths=` is sent to the plugin with none. For a
  provider the plugin serves, the plugin refuses the whole run
  (`spec_path_scope:<ENV_VAR>`) before it binds a listener or issues
  anything, and `opensesame dev run --agent` exits non-zero naming the
  variable. It does not widen to `/`, and it does not quietly fall back to
  placeholders. A provider the plugin does not serve is unaffected: it is
  listed in `unserved` and keeps its placeholder, scope or not.
- A request outside the declared methods or prefixes is refused at the
  proxy as `surrogate.out_of_scope` before the credential tool runs, and the
  real credential is never placed on it. So is a request whose path, raw or
  percent-decoded, has a `.` or `..` segment, a backslash, a `;` or a control
  character: the proxy does not resolve those, because the upstream's reading
  of them is the one that counts. The query string is not part of the path
  and is not inspected for scope.

Every refused surrogate becomes a vetted `surrogate.*` notice line in
`notices.jsonl`, or in `tripwires.jsonl` when it is evidence (Error severity
and up, such as `surrogate.misdirected` and `surrogate.revoked`). A notice
carries the run, the provider and the fence, never the surrogate. The daemon's notices route drops any line that names the
`osr_` marker at all.

### A misdirected surrogate stops the run

The person at the terminal is watching the run, so the CLI sends
`"watched": true`. When a surrogate reaches a host that is not its
provider's (`surrogate.misdirected`), the plugin puts the run's lease through
`opensesame-session-observe`'s `tripwire_verdict`: the run is parked and
**every surrogate and login it holds is revoked at once**
(ADR 0150 §6.2). The listener keeps serving, so any later use of those
surrogates, even a correct one, is refused as `surrogate.revoked` and noticed.
The plugin then writes:

```json
{"event":"tripwire","run_id":"dev-…","fence":"surrogate.misdirected","verdict":"park","revoked":2}
```

The CLI stops the child, ends the plugin's run, says so on stderr, and exits
**77** whatever the child would have returned. A parent that sends
`"watched": false` gets the notice and no revocation.

### The Host's run lease

A Host that holds observation runs applies the same rule
(`crates/gateway/src/run_lease.rs`). Every notice published on the security
feed is read against the run it names, before any fan-out:

- a `surrogate.misdirected` for a run the Host holds parks it (suspends it
  inside the critical section), writes that under the run's version, and
  revokes through the Host's `RunCredentials`. A run someone is watching gets
  the page back. A run the Host has no row for has no lease to move, and its
  notice reaches subscribers as before;
- an `agent.*` phase in which the agent no longer drives (blocked, awaiting a
  person, control granted, completed, failed) revokes the run's credentials;
- a person taking the page (`POST /api/v1/agent/runs/{id}/control`) revokes
  them too.

The Host issues no surrogates itself, so its `RunCredentials` is the no-op
default until an embedder that does supplies one. Nothing on this path carries
a surrogate: a notice names a run and a fence only.

### Web logins

A schema entry can declare a login form an agent's browser signs in to:

```bash
APP_PASSWORD=opensesameLogin(Web/app.example, origin=https://app.example, action=/session, field=password)
```

- `Web/app.example` is a sealed-store path. Its first line is the password.
- **The entry must carry a `url:` line** (the `pass` convention), and
  `origin=` must be that URL's origin exactly. `.env.schema` sits in a working
  tree an agent can edit, so the destination of the person's password comes
  from the sealed store, never from the schema alone. A mismatch, or an entry
  with no `url:`, refuses the run.
- `ca=<file>` names a PEM certificate that replaces the public web's roots
  for that one origin, for a login site under a private CA.

With the plugin active, the CLI unlocks the sealed store as `opensesame pass
show` does (`OPENSESAME_STORE_PASSWORD`, else a hidden prompt) and reads each
declared entry. The password goes to the plugin inside the stdin line only:
never argv, never a file, never the child's environment. The child gets an
`osr_…` surrogate in `APP_PASSWORD` and types that into the form. When its
browser posts the form through the proxy, the plugin uses
`opensesame-rotation-web`'s `login-surrogate` substitution: the surrogate must
be the whole value of the one declared field of a form-encoded or JSON POST,
with identity encoding, to the exact origin and path. Then the password is
written into that field with the body format's own encoder, once. Every
response from the login origin is scrubbed of the password before the child
reads it.

| What the child sends | What happens |
|---|---|
| the declared POST with the surrogate in the declared field | substituted, sent, the response scrubbed; `{"event":"login","outcome":"substituted"}` |
| the surrogate anywhere else on that origin: another field, the query, a header | refused, `surrogate.misplaced`, a tripwire notice |
| the surrogate to another host, or over plain http | refused, `surrogate.misdirected`: the run is revoked as above |
| the declared POST a second time | refused, `surrogate.replayed`; substitution is never retried |
| a multipart, compressed or non-UTF-8 body | refused, `surrogate.unsupported`; the person signs in another way |

A field that sets a password (`new_password`, `confirm`, `autocomplete=new-password`
and the rest of `rotation-web`'s list) is never a substitution site. The run
refuses to start with `login_password_set_field`. With the plugin off, a web
login delivers nothing at all: no surrogate, no placeholder, no password.

## The boundary gate

```bash
pnpm audit:plugin-boundary   # scripts/audit/plugin-boundary-gate.sh
pnpm test:plugin-boundary    # its negative control, then the gate (part of pnpm verify)
```

The gate fails if the normal dependency tree of `opensesame-cli`, or of
`opensesame-daemon` (default features or `--features tailscale`), contains
`opensesame-surrogate-proxy`. It also fails if the daemon's tree contains
`rcgen`. The CLI already reaches `rcgen` through the Host role's PKI and ACME
(`opensesame-gateway`, `opensesame-pki-core`, `instant-acme`), so for the CLI
those are the only permitted parents, and any new path fails. The negative
control points the gate at the plugin crate itself and requires it to fail.
