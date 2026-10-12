# Linear connector controls — production browser comparisons

[Open the before/after gallery](index.html). Ten comparisons cover configuration, verified connection, issue operations and two recovery states on desktop and phone. Each linked PNG is an unchanged browser screenshot.

The revised controls use accessible icon buttons, put actor and webhook controls in their panel headers, and show failures through status marks and the existing notice tray. The actual provider adapter test confirms one tray notice for a failed request. Credential handling and provider actions retain their existing behavior.

## What the screenshots prove

Both production builds passed **363 browser checks with zero failures**. The journey uses the real UI, authorization drivers and encrypted PIN/OPFS store. It verifies independent authorization actors, reloads sealed connections, creates an issue and exercises durable webhook cleanup recovery. Both build graph checks passed with zero violations and zero artifact mismatches.

Linear provider HTTP responses are supplied by the repository protocol emulator. Displayed accounts, workspaces and issues are contract fixtures, not a live customer account. Connection states are reached through the UI and provider verification; no synthetic connection or private-state injection is used.

## Provenance

Before: production artifact and harness from `1c00ae0050ec95e6375e9e5f3668c7194317a40b`. After: production rebuild of that isolated working tree with the frozen controls patch. The checkout base is not a claim that the after build came from an unmodified commit. [The receipt](receipt.json) records the fourteen changed source hashes, all production artifact hashes, browser-log hashes and every screenshot hash. Source and artifact hashes were checked again after the browser run and remained unchanged.

Desktop CSS viewport: 1280 × 900. Phone CSS viewport: 390 × 844; screenshots retain the browser device scale. Separate runs have different token timestamps and generated fixture identifiers. The gallery scales images for display and links the original full-viewport PNGs. No images were cropped, annotated or retouched.

The earlier `2026-10-08-linear-runtime` gallery remains historical evidence for its original source. This gallery documents the later controls revision.

## Incoming main qualification

A fresh production rebuild on the published Linear base `b1fb44b78ffe27e09d4774beadd20f0610cfcdf4`, with the nine incoming source files from main `7049bc446343166ee0c2f4055c26dbb33d941562` (#818), produced **all 234 production files byte-for-byte identical** to the after artifact manifest captured above. The API-client requested-run guard is qualified by this build without changing the rendered assets. Existing browser results and all twenty raw screenshots are retained; no second capture is claimed.

The independent graph verifier again found zero violations and zero mismatches. The bundle gate passed at unchanged budgets: 5728 KiB JavaScript and 1778 KiB gzipped JavaScript. `after.incomingMainRequalification` in the receipt records the exact incoming source hashes and build, graph and budget log hashes.
