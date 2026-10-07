# OpenSesame native authenticator

Native OpenID4VC holder/wallet integration. Protocol code is delegated to
Multipaz 0.100.0; the web app never receives OID4VP presentations or OID4VCI
credentials. Password, OTP, and passkey autofill-provider behavior is intentionally not
part of this application; its local application admission gate is separate.

Password workflow parity is available to mobile users in the browser or
installed PWA. Native authenticator apps have neither the PWA vault nor a
native password-provider session and do not claim those operations; see
[ADR 0177](../../docs/adr/0177-password-workflow-surface-boundaries.md).

## Android

The Android 14+ wallet entry points are under `android/`. Build with JDK 17 and
Gradle 8.13 after configuring the production wallet-attestation backend:

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

`ios/project.yml` generates the actual application, ExtensionKit document
provider, and hosted unit/UI test targets with XcodeGen 2.44.1. Run
`pnpm test:apple` on macOS with Xcode 26+ to build the Rust XCFramework, compile
both Apple targets against the device SDK, and run their simulator tests.
The app handles OID4VCI; OID4VP uses the Identity Document Provider through
Apple's Digital Credentials surface. Both use the same App Group database and
Keychain access group. Configure `OPENSESAME_DEVELOPMENT_TEAM`,
`OPENSESAME_APP_GROUP`, `OPENSESAME_KEYCHAIN_GROUP`,
`OPENSESAME_INVOCATION_HOST`, and `OPENSESAME_WALLET_BACKEND_URL` as Xcode build
settings for the registered production application.

The Rust core is the only implementation of associated-link validation and
protocol URI construction. Regenerate Kotlin and Swift bindings with
`scripts/build-core.sh bindings`; build Android libraries with
`scripts/build-core.sh android`.

Store signing identities, Apple entitlements, Android signing fingerprints,
the privileged-browser allowlist, and OIDF certification evidence are release
inputs and are intentionally not committed as development defaults.

## Security → Decoy → Retired passwords

The native wallet now has a separate, opt-in **local application password** gate.
Real admission always also requires a fresh OS device-owner prompt. This password
controls access to the app's production runtime; it does **not** replace the
Multipaz secure-area keys, re-encrypt `wallet.db`, revoke issuer credentials, or
protect a stolen old wallet snapshot. Issuer authorization codes remain issuer
inputs and never participate in retired-password matching.

After unlocking with OS owner verification, open Security to set a unique
application password. The owner can rotate it, explicitly enroll up to three
selected retired passwords, remove individual traps, and clear local evidence.
Management requires both the current application password and fresh OS owner
verification. Android 10 uses the OS device-credential confirmation activity;
Android 11+ uses strong biometrics or the device credential. Enrollment discloses and requires acceptance of the verifier's
new offline-guessing exposure. Record-and-reject is the default; synthetic decoy
routing is optional. All matches use the shared Rust human-vault implementation:
exact UTF-8, salted Argon2id, 64 MiB, three passes, one lane. Evidence retains up
to 32 closed metadata events, never submitted passwords or external content.

Android stores the gate record encrypted with a non-exportable Android Keystore
AES-GCM key, outside backed-up storage. Apple stores it as
`WhenUnlockedThisDeviceOnly` Keychain data in the explicit shared access group.
The generated project includes `NativeGateStorage.swift` in both targets,
registers the document-provider extension point, and includes the Face ID usage
description. Both signed targets must have the matching Keychain access-group
entitlement. A storage or authentication error fails closed.

Real and synthetic sessions have separate typed admission states. Synthetic
wallet contents are fixed examples (`example.invalid`) and never initialize
Multipaz storage, attestation RPC, provisioning, or presentation. Locking
invalidates retained real permits; moving from synthetic to real requires a new
password admission and new OS verification. Android production HTTP/RPC and
presentment callbacks check the real admission generation, including response
handback. Provider entry points cannot initialize a production wallet from a
cold, locked, or synthetic application state. Apple document presentation
requires fresh OS verification and a single-use 30-second grant issued by the
just-authenticated application (including its password, when configured); app
locking invalidates its generation. Only user-authenticated signing domains are
eligible for native presentation; keyless/no-user-auth domains are excluded.

Evidence is local and best effort. A retired match can be stale legitimate
input, and does not label a person an attacker. Native traps never invoke
freeze, wipe, incident fencing, or external notification. A source/storage
inspector may recognize or bypass local deception; these are signed-app
admission boundaries, not honey encryption or a defense against a compromised OS.

## Windows native CLI boundary

