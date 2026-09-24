# Device / headless authentication

RFC 8628 device authorization is implemented via `oidc-provider` (`/device/auth`). OpenSesame keeps a separate domain projection for policy, UI, and audit.

## CLI (`opensesame-id`)

```bash
opensesame-id login
opensesame-id login --loopback
opensesame-id login --device
opensesame-id login --no-browser
opensesame-id auth status
opensesame-id logout
opensesame-id logout --all
```

Binary is `opensesame-id` so it does not collide with the Rust authority CLI `opensesame`.

## Environment matrix

| Environment | Preferred flow |
|-------------|----------------|
| Local desktop | Loopback (RFC 8252) when browser + bind succeed |
| Dev container / Codespaces / SSH | Device (`--device` / `--no-browser`) |
| CI | Workload identity / client credentials (future); not human device flow |

Never print device codes or tokens in `--verbose` logs. Prefer OS keychain; in containers use short-lived tokens and `0600` DPoP keys under `$XDG_RUNTIME_DIR`.
