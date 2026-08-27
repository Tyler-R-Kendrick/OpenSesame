# OpenSesame native authenticator

Native OpenID4VC holder/wallet integration. Protocol code is delegated to
Multipaz 0.100.0; the web app never receives OID4VP presentations or OID4VCI
credentials. Password, OTP, and passkey provider behavior is intentionally not
part of this application.

## Android

The Android 14+ wallet entry points are under `android/`. Build with JDK 17 and
Gradle 8.13 after configuring the production wallet-attestation backend:

```bash
cd apps/authenticator-native/android
gradle :app:assembleDebug -PopensesameWalletBackendUrl=https://identity.example
```

`openid4vp`, `haip-vp`, and the Android Digital Credentials API delegate to
Multipaz presentment with an explicit consent prompt. `openid-credential-offer`
and `haip-vci` use its provisioning state machine with redirects disabled and
remote wallet attestation keys.

## Apple platforms

Run `scripts/build-core.sh ios`, then add the sources under `ios/` to the
containing app and Identity Document Provider extension targets in Xcode 26.
The app handles OID4VCI; OID4VP is fulfilled by the registered Identity
Document Provider through Apple's Digital Credentials surface. Both use the
same App Group database. Link the pinned `Multipaz` package and replace the
example App Group/team values in the entitlements.

The Rust core is the only implementation of associated-link validation and
protocol URI construction. Regenerate Kotlin and Swift bindings with
`scripts/build-core.sh bindings`; build Android libraries with
`scripts/build-core.sh android`.

Store signing identities, Apple entitlements, Android signing fingerprints,
the privileged-browser allowlist, and OIDF certification evidence are release
inputs and are intentionally not committed as development defaults.