Windows trap and credential-observation persistence are implemented in the
unreleased source. The required `windows-2022` / MSVC Rust 1.88 CI family selects
89 exact named Rust cases: 77 engine/storage/FFI cases and 12 CLI cases, including
real ConPTY owner-management journeys. It also requires all 40 generated JVM/FFI
cases against the actual Windows DLL and compilation of the full native CLI.
These are authored validation requirements, not an assertion that this source
has passed Windows execution. Run `pnpm test:windows:engine`,
`pnpm test:windows:ffi`, and `pnpm test:windows:cli` on a Windows host; the FFI
phase needs JDK 21, Gradle 8.13 and Android SDK 36. Host-DLL validation does not
establish Android emulator behavior.

The common Windows adapter covers key, entry, rotation and detector operations:
ancestor handles deny deletion, reparse points and path aliases are rejected,
files receive protected owner/SYSTEM/admin ACLs, `LockFileEx` provides
nonblocking cross-process locking, and publication renames an exact open source
handle into a pinned destination. Storage must use an absolute path on a local
fixed NTFS volume with private directory permissions. Broad grants, including
directory READ/LIST, hardlinks, remote volumes and junctions fail closed.
Ordinary OS ancestors remain traversable while pinned handles prevent reparse
and rename races. Trap management still requires fresh current-owner proof;
retired credentials admit only the selected rejection or synthetic realm.

The independent random 32-byte detector key is sealed with current-user DPAPI
using a fixed application purpose and the canonical stable vault identity.
It is not derived from the real root or password. The private, bounded,
versioned key file has no plaintext fallback or automatic reset. Missing keys,
tampering and identity/profile mismatches fail closed for detection without
changing real-vault authority. Cross-profile/OS backup portability, protection
against the same OS principal or administrator, and snapshot rollback prevention
are not guaranteed; recovery depends on the original usable profile/state or a
separately reviewed authenticated restore procedure.

Required Windows controls retain ACL, junction, hardlink, contention, process
termination and atomic-publication checks, and exercise positive enrollment,
no-trap owner admission, safely restored same-context snapshots, owner recovery,
DPAPI refusal and genuine terminal management. Merge and release require the
complete native campaign on the exact final source SHA, including actual
Windows, Android device and Apple SDK execution. Linux MSVC typechecking is
compile evidence only. Signed release configuration and physical Keystore,
SecureEnclave and cross-process provider validation remain separate requirements.

## Verification

Regenerate the committed Kotlin/Swift FFI from the actual Rust exports before
building either platform:

```bash
pnpm test:core
pnpm test:android
pnpm test:swift
pnpm test:apple # macOS, Xcode 26+, XcodeGen 2.44.1 and an iOS 26+ simulator
```

The Rust tests exercise real Argon2id classification, password rotation,
reject/decoy responses, management refusal, collision refusal, metadata redaction,
and corrupted-context rejection. Kotlin/JUnit and Swift/Testing exercise cold
start denial, no synthetic privilege upgrade, invalidation of old permits, and
cancelled-owner-prompt races. The Swift state machine also has a Linux-runnable
behavioral check against the exact production source. Both Kotlin and Swift
behavioral checks execute the generated FFI against the actual host Rust
library, including rotation, retired matching, synthetic classification, denied
authority evidence, and fresh owner recovery. The Android command also builds
all four JNI architectures and assembles the SDK package. It requires Gradle
8.13, Android SDK 36, NDK 28.2.13676358, cargo-ndk 4.1.2, and the four Android
Rust targets. The Swift command requires Swift 6.2 and runs on Linux or macOS;
it does not compile the Apple UI/provider targets. Native admission CI runs
these checks, actual Apple SDK builds and simulator tests, and Android device
instrumentation on both 4-KiB and 16-KiB page-size API 35 emulators. Device tests
exercise the actual Rust/JNA classifier, Keystore encryption and corruption,
owner-prompt cancellation and successful PIN verification, synthetic denial at
both providers, and stale owner-result refusal. Test fixtures exist only in the
instrumentation APK; the app has no successful-authentication test bypass.
The package gate checks all four Rust ABIs, ZIP alignment, and every packaged
64-bit native library's 16-KiB ELF LOAD alignment. Apple SDK tests exercise the
actual Keychain accessibility policy, compare-and-swap refusal, cold provider
denial, expiring grants, concurrent single-use consumption, and UI admission
failure when the simulator has no enrolled owner factor.

Release validation must additionally exercise production issuer callbacks,
active presentation cancellation during lock, signed cross-process Apple
storage on a provisioned physical device, and device recovery. Simulator builds
are unsigned SDK validation and cannot establish production entitlement or
signing correctness.

## Signed release gates

