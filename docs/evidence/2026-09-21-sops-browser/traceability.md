# SOPS browser engine — traceability ledger

Ledger columns follow the deliverable contract in
`docs/archive/prompts/vault-key-protection-age-sops-prompt.md` § Required deliverables:

```text
requirement_or_test_id | production_file_and_symbol | owning_swarm
verification_command_and_test_id | result | artifact_reference | limitation
```

Result vocabulary is `passed | failed | blocked` — never "covered".

| requirement_or_test_id | production_file_and_symbol | owning_swarm | verification_command_and_test_id | result | artifact_reference | limitation_or_blocked_reason |
|---|---|---|---|---|---|---|
| SB-010 YAML/JSON round-trip | `apps/pages/src/lib/sops/engine.ts` (`encryptSopsDocument`, `decryptSopsDocument`) | INTEROP | `pnpm verify:sops-browser` → `engine.test.ts` "round-trips YAML and JSON" | passed | `results.json` | none local |
| SB-011 upstream interop | `apps/pages/src/lib/sops/engine.ts` | INTEROP | `pnpm verify:sops-conformance` → `engine.conformance.test.ts` | passed | `results.json` | needs pinned oracle download (cached after first run) |
| SB-020 Shamir split/combine | `apps/pages/src/lib/sops/shamir.ts` (`shamirSplit`, `shamirCombine`) | INTEROP | `pnpm verify:sops-browser` → "shamir shares are 33 bytes" | passed | `results.json` | none local |
| SB-021 key-group threshold | `apps/pages/src/lib/sops/engine.ts` (`recoverKey`) | INTEROP | `pnpm verify:sops-browser` → "opens a two-of-three document only with two groups" | passed | `results.json` | none local |
| SB-030 vault export/import | `apps/pages/src/lib/sops/vault-secrets.ts` (`exportVaultSecrets`, `importVaultSecrets`) | INTEROP | `pnpm verify:sops-browser` → "exports every vault secret" | passed | `results.json` | whole-vault copy is the declared feature; refused fields fail closed |
| SB-031 Formats UI wiring | `apps/pages/src/sections/settings/SopsDocumentSheet.tsx`; `FormatsInteroperabilityPanel.tsx` | UX | `pnpm --filter @opensesame/pages test` → Formats panel suites | passed | `results.json` | — |
| SB-032 capability honesty | `apps/pages/src/lib/vault/protection/sops-browser.ts` (`sopsCapability`) | UX | `pnpm --filter @opensesame/pages test` → "reports honest capabilities"; `pnpm verify:sops-browser` UI scan | passed | `results.json` | — |
| SB-040 selectors | `apps/pages/src/lib/sops/selectors.ts` (`matchRe2`); `tree.ts` (`shouldEncrypt`) | INTEROP | `pnpm verify:sops-browser` | passed | `results.json` | RE2 subset only — lookaround/backreferences refused by design |
| SB-045 lossless boundary | `apps/pages/src/lib/sops/yaml-codec.ts` (`fromNode`, `toYaml`); `json-codec.ts` | INTEROP | `pnpm verify:sops-browser` → "fails closed on YAML aliases and explicit tags", "preserves comments through a round-trip" | passed | `results.json` | aliases, anchors, tags, merge keys fail closed (C13) |
| SB-050 cloud endpoint checks | `apps/pages/src/lib/sops/cloud-endpoint.ts` (`assertSopsHttpsEndpoint`, `awsKeysMatch`) | INTEROP | `pnpm verify:sops-conformance` → `cloud-endpoint.test.ts` | passed | `results.json` | no live provider call |
| SB-058 cloud KMS live | — (gate `scripts/verify-sops-cloud-live.mjs`) | INTEROP | `pnpm verify:sops-cloud-live` | blocked | `cloud-live.json` | no disposable AWS/Azure/GCP credentials in this environment; browser engine does not call cloud KMS today |
| C13 formats-interop core | `docs/archive/prompts/vault-key-protection-age-sops-prompt.md` § C13 | INTEROP | every `pnpm verify:sops-*` above | passed | this ledger | sops metadata edited-by-hand outside the engine is out of scope |
| Deliverable 4 (ledger) | `docs/evidence/2026-09-21-sops-browser/traceability.md` | INT | manual review against prompt § Required deliverables | passed | this file | — |
