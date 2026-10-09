# Device / headless authentication

RFC 8628 device authorization is implemented via `oidc-provider` (`/device/auth`). OpenSesame keeps a separate domain projection for policy, UI, and audit.

## CLI (`opensesame-id`)

```bash
opensesame-id login               # device flow (no flag selects it too)
opensesame-id login --loopback    # RFC 8252 loopback redirect
opensesame-id login --device
opensesame-id login --no-browser  # same as --device
opensesame-id login --anonymous   # provisional guest session (alias --guest)
opensesame-id auth status
opensesame-id whoami
opensesame-id logout
```

Binary is `opensesame-id` so it does not collide with the Rust authority CLI `opensesame`.

## Environment matrix

| Environment | Preferred flow |
|-------------|----------------|
| Local desktop | Loopback (RFC 8252): `login --loopback`; the CLI never picks it for you |
| Dev container / Codespaces / SSH | Device (`--device` / `--no-browser`, also what plain `login` runs) |
| CI | Client credentials (a server-side grant in `packages/oauth-provider`); `opensesame-id login` is not a CI flow |

`opensesame-id` never prints a token; `--json` output is redacted. The session
is `identity-session.json`, owner-only (0600) and sealed under an `identity-session.key`
beside it, in `OPENSESAME_STATE_DIR`, else `XDG_RUNTIME_DIR`, else
`~/.config/opensesame`. A session file others can read or write is refused.
