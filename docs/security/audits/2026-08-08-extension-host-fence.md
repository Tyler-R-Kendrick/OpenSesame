# Security audit — extension Host API loopback fence — 2026-08-08

Branch: `chore/audit-tick30`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep | CLEAN |
| battle-test / task-security-battle-test | CLEAN |
| Residual review | Browser extension used stored `hostApiBase` verbatim |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | The popup wrote any string to `chrome.storage.local.hostApiBase` and the background service worker used it verbatim as the API base, so a rewritten value could repoint the extension at a remote Host API (or a credential-bearing URL) | New `normalizeLoopbackBaseUrl` in `@opensesame/api-client`; popup rejects non-loopback input with a hint and background falls back to `http://127.0.0.1:8787` |
| Build | `wxt build` failed on `main` — esbuild refuses the DPoP `const { kty, crv, x, y } = jwk` destructuring at the extension's `firefox78` target, so the extension could not be built at all | Explicit property reads in `createDpopKeyPair` |

The fence matches the daemon/gateway bind policy: loopback only, no credentials
in the URL, no query/fragment smuggling. `host_permissions` already limited
network reach to loopback; this closes the config path that pointed elsewhere.

## Gate

```bash
pnpm --filter @opensesame/api-client test
pnpm --filter @opensesame/api-client typecheck
pnpm --filter @opensesame/browser-extension build
./scripts/battle-test.sh
```