Android release packaging fails without a production HTTPS wallet backend and
all four signing environment inputs: `OPENSESAME_ANDROID_KEYSTORE`,
`OPENSESAME_ANDROID_KEYSTORE_PASSWORD`, `OPENSESAME_ANDROID_KEY_ALIAS`, and
`OPENSESAME_ANDROID_KEY_PASSWORD`. Supply these from the operator's protected
release environment, then build with `gradle :app:assembleRelease
-PopensesameWalletBackendUrl=https://your-wallet-backend`.
Run `bash scripts/verify-android-release.sh signed-release.apk REGISTERED_SHA256`
against the actual output. It verifies the registered signer, rejects debug
signing/debuggable packages, and repeats the native packaging checks.

Build/archive the generated Apple scheme with the operator's registered team,
production settings, and distribution profiles. Run
`python3 scripts/verify-apple-release.py path/to/OpenSesameNative.app --team TEAMID
--app-group GROUP --keychain-group GROUP --backend https://your-wallet-backend
--invocation-host your-associated-domain` on macOS. It verifies the actual app
and embedded provider signatures, unexpired distribution profiles, shared
storage entitlements, extension registration, and embedded production settings.
Association files, registered signing identities, backend availability, real
issuer interoperability, and OIDF certification remain operator release inputs;
an unsigned CI build does not certify them.

## Controlled canaries and optional observation delivery

Security → Decoy also manages detection-only controlled connection references and
MCP configurations. Creating a controlled MCP canary exports its once-issued
identifier, public validator binding and runnable `opensesame-id` configuration.
Save an owner-private file, then explicitly install it with
`opensesame-id canary install --config FILE --trust-configuration`. The detector
runs independently of the mobile wallet and records actual connections/tool
calls; merely reading the configuration is not observable. Removing the mobile
record does not remove an independently installed detector: uninstall it
separately with `opensesame-id canary uninstall --config FILE`.

Optional receiver pairing uses independent detection key material protected by
Android Keystore or device-only Apple Keychain. The owner approves a fixed
receiver origin, tests authenticated sealed delivery, then explicitly enables
it. Only closed observation metadata is sent. Passwords, real wallet keys,
production credentials, cookies and connector sessions are excluded. A genuine
ACK must match the current binding and, for an owner test, the complete original
owner policy. Password/protector changes or revocation invalidate held test
ACKs. Removing or disabling delivery drops unsent packages while retaining the
abuse budget; requests already emitted cannot be recalled. Offline packages
remain bounded and are retried on later observation or application activity.

Retired issuer generations require an operator-installed provider that
independently authenticates the actual Host and atomically revokes its issued
UUID before returning validated digest-only metadata. Local device/password
proof does not authorize the Host. Mobile defaults show this operation as
unavailable until such a provider is installed; arbitrary vendor strings or
owner-supplied digests are never accepted as issuance evidence. The Apple
`WalletView`/`WalletAdmission` constructor and Android installed-provider port
supply this explicit integration boundary without inheriting production
connector authority.

Apple validation now runs three isolated simulator phases: sixteen real-framework
checks plus the original cold-owner refusal, a visible retired-password lifecycle,
and a visible controlled-canary lifecycle. The positive journeys use production
screens and `LAContext`; a private XCTest-only localhost fixture posts the same
simulator sensor notifications as Simulator's Features menu after deliberate UI
actions. It never supplies application grants, protected records or passwords.
The runner verifies all twenty-eight exact successful case identities and zero skips
from actual XCResult metadata. Linux syntax/parser checks do not establish Apple
SDK execution; physical biometrics, signed providers and configured production
backends still need their own release proof.
The two additional SDK lifecycle cases require a fresh production Secure Enclave
factory to bind each owner's guarded storage, and a held SQLite/encrypted-storage
operation to refuse late writes after lock. Simulator signing uses a persisted
SoftwareSecureArea key only as an explicit test control. Production always uses
SecureEnclaveSecureArea; physical Secure Enclave signing requires separate device
proof. These new cases are authored requirements pending Apple SDK execution.
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

The required native-admission workflow runs all 40 named JVM cases, thirteen
owner-factor device cases on each page size, and 28 Apple simulator cases:
16 admission/descendant checks, four SQLite envelope checks, five envelope
crypto checks, and three visible UI journeys. Counts describe required tests,
not an assertion that the current integrated source has passed hosted execution.
The portable Swift job also requires all five named envelope crypto tests.

The Swift package exposes the wallet application and envelope storage products.
The document provider is built by the actual Xcode project, where its source and
shared admission guards form one extension target; it is not a duplicate SwiftPM
target sharing the application's internal source files. The mandatory Apple SDK
job builds that extension, then runs the storage and admission tests together.
XcodeGen supplies both targets' explicit envelope Keychain group setting; release
signing still needs the operator's registered team and matching entitlements.
