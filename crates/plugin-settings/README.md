# opensesame-plugin-settings

The catalog of optional runtime plugins, the one settings file that switches
them on, and the install-time sha256 pins checked at every launch
([ADR 0150](../../docs/adr/0150-surrogate-credentials-at-the-last-hop.md) §7).
Nothing a plugin does is in a default build: Settings and
`opensesame plugins enable` both write the file this crate reads, and a plugin
stays off until one of them records it on.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli) (`opensesame plugins …`),
  [`crates/daemon`](../../crates/daemon) (it reads the file to answer Settings
  and issues plugin pairings, and never links a plugin),
  [`opensesame-surrogate-proxy`](../surrogate-proxy) (its install gate and the
  login-form switch), [`opensesame-rotation-web`](../rotation-web) (behind its
  `login-surrogate` feature) and [`opensesame-tailnet-admin`](../tailnet-admin)
  (the pairing-origin rule).
- **Builds on:** no workspace crates.
- A plugin missing from the file, or recorded `enabled: false`, is off.
  `OPENSESAME_PLUGIN_<ID>` can only turn a plugin off for a process; no value
  turns one on.
- A binary's recorded sha256 is recomputed before it runs; a mismatch is a
  refusal, never a warning.

## Surface

| Area | Items |
|---|---|
| Catalog | `catalog`, `CatalogPlugin`, `PluginKind` |
| Settings | `PluginSettings`, `PluginState`, `InstalledPlugin`, `default_settings_path`, `settings_path_from`, `sha256_file`, `SettingsError` |
| Pairings | `PluginPairings`, `Issued`, `PairedView`, `PendingView`, `PairingError`, `format_pairing_code`, `is_pairable_origin`, `is_secret_shaped` |
| Paths | `plugin_state_dir`, `notices_path`, `tripwires_path` |

| Cargo feature | Effect |
|---|---|
| `path-override` | Honours `OPENSESAME_PLUGINS_FILE`. Test builds only: a shipped build reads `<config dir>/plugins.json` and nothing an environment can name |

## Develop

```bash
cargo +1.88.0 test -p opensesame-plugin-settings
pnpm audit:plugin-boundary   # no default `opensesame` or daemon tree reaches a plugin crate
```

## Related

- [ADR 0150](../../docs/adr/0150-surrogate-credentials-at-the-last-hop.md) — surrogate credentials at the last hop (§7 optional plugins)
- [ADR 0048](../../docs/adr/0048-capability-moded-connector-discovery.md) — the daemon dependency budget this crate sits inside
- [`docs/operators/plugins.md`](../../docs/operators/plugins.md)
