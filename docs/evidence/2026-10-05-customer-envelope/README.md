# Customer envelope encryption validation, 2026-10-05

This collection covers customer and vault key segmentation across Identity, persistence providers, browser applications, native consumers and deployment surfaces. The [surface validation matrix](../../validation/customer-envelope-surfaces.md) records completed checks and platform limits.

The [Duress browser report](duress/README.md) records nine passing kernel fixture checks and one blocked obsolete enrollment probe. Separately, the final production bundle passed all five Duress journeys within the 18-journey experience suite. Virtual authenticators and simulated PRF bytes do not establish physical hardware coverage.

Production browser evidence also includes three authentication journeys, desktop and phone device inboxes, native device lifecycle operations, encrypted desktop/phone vault sync, and 31 real Chromium key-persistence and ciphertext-negative-test groups. Loaded extensions passed one Runner storage journey plus two Host HTTP journeys, and 45 autofill journeys.

Android APK compilation and three JVM association tests passed; the APK still needs the Android ABI authenticator library and device runtime validation. The iOS package requires Xcode 26 and iOS 26, unavailable in this Linux environment. Neither physical biometric custody nor hardware PRF is claimed.

The latest accounts/Sphinx/include-pepper change is included. New pepper seals use random-DEK v2 envelopes with authenticated canonical account/method context; legacy v1 reads remain. All account method secrets and Sphinx private keys are protected by the independent outer vault root. A real persisted rich-account regression verifies equal IDs and passwords across separate vaults, ciphertext canary absence, and tamper/customer rejection.
