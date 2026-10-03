# Optional plugins

Some features are advanced, and most people will never use them. They are not
in the default `opensesame` binary, the daemon or the Pages bundle. Each one is
a **plugin**: a separate artifact a person installs at runtime, pinned by
sha256, recorded **off**, and run only once switched on
([ADR 0150](../adr/0150-surrogate-credentials-at-the-last-hop.md) §7).

The catalog is [`spec/plugins/catalog.json`](../../spec/plugins/catalog.json):

| Plugin | Kind | What it adds | Settings capability |
|---|---|---|---|
| `surrogate-proxy` | native binary `opensesame-surrogate-proxy` | `opensesame dev run --agent` hands a child `osr_…` surrogates instead of placeholders, redeemed at the last hop (ADR 0150 §6.1) | `agents.surrogate-credentials` |
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

Settings does the same through the daemon's operator routes. They take the
operator token, or the Unix-socket peer check, and refuse a browser origin:

```text
GET  /v1/plugins                 -> {"plugins":[PluginState,…]}   catalog order
PUT  /v1/plugins/{id}            {"enabled":bool} -> PluginState
                                  | 404 {"error":"not_installed"} | 400 {"error":"unknown_plugin"}
GET  /v1/plugins/{id}/notices    -> {"notices":[{event_type,severity,occurred_at,summary,subject_id?}]}
```

Enabling a plugin that is not installed fails, and says how to install it.
Enabling a native plugin re-checks its pin first. A file that changed since
install is left off.

## Forcing a plugin off

`OPENSESAME_PLUGIN_<ID>=off` turns a plugin off for any process that sees it,
whatever the settings file says. `<ID>` is the id uppercased, with `-` changed
to `_`, for example `OPENSESAME_PLUGIN_SURROGATE_PROXY=off`. The values `off`,
`0`, `false`, `no` and `disabled` all count. **No value turns a plugin on.** An
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
| Settings file (which plugins are installed, pinned, on) | `<config dir>/plugins.json`, or `OPENSESAME_PLUGINS_FILE` |
| Installed native plugin | `<data dir>/plugins/<id>/<version>/<binary>`, or under `OPENSESAME_PLUGINS_DIR` |
| Installed extension package | `<data dir>/plugins/<id>/<version>/<id>.zip` |
| Plugin state: notices | `<dir of plugins.json>/plugin-state/<id>/notices.jsonl` (`0600`, capped at 1 MiB, rotated once to `notices.jsonl.1`) |
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
   legacy-token projections, placed in one header.
2. It spawns the plugin in its own process group and writes one JSON line to
   its stdin:
   `{run_id, ttl_secs, entries:[{env_var, provider_id, connection_ref, site, methods, path_prefixes}], passthrough_hosts, notices_path}`.
3. The plugin answers with one line: `{proxy_url, ca_pem_path, env, unserved}`.
   `env` carries the surrogates, the run CA's trust variables
   (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
   `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`) and the proxy variables. An entry whose
   provider this build cannot broker is listed in `unserved` and keeps its
   placeholder.
4. The child runs with that environment. Its HTTPS goes through the run's
   proxy, and a request that carries no surrogate is refused (ADR 0150 §6.1:
   un-surrogated traffic is refused by default). If the plugin can broker none
   of the entries, it is not used: the run keeps its placeholders and no proxy
   is set.
5. The run ends when the child exits and the CLI closes the plugin's stdin.
   It also ends when the CLI is killed, because the kernel closes the pipe;
   when the plugin gets `SIGTERM` or `SIGINT`; or at the run's TTL. At the end
   every surrogate is revoked, the listener stops and the CA file is deleted.

Every refused surrogate becomes a vetted `surrogate.*` notice line in
`notices.jsonl`. A notice carries the run, the provider and the fence, never
the surrogate. The daemon's notices route drops any line that names the
`osr_` marker at all.

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
