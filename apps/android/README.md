# OpenSesame native authenticator

Native OpenID4VC holder/wallet integration. Protocol code is delegated to
Multipaz 0.100.0; the web app never receives OID4VP presentations or OID4VCI
credentials. Password, OTP, and passkey provider behavior is intentionally not
part of this application.

## Android

The Android wallet entry points are under `android/` (`minSdk` 29, `compileSdk`
and `targetSdk` 36). Build with JDK 17 and Gradle 8.13 after configuring the
production wallet-attestation backend:

```bash
cd apps/android/android
gradle :app:assembleDebug -PopensesameWalletBackendUrl=https://identity.example
```

The JVM boundary tests exercise the generated Kotlin bindings against the
real Rust library, including rejection of a link from another associated
origin and a private-network credential request. Build the host FFI
library first, then provide its directory to JNA:

```bash
export CARGO_TARGET_DIR="$HOME/.cache/packages/cargo-target"
cargo +1.88.0 build -p opensesame-authenticator-core --features ffi
cd apps/android/android
JAVA_TOOL_OPTIONS="-Djna.library.path=$CARGO_TARGET_DIR/debug" \
  gradle :app:testDebugUnitTest -PopensesameWalletBackendUrl=https://identity.example
```

`openid4vp`, `haip-vp`, and the Android Digital Credentials API delegate to
Multipaz presentment with an explicit consent prompt. `openid-credential-offer`
and `haip-vci` use its provisioning state machine with redirects disabled and
remote wallet attestation keys.

## Apple platforms

Run `apps/android/scripts/build-core.sh ios` from the repository root, then add
the sources under `ios/` to the containing app and Identity Document Provider
extension targets in Xcode 26.
The app handles OID4VCI; OID4VP is fulfilled by the registered Identity
Document Provider through Apple's Digital Credentials surface. Both use the
same App Group database. Link the pinned `Multipaz` package and replace the
example App Group/team values in the entitlements.

The Rust core is the only implementation of associated-link validation and
protocol URI construction. Regenerate Kotlin and Swift bindings with
`apps/android/scripts/build-core.sh bindings`; build Android libraries with
`apps/android/scripts/build-core.sh android`.

Store signing identities, Apple entitlements, Android signing fingerprints,
the privileged-browser allowlist, and OIDF certification evidence are release
inputs and are intentionally not committed as development defaults.

The iOS app and document provider use the shared `WalletEnvelopeStorage` target.
Each trusted canonical backend has a separate database. Table/partition contexts
have independently random AES wrapping keys held in the shared Keychain access
group; each row uses a fresh data key and authenticates namespace, table,
partition, record key, and wrapped-key header. Both targets must use the provided
Keychain entitlements and `OpenSesameWalletKeychainGroup` Info.plist setting with
the real team prefix. Keys are available after first unlock on this device, and
are excluded from Keychain sync/backup; losing them makes the ciphertext unreadable.

The old unscoped `wallet.db` does not prove which backend owns its credentials.
It is rejected before traffic; archive/remove it and provision credentials again.
The storage adapter offers a bounded, explicitly owner-authorized migration for
known scoped legacy rows, preserving TTL via update with unchanged expiration.
Normal reads never accept plaintext. Refusal errors crossing Multipaz's pinned
suspend protocol are carried as genuine Kotlin cancellation errors (the only
exported exception type), so key loss, tampering, and contract failures cancel
the operation rather than aborting the process. A durable Keychain migration receipt prevents
legacy fallback after reopening. App/provider operations use a shared file lock;
Multipaz exposes no transactions or global table/partition enumeration.

Run `bash scripts/test/mobile-apple.sh core` from the repository root for the portable crypto
suite. The actual Multipaz bridge, app, provider, and Keychain must also compile
against iOS 26 with Xcode; Linux crypto tests do not establish iOS device behavior.

### Android credential storage

The Android wallet passes `WalletEnvelopeStorage` to every Multipaz document,
SecureArea metadata, and RPC consumer. Credential payloads (including keyless
SD-JWT bearer credentials) use fresh AES-GCM data keys. Each record's wrapping
key is independently generated in Android Keystore and cannot be exported by
this provider. Authenticated context includes the canonical HTTPS backend,
Multipaz table, document partition and final record key. Wrapping and data
ciphertexts authenticate separate purposes and the format header.

One installation is bound to one backend by an encrypted namespace receipt;
changing the backend requires re-provisioning. Unknown-owner legacy plaintext
is refused by default. A controlled migration may explicitly supply the
original, trusted backend as `legacyNamespace`; it must match the installation
backend. Migration visits at most 128 rows per page before exposing a
partition, preserves its expiration deadlines, and records completion so a
later plaintext downgrade is rejected. Missing platform keys or receipts fail
closed. Do not infer a legacy customer's identity from an untrusted database.

JVM tests use real AES-GCM and the pinned Multipaz storage implementation to
exercise envelope isolation, restart, migration and the storage contract. They
do not establish Android Keystore behavior on physical hardware. One wrapping
key per record increases the number of Keystore aliases; deployment testing
must account for wallet size and platform storage limits.

Run `bash scripts/test/mobile-android.sh` from the repository root to build the
host FFI library, execute the real JVM tests, and assemble the APK. Supply
`OPENSESAME_NATIVE_FFI_DIR` to reuse an existing host library. CI also builds
actual Android JNI libraries with `apps/android/scripts/build-core.sh android`; host JVM
FFI tests do not establish Android ABI or device behavior.
