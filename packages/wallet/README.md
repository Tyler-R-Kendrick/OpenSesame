# @opensesame/wallet

Wallet passes for cross-device interactions: a vendor-neutral
`WalletPassProvider` boundary and one real adapter, Google Wallet Generic
Passes. A pass's barcode is an opaque interaction reference or the launcher
URL. Scanning it says which question is being asked and authorizes nothing,
because a pass must be assumed public and permanent. The package is
presentation only: optional, never on the approval path, and never a card or
spending ledger.

## Where it fits

- **Used by:** [`apps/control-plane`](../../apps/control-plane) — wallet registration routes and service, `repos/durable-wallet-registration-store.ts`, and `create-wallet-native-mounts.ts`, which builds the launcher provider from the process environment.
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (`InteractionKind`), `jose` (Save-to-Wallet JWTs).
- A provider is handed an already-minted `interactionRef` and its canonical URL — never a token, a session or the subject behind it.
- `assertPassPayloadSafe` runs on every issue and every REST mutation, deny-first, over the serializer's own output. `WalletPayloadRejected` names the rule and path and never quotes a value.
- A launcher's public object (signed into the Save JWT) has no field a secret could occupy; the rotating-barcode TOTP seed is attached only over the authenticated REST channel.
- Capabilities are reported, not assumed: a caller asks whether revocation or updates exist before promising a person anything.

## Surface

| Area | Exports |
|---|---|
| Provider boundary | `WalletPassProvider` (`capabilities`, `issuePass`, `updatePass?`, `revokePass?`), `NullWalletProvider`, `createWalletProvider(env)` |
| Google adapter | `createGoogleWalletProvider`, `createGoogleClient`, `buildGenericClass`, `buildGenericObject` |
| Launcher passes | `WalletLauncherProvider` (`issueLauncher`, `provisionRotatingBarcode?`, `disableLauncher?`), `createWalletLauncherProvider`, `createGoogleLauncherProvider`, `NullLauncherProvider`, `buildLauncherPublicObject`, `assertLauncherPublicSafe` |
| Registrations | `WalletRegistrationStore`, `InMemoryWalletRegistrationStore`, `WalletRegistrationConflictError` |
| Payload gate | `assertPassPayloadSafe`, `WalletPayloadRejected` |
| Configuration | `parseGoogleWalletConfig`, `GOOGLE_WALLET_ENV`, `WalletConfigError` |

Configuration reads `OPENSESAME_WALLET_GOOGLE_ISSUER_ID`, `_CLASS_ID`,
`_SERVICE_ACCOUNT_EMAIL`, `_SERVICE_ACCOUNT_KEY`, `_PUBLIC_BASE_URL` and
`_ORIGINS`. With none set the wallet is off and the null provider says so; a
half-configured wallet throws at startup.

## Develop

```bash
pnpm --filter @opensesame/wallet test
pnpm --filter @opensesame/wallet typecheck
```

## Related

- [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — the wallet-native interaction layer (§5, passes)
- [ADR 0119](../../docs/adr/0119-wallet-native-control-plane-composition.md) — wallet-native control-plane composition
- [ADR 0123](../../docs/adr/0123-wallet-spending-authority.md) — keeps this package presentation-only
- [Wallet interaction traceability](../../docs/validation/wallet-interaction-traceability.md)
