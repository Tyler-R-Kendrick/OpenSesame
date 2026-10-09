# Native connector configuration evidence

Two production builds, the same sealed-vault journey, and unchanged full viewport captures. The before build is `2703ee77094f66e1833de2f141f9af55c7f23224`; the after build is the native connector integration. Configuration comparisons make no upstream requests and contain no invented accounts. The final after captures and protocol checks use immutable build9, whose canonical manifest digest is `3ebc65f2c2105073f32c88acaedd24c487e50b2699b4aaeea837c354ed749d95`.

The source contains 225 provider identities. Its catalog policy draws exactly 160 tiles in Add a connection; the remaining 65 identities are reviewed through Settings routes. At desktop 1366 × 1000 and phone 390 × 844, the production browser suite checks the exact canonical IDs, explicit catalog refusals, and every offered provider configuration page.

## Configuration comparisons

Each sheet shows the actual before and after builds side by side. Measurements are read from the browser in CSS pixels. Phone screenshots use device scale factor 3; their CSS viewport remains 390 × 844.

### Algolia configuration — 1366 × 1000

Before credential input: 480 × 32. After browser control measurements: `319x44 @281,259 | 13x13 @296,276 | 480x34 @280,340 | 480x53 @280,413 | 480x34 @280,625 | 480x34 @280,696 | 640x40 @280,780`.

![Algolia configuration — 1366 × 1000](desktop-algolia-configure.png)

### Datadog configuration — 1366 × 1000

Before: generic credential/registration fields. After: actual supported-method availability and provider guidance. Browser control measurements: `319x44 @281,259 | 13x13 @296,276`.

![Datadog configuration — 1366 × 1000](desktop-datadog-configure.png)

### Railway configuration — 1366 × 1000

Before: generic credential/registration fields. After: actual supported-method availability and provider guidance. Browser control measurements: `319x44 @281,259 | 13x13 @296,276`.

![Railway configuration — 1366 × 1000](desktop-railway-configure.png)

### Linq configuration — 1366 × 1000

Before: generic credential/registration fields. After: actual supported-method availability and provider guidance. Browser control measurements: `319x44 @281,259 | 13x13 @296,276`.

![Linq configuration — 1366 × 1000](desktop-linq-configure.png)

### Algolia configuration — 390 × 844

Before credential input: 330 × 44. After browser control measurements: `178x44 @17,332 | 13x13 @32,349 | 358x44 @16,412 | 358x53 @16,495 | 358x44 @16,729 | 358x44 @16,809 | 358x44 @16,926`.

![Algolia configuration — 390 × 844](phone-algolia-configure.png)

### Datadog configuration — 390 × 844

Before: generic credential/registration fields. After: actual supported-method availability and provider guidance. Browser control measurements: `178x44 @17,332 | 13x13 @32,349`.

![Datadog configuration — 390 × 844](phone-datadog-configure.png)

### Railway configuration — 390 × 844

Before: generic credential/registration fields. After: actual supported-method availability and provider guidance. Browser control measurements: `178x44 @17,332 | 13x13 @32,349`.

![Railway configuration — 390 × 844](phone-railway-configure.png)

### Linq configuration — 390 × 844

Before: generic credential/registration fields. After: actual supported-method availability and provider guidance. Browser control measurements: `178x61 @17,332 | 13x13 @32,357`.

![Linq configuration — 390 × 844](phone-linq-configure.png)

### Vault configuration — 1366 × 1000

Before credential input: 480 × 32. After browser control measurements: `319x44 @281,259 | 13x13 @296,276 | 480x34 @280,340 | 640x79 @280,387 | 480x53 @280,413 | 480x34 @280,625 | 480x34 @280,732 | 480x34 @280,839 | 640x40 @280,959`.

![Vault configuration — 1366 × 1000](desktop-vault-configure.png)

### Keepass configuration — 1366 × 1000

Before: generic credential/registration fields. After: actual supported-method availability and provider guidance. Browser control measurements: `319x44 @281,259 | 13x13 @296,276`.

![Keepass configuration — 1366 × 1000](desktop-keepass-configure.png)

### Vault configuration — 390 × 844

Before credential input: 330 × 44. After browser control measurements: `178x61 @17,382 | 13x13 @32,408 | 358x44 @16,479 | 358x79 @16,536 | 358x53 @16,562 | 358x44 @16,842 | 358x44 @16,958 | 358x44 @16,1073 | 358x44 @16,1226`.

![Vault configuration — 390 × 844](phone-vault-configure.png)

### Keepass configuration — 390 × 844

Before: generic credential/registration fields. After: actual supported-method availability and provider guidance. Browser control measurements: `178x61 @17,332 | 13x13 @32,357`.

![Keepass configuration — 390 × 844](phone-keepass-configure.png)

## Browser receipt

[Final production receipt](browser-receipt.json): **3,150 assertions passed**, zero unexpected browser errors, zero hosted Connect requests, and a real competing-edit stale revision refusal. The receipt pins the immutable production build and complete test receipt SHA-256 digests.

## Actual provider protocol journeys

These screenshots come from the production application after human configuration, a fixed provider HTTP verification request, and an encrypted save. The authority returns documented synthetic responses and synthetic credentials. This proves the browser protocol and UI contract, **not access to a live provider account**. No application state or DOM is replaced.

Direct credential routes exercised: algolia, anthropic, gemini, notion. Each rejects HTTP 401 before accepting the documented response, clears private fields on verified save, survives encrypted cold reload, performs Check access with its sealed credential, and stays absent after local removal and another encrypted cold reload. Other representative routes preserve supported alternatives or explicitly refuse unavailable methods without collecting a password or sending provider verification requests.

Self-hosted Vault and OpenBao use the actual lookup-self headers and namespace/token binding, preserve verified facts through encrypted reload, and remove locally without revoking the provider token.

Two actual tabs submit competing changes. The losing tab reports its stale revision refusal; cold verification proves that the winning public name and sealed credential remain paired. Unexpected browser, asset, console, HTTP and hosted Connect requests remain failures.

### Algolia verified — desktop

![Synthetic documented protocol verification — algolia, desktop](desktop-algolia-verified.png)

### Algolia verified — phone

![Synthetic documented protocol verification — algolia, phone](phone-algolia-verified.png)

### Vault verified — desktop

![Synthetic documented protocol verification — vault, desktop](desktop-vault-verified.png)

### Vault verified — phone

![Synthetic documented protocol verification — vault, phone](phone-vault-verified.png)

### Gemini verified — desktop

![Synthetic documented protocol verification — gemini, desktop](desktop-gemini-verified.png)

### Gemini verified — phone

![Synthetic documented protocol verification — gemini, phone](phone-gemini-verified.png)

See the separate [public OAuth and MCP protocol gallery](../2026-10-09-native-public-protocol/README.md) for GitLab authorization, Adobe MCP consent, tool invocation and provider cleanup.

## Reproduce

```bash
VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
PLAYWRIGHT_CHROMIUM=/usr/bin/chromium VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages verify:native-connectors
PLAYWRIGHT_CHROMIUM=/usr/bin/chromium VITE_BASE=/OpenSesame/ node apps/pages/scripts/capture-evidence.mjs capture after docs/evidence/2026-10-09-native-connectors/native-connectors-journey.json
PLAYWRIGHT_CHROMIUM=/usr/bin/chromium node apps/pages/scripts/capture-evidence.mjs compose docs/evidence/2026-10-09-native-connectors/native-connectors-journey.json
```

Capture `before` with `EVIDENCE_DIST` pointing to a separate build of the base commit. Preserve that genuine base capture while capturing `after`.
