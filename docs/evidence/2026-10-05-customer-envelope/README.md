# Customer envelope encryption validation, 2026-10-05

This collection covers customer and vault key segmentation across Identity, persistence providers, browser applications, native consumers and deployment surfaces. The [surface validation matrix](../../validation/customer-envelope-surfaces.md) records completed checks and platform limits.

The [Duress browser report](duress/README.md) records nine passing kernel fixture checks and one blocked obsolete enrollment probe. Separately, the final production bundle passed all five Duress journeys within the 18-journey experience suite. Virtual authenticators and simulated PRF bytes do not establish physical hardware coverage.

Production browser evidence also includes three authentication journeys, desktop and phone device inboxes, native device lifecycle operations, encrypted desktop/phone vault sync, and 31 real Chromium key-persistence and ciphertext-negative-test groups. Loaded extensions passed one Runner storage journey plus two Host HTTP journeys, and 45 autofill journeys.

Final review found plaintext native credential payload storage beneath Multipaz SecureArea. Android and iOS now wrap every document and RPC storage consumer with customer/document/record envelopes. Five compiled portable Swift crypto tests passed; real JVM storage tests, four-ABI APK packaging, app/provider compilation and actual iOS SQLite simulator tests are required by native CI. Unknown-owner legacy mobile databases fail closed rather than being reassigned to a customer. Neither physical Keychain/Keystore custody, biometric behavior nor hardware PRF is claimed.

The latest accounts/Sphinx/include-pepper change is included. New pepper seals use random-DEK v2 envelopes with authenticated canonical account/method context; legacy v1 reads remain. All account method secrets and Sphinx private keys are protected by the independent outer vault root. A real persisted rich-account regression verifies equal IDs and passwords across separate vaults, ciphertext canary absence, and tamper/customer rejection.
