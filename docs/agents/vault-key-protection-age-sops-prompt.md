# Agent prompt — Vault key protection and age/SOPS interoperability

**Audience:** lead LLM coding agent + parallel subagent swarm in
`Tyler-R-Kendrick/OpenSesame`. This file is self-contained. Do not depend on
prior chat. Repository source is authoritative over the September 20, 2026
baseline snapshot below; document material differences with file/symbol
evidence.

**Outcome:** working repository changes that make this question operationally
true — *which independently usable keys or services can unlock this vault,
where those keys are controlled, and what has actually been tested* — by
extending the existing multiple-unlock architecture with explicit **vault key
protection**, separate **provider connections**, and separate **file-format
interoperability**.

---

## Adversarial critique (read before coding)

### Critique of this specification itself

1. **Scope vs one-shot reality.** Seventeen swarms (INT…DOCS) plus KP-01…KP-50
   is a full security program. A single coordinated execution can land the
   *contracts, migrations, truthful UI, password/PIN/PRF preservation, age
   root protector, cloud wrapping-secret adapters with fake transports, and
   SOPS YAML/JSON native path* — but live AWS/Azure/GCP/PIV suites will often
   be **blocked**, not passed. Treat “blocked” as success-class honesty, not
   as permission to ship stubs labeled complete.

2. **Competing authority risk is correctly identified — enforce it.** The
   mandate “do not create a second global `wrappedKeys[]` beside
   `VaultHeader.unlocks`” is load-bearing. Any swarm that adds a parallel
   registry fails the contract even if tests are green.

3. **Any-of vs all-of will be mis-marketed.** Multiple protectors expand
   access. UX/DOCS must not imply MFA-from-listing. ADV must include a
   regression that proves each enrolled method alone opens the root.

4. **WebCrypto ≠ device custody.** Renaming the Connections “encryption”
   picker without changing KeyVaultCeremony copy leaves the original lie.
   UX must show mechanism names (Password, Passkey/PRF, …).

5. **Cloud “no root upload” ≠ no cloud trust.** The 32-byte wrapping-secret
   design still grants KMS holders an independent recovery path. If docs
   claim “zero knowledge” or “cloud never sees key material,” reject the PR.

6. **SOPS threshold vs vault any-of.** Flattening SOPS key-groups into
   ordinary any-of protectors is a protection-policy change requiring
   explicit refuse-or-consent. Default = refuse lossy conversion.

7. **Agent oracle surface.** Isolating root-unwrap APIs is insufficient if
   the same KMS key, age identity, or cloud credential remains reachable via
   generic ConnectionRef/MCP decrypt. AUTH-E is mandatory, not optional.

8. **Pinned typage APIs.** `age-encryption@0.3.1` may lack documented
   WebAuthn/FIDO2 helpers from newer typage. Inspect installed exports before
   PRF-C claims upstream reuse.

9. **Direct-root-as-content-key (`ItemDataKey(vrk.0)`).** Compromise rotation
   that only rewraps the root without rewriting bodies is a false rotation on
   native sealed-store paths. LIFE-D must inventory the real key graph.

10. **Evidence class laundering.** Contract tests with fake transports must
    not be labeled `cloud-live`. Virtual authenticators must not be labeled
    physical hardware. INT/E2E/DOCS share the ledger vocabulary:
    `passed | failed | blocked`.

### Working-tree collision (this checkout)

Recorded at prompt authoring:

| Field | Value |
|-------|-------|
| Branch | `feat/pages-bitbucket-connector` |
| HEAD | `dc3d11878c90f1088d094ff18f5ee9d301e4a57d` (matches baseline SHA) |
| Dirty | Substantial uncommitted Pages/connect-backend **forge vault-backup** work |

**Rule:** do not discard, reset, or overwrite that work. Either (a) land key
protection on a fresh worktree/branch from the same base and merge carefully,
or (b) integrate without reverting forge-backup files. History/backup
destinations remain **independent** of root protection (C01) — do not conflate
`git_remote` backup targets with KMS/age root protectors.

Related prior agent prompt (different problem):
`docs/agents/spa-multi-forge-vault-backup-prompt.md`.

### Execution rules (non-negotiable)

- Deliver working code, migrations, negative tests, and truthful UI — not another proposal.
- Parallelize by **ownership of independent modules**, not by phases/timelines.
- Resolve integration continuously against shared MODEL contracts.
- No production vaults, real KMS keys, hardware slot overwrites, or billable
  cloud provisioning without separate explicit authorization.
- Prefer existing crypto, VFS, broker, and UI infrastructure; pin dependencies.
- Fail closed; never silently downgrade encryption or switch unlock authority.
- Claims match evidence class. Missing hardware/cloud → explicit `blocked`.

---

## Verified repository baseline

**Inspection date:** September 20, 2026.
**Inspected default-branch commit:** `dc3d11878c90f1088d094ff18f5ee9d301e4a57d`.
**Evidence character:** source inspection, not executed hardware/cloud operations.

### Existing implementation to reuse

| Area | Observed behavior and integration consequence | Evidence |
|---|---|---|
| Capability selection | `CAPABILITIES` includes an `encryption` family. `CapabilityConnectorBinding` stores a single `providerId` and optional `connectionId`; defaults select `webcrypto`. Preference/connection binding ≠ cryptographic policy. Other capability families stay intact. | [R01] |
| Key-vault UI | `KeyVaultCeremony.tsx` offers local/hardware/cloud choices via `bindCapabilityConnector`. Active state derives largely from whether authorization appears owed. Not a root-key migration transaction. | [R02] |
| Binding and authorization | `capability-bind.ts` saves settings and runs consent. `bindingNeedsAuth` checks connection ID presence, not successful root-key ops. Unfinished consent can persist a connection ID. Async callbacks read current binding → stale-result risk. | [R03] |
| Browser vault crypto | `vault/crypto.ts`: random 32-byte vault key, password-derived AES-GCM wrapping, collection encryption, password rewrap without rewriting items. PBKDF2-SHA256 ≥ 600k iterations with bounded max. Session `CryptoKey` non-extractable; private raw-key copy supports enrollment. | [R04] |
| Alternate unlocks | `vault/unlock-methods.ts`: password, PIN, WebAuthn-PRF wraps of the same vault key; PRF→HKDF→AES-GCM; domain `opensesame/vault/webauthn-prf/v1` preserved. TOTP/email/SMS/recovery codes are post-unwrap app gates, not offline crypto MFA. | [R05] |
| Session and storage | `vault/store.ts`: unlocked state, raw-key lifetime, lock, tomb scope, guest isolation. `tomb/<name>/header` public bootstrap + sealed body. `sharesWrapRecord` is legacy shared-key heuristic, not authorization. | [R06] |
| VFS | `vfs.ts`, `tomb-migration.ts`, `projects.ts`: plaintext bootstrap vs sealed files. Protection metadata cannot hide behind the key it recovers. Cover projects, guest tombs, shared-key vaults. | [R07] |
| Browser age | `age-keys.ts` + `age-encryption@0.3.1`; identities at sealed `config/age-keys`. Regex filtering ≠ complete age parser. Panel can overwrite the only identity on generate. | [R08], [R09] |
| Native crypto | `human-vault`: `VaultRootKey`, `ItemDataKey`, password-KDF policy, XChaCha20-Poly1305, PRF/HKDF, zeroizing types. Server receives ciphertext, not human root. | [R10] |
| Native sealed store | `.osseal`, `.age`, `.gpg`, history, attachments, `.opensesame-key`. `init_store_key`/`unlock_store_key` return `ItemDataKey(vrk.0)` — root bytes used as content key. Do not assume independent per-entry DEKs. | [R11] |
| `.osseal` framing | `OSSEAL1\n` + authenticated envelopes. Do not rename to a fake v2 just for root protectors. | [R12] |
| Host provider execution | `providers.rs` declares Encrypt/Decrypt/Test for age, FIDO2, YubiKey, AWS/Azure/GCP KMS; `crypto_plan` has age/AWS/GCP branches, not FIDO2/YubiKey/Azure Keys. Raw CLI encrypt ≠ browser vault-key wrapping. | [R13] |
| Product positioning | Age = primitive; SOPS = structured-file interop; sealed store = hierarchical vault. Remove ambiguous user-facing “key SOP.” | [R14] |
| Toolchain | Pages Vitest/Playwright; root `pnpm` gates; Rust `+1.88.0` — recheck checkout toolchain files. | [R09], [R15] |

### Corrections (requirements, not commentary)

1. **Extend existing unlocks** — do not add a competing `wrappedKeys[]` beside `VaultHeader.unlocks`.
2. **WebCrypto is an API**, not TPM/Secure Enclave proof. Label Password / Passkey / explicit device-local.
3. **Multiple wrappers are any-of**, not all-of MFA.
4. **FIDO2 ≠ YubiKey PIV** — WebAuthn PRF and PIV/age are distinct mechanisms.
5. **Age file key ≠ OpenSesame root** — wrap a root capsule as ordinary age payload.
6. **Direct KMS Encrypt/Decrypt** is valid for bounded wrapping secrets; not arbitrary vault storage; not “settings binding = protected.”
7. **Vault-held identity ≠ independent root recovery** — graph bootstrap dependencies.
8. **Connection ID ≠ cryptographic evidence** — fix readiness + stale callbacks.
9. **Rewrap ≠ revocation** of copied headers/history; root compromise needs real rotation (and body re-encrypt where root==content key).
10. **Cloud recovery changes authority** — KMS unwrap + envelope recovers the root.
11. **SOPS compatibility is format/workflow** — not a relabeled proprietary envelope; preserve thresholds.

---

## Product and cryptographic contracts

### C01 — Three layers

| Layer | User question | Representation |
|---|---|---|
| Vault key protection | What can unlock this vault? | Vault-scoped protection manifest + independent protection records on existing root/header lifecycle |
| Connections | How does this runtime auth to a provider / trusted device? | Existing connection records; exact account/resource; auth state |
| Formats / interoperability | What encrypted file format? | Handlers for native, age, SOPS, GPG/pass |

Provider connection ≠ protector. One vault → many protectors (incl. same provider). One physical key → multiple mechanisms. Backup destination (GitHub/etc.) ≠ who can decrypt. Azure Keys protector ≠ Azure Secrets store.

### C02 — Preserve payloads; extend root boundary

Retain AES-GCM browser content, XChaCha20-Poly1305 native envelopes, attachments, legacy wrappers. Add versioned root-protection manifest at bootstrap boundary; adapt `VaultHeader` and `.opensesame-key`. New metadata version ≠ new payload cipher.

Manifest is authority for enrolled protectors. `capabilityConnectors.encryption` is legacy preference/hint only — never overrides crypto facts.

Stable opaque IDs: vault scope, root key id, root epoch, protector id. No display-name identity; no raw-key hash as id. Explicit payload-format identifiers (browser body ≠ `.osseal`).

### C03 — Shared semantic interfaces

Contract-owning swarm (MODEL) may align names with repo conventions; publish mapping immediately.

```ts
type ProtectorKind =
  | "password" | "pin" | "webauthn-prf" | "device-local"
  | "age-recipient" | "age-webauthn" | "yubikey-piv-age" | "recovery-key"
  | "aws-kms" | "azure-key-vault-keys" | "gcp-kms";

type ProtectionContext = {
  vaultId: string;
  rootKeyId: string;
  rootEpoch: number;
  protectorId: string;
  purpose: "human-vault-root" | "workload-root";
};

type ProtectorAvailability = {
  implementation: "implemented" | "unsupported";
  runtime: "available" | "requires-native-client" | "unavailable";
  authorization: "not-required" | "missing" | "pending" | "authorized" | "expired";
  reasonCode?: string;
};

type VerificationEvidence = {
  kind: "contract" | "software-roundtrip" | "browser" | "hardware" | "cloud-live";
  implementationVersion: string;
  testedAt: string;
  evidenceRef: string; // redacted evidence reference
};

interface KeyProtectorAdapter {
  capabilities(): ProtectorAvailability;
  enroll(request: AuthorizedEnrollmentRequest): Promise<PendingProtection>;
  prove(request: AuthorizedProofRequest): Promise<ProtectionProof>;
  open(request: AuthorizedOpenRequest): Promise<ClientRootKeyHandle>;
  dispose(): Promise<void>;
}
```

Concrete discriminated schemas per kind. No `Record<string, any>` with provider-controlled URL/algorithm/subprocess. Secret handles ≠ serializable telemetry. Operations capture immutable vault scope, root epoch, protector ID, connection ID/version, account/key fingerprint, session generation, expected manifest revision — late callbacks must not write into whichever vault is selected when they finish.

### C04 — Manifest integrity, bounded parsing, context binding

Authenticate security-relevant metadata after root recovery. Library-backed AEAD/MAC/HKDF + documented canonical encoding (JCS/RFC 8785 if chosen — correct implementation + vectors).

Required:

- Wrapper bound to immutable `ProtectionContext`, schema/derivation version, suite, provider/key identity. Cross-vault/epoch/purpose swaps fail closed.
- Mutable **manifest revision** authenticated in the manifest, **not** in every wrapper AAD (adding one protector must not re-auth every offline wrapper).
- Root-derived, domain-separated manifest auth key authenticates canonical manifest (records + root epoch), excluding the auth field itself. One place defines encoding, fields, verify order.
- Successful unwrap insufficient: validate key length, context, manifest auth, body/key-confirmation before vault availability.
- If upstream has no AAD: encrypt structured root capsule with expected context; verify against independently chosen context — do not trust metadata merely stored beside ciphertext.
- Unsupported versions, unknown critical fields/algorithms, duplicate JSON keys/IDs, overflow, malformed encodings, bad nonce/tag lengths, oversized inputs → typed errors before expensive crypto/network.
- Bounds (unless stricter repo limit): ≤64 protection records; ≤64 KiB encoded/record; ≤1 MiB root manifest metadata.
- Validate KDF lower/upper bounds; preserve legacy password normalization and PRF salts.
- Public bootstrap: allowlisted only (credential IDs, recipient/key identifiers, provider relationships OK to reveal — disclose that). Never tokens, PINs, PRF output, private identities, clear wrapping seeds, clear roots.
- Manifest MAC ≠ rollback prevention. Retain local high-water marks. Fresh offline restore cannot prove newest copy — report that.
- Authenticate security-relevant legacy header and app-gate settings in new metadata; no separately mutable flag that silently suppresses a configured confirmation gate. App gates remain post-unwrap, not offline MFA.

### C05 — Runtime, custody, cloud boundary

Human-vault root stays in trusted client (browser and/or explicitly paired personal native). Not arbitrary Host/gateway/connector worker/model/cloud function.

Cloud protectors: **random 32-byte per-protector wrapping secret** generated in client → domain-separated local KEK wraps root capsule; KMS wraps the wrapping secret. Record both layers + context. KMS plaintext = fixed 32 bytes independent of vault size. Disclose KMS decrypt rights + envelope = independent recovery path.

Direct provider requests from trusted client / paired native. No clear wrapping-secret proxy for CORS. Ciphertext-only relay only with authenticated E2E channel from existing infra.

Workload roots are separate scopes. Do not expose human-root wrap via agent ConnectionRef just because provider has Encrypt.

Browser: raw-root buffer only for existing enrollment semantics; best-effort clear; document JS GC / same-origin limits. Rust: zeroizing types.

### C06 — Honest enrollment and state

Distinguish: catalog availability, runtime capability, connection authorization, enrollment transaction, stored wrapper, last successful proof, current unlock availability.

Success = candidate wrapper produced → exact root capsule independently opened via intended mechanism → manifest durably committed → reopened via production reader.

Public recovery recipient without private identity = explicit **untested recovery** path; grants real authority once published; cannot satisfy last-verified-path guard. “Inactive/disabled” does not make a retained usable wrapper cryptographically inaccessible.

Remove from current manifest ≠ delete external cloud key / reset token / erase backups. External resource deletion is a separate authorized op.

### C07 — Bootstrap, recovery, dependency cycles

Model dependencies among root protection, provider credentials, native pairing, OS key storage, other vaults. Root unlock must not depend exclusively on a secret reachable only after that root unlocks.

Sealed age inventory remains post-unlock file crypto. Root age protector needs independently available identity (user-supplied at unlock, hardware, OS/native store, separate recovery location). Do not export sealed private identity to plaintext settings.

Same for KMS auth: independent native cloud session or lock-time auth flow. Token only-in-vault fails bootstrap. `connectionId` ≠ bootstrap feasibility.

Every enrollment/replacement preserves ≥1 verified working primary path. Sole-device-key needs independent recovery or explicit unrecoverable acknowledgement.

App one-time recovery codes ≠ root recovery keys. High-entropy root recovery credential is a distinct type (CSPRNG).

### C08 — Atomic mutation, migration, compromise recovery

Per-vault serialization, expected-revision checks, cross-tab/process writers. Component mutex / BroadcastChannel ≠ storage transaction.

Candidate must not replace last durable valid record before proof + durable commit. Failures leave previous valid manifest or recoverable explicit transaction state. Journals never contain clear roots/content.

Native: confined paths, exclusive create, permissions, symlink guards, atomic replace, platform durability. Browser: prove OPFS/KV durability boundary (awaited).

| Operation | Root | Content | Meaning |
|---|---|---|---|
| Add alternate protector | unchanged | unchanged | another independent unlock |
| Rewrap | normally unchanged | unchanged | change protection of same root; not historical access |
| Remove from current vault | unchanged | unchanged | stop publishing current wrapper; copies may still work |
| Preferred unlock | unchanged | unchanged | convenience only |
| Rotate compromised root | new root | depends on key graph; direct-root content requires rewrite | new generation only; not retroactive secrecy |
| Rotate application secret | usually unchanged | that secret | different action |

Inventory everything encrypted with/derived from old root. Type name `ItemDataKey` ≠ independent DEK. Complete candidate generation + authenticated inventory/commit; serialize/reject writes during rotation; encrypted checkpoints; cleanup only after independent reopen of new generation. Never silently discard hardware/cloud methods whose secret cannot be obtained.

Legacy migration preserves primary unlocks, app gates, hints, revisions, guest isolation, unrelated settings. Old `providerId: "aws-kms"` without wrapper = requested-but-unenrolled setup intent.

Retain readers for old browser headers and native password wrappers. Version new metadata; reject unknown critical versions. `minReaderVersion` cannot force old clients — document mixed-client limits; no false downgrade-prevention claim.

Shared-root project forks: valid unlock may prove shared root; identical wrappers ≠ authorization to mutate another scope.

### C09 — Age and authenticator integration

Use maintained age libraries/public APIs. No hand-rolled stanzas / prefix-regex-as-validation. Parse types the pinned implementation supports.

Root capsule as age payload ≠ changing `.age` file format. Default one independently managed age recipient per protection record; multi-recipient records must surface all any-of grants. Removing a manifest record does not rewrite recipients inside existing ciphertext — produce/verify replacement wrapper.

Evaluate `age-encryption@0.3.1` exports vs typage WebAuthn docs. Preserve legacy OpenSesame PRF derivation; do not claim OS passkey wrap ≡ upstream age plugin identity.

PRF: require actual PRF output of expected length; `enabled: true` without results ≠ KEK; registration may need subsequent assertion; bind credential, RP ID, origin, UV policy; honor cancel; never synthesize PRF from signature/credential ID. Persist public data for credential + original RP ID selection. Domain change ≠ automatic migration. Sync/backup eligibility evidence-dependent.

YubiKey PIV: distinct native path (prefer maintained age/PIV). Discovery non-destructive (no slot/PIN/PUK/management overwrite). Provisioning explicit + separate consent.

### C10 — Cloud adapter specifics

Shared C05 wrapping-secret envelope for AWS/Azure/GCP. Prefer maintained SDK/API clients. No secrets in argv/env/logs/disk. No generic arbitrary-command executor.

**AWS KMS:** encryption-capable key; resolve full key ARN (not mutable alias as permanent id); EncryptionContext for stable non-secret context; expected key on decrypt; no invented material-version URL; wrap payload stays 32 bytes. Test denial, alias retarget, wrong context, disabled/pending-deletion, malformed responses.

**Azure Key Vault Keys:** wrap/unwrap ops (not Secrets); versioned key id; RSA-OAEP-256 for supported RSA; reject RSA1_5 / SHA-1 OAEP; Managed HSM/symmetric = separate evidence entries; validate tenant/cloud/endpoint/audience/resource; bind OpenSesame context locally if upstream has no AAD.

**GCP KMS:** symmetric encrypt purpose; exact project/location/keyring/key; version identity; AAD for stable context; CRC32C request/response integrity flags (CRC ≠ crypto auth); no plaintext checksum persistence; disabled/destroyed/permission typed.

Imported endpoints/plugins untrusted before root recovery — allowlisted policy before token/key-bearing requests (SSRF, redirects, sovereign mismatch, malicious tenant, localhost/DNS). Least privilege; no key admin/delete for wrap/unwrap.

### C11 — Connection and authority integration

Reuse connections/consent; fix weaknesses.

- Bind enrollment to exact connection + account/tenant/key config (not first matching providerId).
- Pending/resumable connection ID ≠ authorized protector.
- Capture operation/session generation; reject stale provider/vault/account completions.
- Revocation/expiry invalidates readiness without silently deleting recoverable ciphertext.
- Human-authorized vault-scoped enroll/remove/recovery/rotation; agents/ConnectionRef not entitled to human-root unwrap or attacker recovery recipients.
- Surface incompatible “org requires online approval” + unrestricted offline root.
- No root/wrapping secret/PIN/private identity/PRF in agent tools, receipts, telemetry, support exports, prompts, console, traces.
- Prevent equivalent decryption oracles (generic KMS Decrypt / age / cloud creds with same key). Isolate human-root protector keys from agent-accessible generic crypto by exact resource + execution identity. Refuse enrollment when broad grant cannot be resolved safely. Test generic raw-crypto aliases against root-protection ciphertexts — require denial.

### C12 — UX and terminology

| Surface | Role |
|---|---|
| Settings → Security → Vault key protection | Authority view: enrolled methods, mechanism, scope, fingerprint, runtime, recovery deps, last real test, currently usable. Legacy = Password/PRF not “WebCrypto.” |
| Settings → Connections | Accounts / trusted native. KMS: “Use this connection to protect a vault key,” not “Encryption enabled.” Hardware: execution requirement, not SaaS login for browser PRF. |
| Formats and interoperability | Native / age / SOPS / GPG with separate R/W/runtime indicators. Selecting format ≠ mutating root protectors. |

Actions: add, test, preferred unlock, replace/rewrap, remove from current vault, export/test recovery, rotate compromised vault key — distinct confirmations. State any enrolled method can unlock alone; remove does not erase old copies.

Terms: “key protection method,” “age recipient,” “age identity,” “passkey/security key (PRF),” “YubiKey PIV through age.” Remove user-facing “key SOP.”

Unavailable cloud/key → alternatives + prerequisite + choice; no auto-probe all providers; failed op must not strand last working method.

A11y: full labels, keyboard, focus, SR announcements, touch targets; mobile+desktop; long IDs; many methods; no color-alone status.

### C13 — Formats and SOPS interoperability

Core PWA/native vault works without SOPS/cloud. SOPS = optional human-authorized interop, not storage backend or root-key type.

Real YAML+JSON SOPS import/export via maintained upstream in trusted native runtime (pinned binary OK). Browser may delegate to paired native; report requirement honestly. No hosted plaintext conversion.

Upstream fixtures both directions. Integrity/MAC failures, recipients, multi-key metadata, encrypted-value semantics. No home-grown subset marketed as generic SOPS.

Lossless type mapping for declared subset; fail closed on aliases/tags/unsupported; unencrypted fields identified. Preserve key-group/threshold via upstream or refuse lossy any-of conversion (explicit consent if ever allowed).

Confine plugins/exec/env/cwd; ignore `.sops.yaml` command authority; pipes for plaintext; seal before durable persist/git. Preserve `.age`/`.gpg`/`.osseal`. Additional formats only when individually implemented.

---

## Parallel subagent swarm assignments

### Ownership map

| Swarm | Exclusive production ownership | Primary outputs |
|---|---|---|
| INT | Integration ledger, workspace wiring, final gate | Contract mapping, collision resolution, assembly, completion report |
| MODEL | Shared schemas, manifest codec, capsule/adapter contract | TS/Rust semantics, codec tests, fixtures |
| BROWSER | Browser vault store/crypto/VFS entry points | Unlock/enrollment lifecycle, session safety, persistence |
| NATIVE | human-vault / sealed-store entry points | Native manifest R/W, CLI root ops, format preservation |
| LIFECYCLE | Mutation/migration/rotation modules | Crash-safe changes, compromise recovery, state-machine tests |
| PRF | WebAuthn ceremony + PRF adapters | Passkey preservation, multi-credential, real browser behavior |
| AGE | Age inventory + recipient adapters | Parsing, external recovery identity, interop |
| PIV | Native PIV/age adapter | Non-destructive discovery, hardware path, plugin controls |
| AWS / AZURE / GCP | Respective KMS protectors | Bounded SDK adapters + provider tests |
| AUTH | Consent, bootstrap graph, trusted transport | Scoped auth, callback safety, agent boundary |
| UX | Settings/connections/security/format presentation | Truthful enrolled state, a11y |
| INTEROP | SOPS + external-format orchestration | Genuine YAML/JSON import/export |
| E2E | Cross-module acceptance harnesses | Real crypto workflows, reload tests, evidence |
| ADV | Independent adversarial tests/fuzz | Repro + verified negatives |
| DOCS | ADR/security/operator/reference | Trust model, matrix, recovery, evidence index |

### Single-writer high-contention files

| Surface | Writer | Others contribute through |
|---|---|---|
| `vault/crypto.ts`, `vault/store.ts`, `vfs.ts`, `tomb-migration.ts`, `projects.ts` | BROWSER | Reviewed MODEL/LIFECYCLE/adapter patches |
| `vault/unlock-methods.ts` | PRF | BROWSER/MODEL fixtures |
| `age-keys.ts` | AGE | UX consumes exports |
| `AgeKeysPanel.tsx`, `KeyVaultCeremony.tsx`, `capabilities.ts`, settings routes | UX | BROWSER/AUTH state selectors |
| `capability-bind.ts`, consent/connection code | AUTH | UX consumes typed readiness |
| `human-vault`, `sealed-store`, `connector-host/src/providers.rs`, CLI dispatch | NATIVE | MODEL/LIFECYCLE/cloud/PIV modules + narrow dispatch patches |
| Root/package manifests, lockfile, aggregate gate | INT | Pinned dep requests from owners |

INT arbitrates ownership conflicts in the ledger. Fixture/mock adapters must not survive as production paths.

### Swarm work items (atomic)

**INT:** Map checkout vs baseline + dirty paths; publish package/module names + fixture locations; eliminate duplicate registries/PRF helpers/parallel “encryption selected” truth; trace button/CLI → auth → adapter → proof → durable commit → lock → unlock → audit; own `pnpm verify:key-protection` + ledger (`passed|failed|blocked`).

**MODEL:** Versioned per-kind schemas; authenticated metadata + canonicalization + capsule; adapter contracts + shared cloud wrapping-secret envelope; language-independent vectors (valid/corrupt/reorder/dupes/bounds/tamper/wrong-vault/epoch + legacy samples). TS↔Rust agree on claimed encodings.

**BROWSER:** Manifest drives methods (preference = setup intent only); lifecycle APIs; cancel pending on lock/logout/guest/vault-switch/rotation/session gen; VFS/guest isolation; WebCrypto create→add→persist→lock→reload→unlock→read tests.

**NATIVE:** Versioned `.opensesame-key` around legacy password wrappers; CLI list/add/test/remove/rewrap/recovery/root-rotation; route adapters; confined durable writes; retain `.osseal`/`.age`/`.gpg`/history/attachments.

**LIFECYCLE:** Transaction engine (expected-revision, candidate, commit/recovery); legacy migration without changing derivation; last-verified-path + untested recipient + recovery-key type; compromise rotation with real key-graph rewrite; crash/race/rollback tests.

**PRF:** Preserve `kekFromWebauthnPrf` + multi-credential records; complete ceremonies (enabled-without-results, cancel, wrong RP/cred, UV); evaluate typage reuse honestly; capability detection without SSO-as-KEK claims.

**AGE:** Real library parse/validate; multi-identity inventory (no silent overwrite); age root protector with independent open proof; post-unlock inventory vs bootstrap; shown-once recovery export; pinned tooling interop.

**PIV:** Native age/PIV path; non-destructive discovery; pinned plugin trust; deterministic + opt-in physical suite; browser reports native requirement (not WebAuthn-as-PIV).

**AWS/AZURE/GCP:** C05 envelope; identity/context/integrity per C10; independent auth; contract tests with fake transport; opt-in live against disposable test keys only.

**AUTH:** Pending vs authorized; stale callback rejection; exact resource resolve; dependency/cycle analysis; trusted native transport; agent/oracle denial tests.

**UX:** C12 IA; cryptographic facts from manifest; wire lifecycle actions; trust-transition copy; a11y/layout tests; redirects for old routes.

**INTEROP:** Optional pinned SOPS runtime; YAML/JSON both directions; threshold preserve/refuse; process/file hardening; upstream differential fixtures.

**E2E:** Production-path harness; cross-runtime fixtures; failure/scope changes; truthful evidence classes; redacted artifacts (no canaries).

**ADV:** Authority/state attacks; parser/crypto fuzz; persistence races; process/network/secret boundaries; claim falsification (any-of≠MFA, old wraps, rotation generation, offline freshness).

**DOCS:** ADR; kill “key SOP” / preference-as-encryption; operator recovery/compromise; evidence matrix; requirement→symbol→test→artifact ledger links.

---

## Acceptance and adversarial test matrix (KP)

Every row needs production owner, test id, and ledger entry. E2E executes integration; ADV challenges negatives; named swarm owns fixes.

| ID | Case | Pass condition | Owner |
|---|---|---|---|
| KP-01 | Legacy browser password vault | Opens legacy ciphertext; migration preserves content, KDF, revision, gates | BROWSER, LIFECYCLE |
| KP-02 | Legacy PIN + PRF | Each method usable; no silent derivation-domain change | PRF, BROWSER |
| KP-03 | Legacy native password `.opensesame-key` | Opens real `.osseal` + attachments | NATIVE, LIFECYCLE |
| KP-04 | Saved encryption preference w/o enrollment | Setup intent only — not enrolled/verified | UX, BROWSER |
| KP-05 | Add/rewrap only | Payload/attachment digests unchanged; only necessary metadata changes | LIFECYCLE |
| KP-06 | Two protectors same provider | Coexist; exact IDs select | MODEL + adapter |
| KP-07 | Any-of semantics | Each method alone opens root; UI/docs don’t claim all-of | UX, DOCS |
| KP-08 | Offline baseline | Password/PIN/(PRF) without cloud/SOPS/Host | BROWSER, NATIVE |
| KP-09 | Exact-root enrollment proof | Corrupt candidate capsule → enroll fails despite provider sample OK | MODEL + adapter |
| KP-10 | Persisted reload | Lock → destroy memory → reload → unlock → read content | BROWSER, NATIVE |
| KP-11 | Last verified method | Refuse remove/replace of last verified independent path | LIFECYCLE, AUTH |
| KP-12 | Concurrent last-method removals | Expected-revision conflict; no zero methods | LIFECYCLE |
| KP-13 | Storage interrupt / quota | Valid old gen or recoverable txn; no false success | LIFECYCLE, BROWSER, NATIVE |
| KP-14 | Unfinished consent | Pending connection ID ≠ authorized/protecting | AUTH, UX |
| KP-15 | Stale auth callback | Switch provider/account/key/vault → old result discarded | AUTH |
| KP-16 | Lock while awaiting HW/cloud | Late responses discarded; no unlock/persist/cross-vault | BROWSER, AUTH |
| KP-17 | Guest / project isolation | Guest cannot mutate real vault; shared-root ≠ cross-scope auth | BROWSER, LIFECYCLE |
| KP-18 | Wrapper substitution | Cross vault/purpose/epoch/key → fail closed | MODEL |
| KP-19 | Manifest tampering | Altered security metadata → fail closed | MODEL |
| KP-20 | Parser / resource limits | Dupes, overflow, huge inputs, bad versions within bounds; no panic | MODEL |
| KP-21 | Rollback / freshness | High-water reject/handle; offline restore no false global freshness | LIFECYCLE |
| KP-22 | PRF enabled without output | Not a KEK; later assertion can finish; unsupported typed | PRF |
| KP-23 | PRF identity / cancel | Wrong cred/RP/UV/cancel never new wrap or deletes old | PRF |
| KP-24 | PRF origin change | Accurate guidance; no auto-port claim; age interop only if implemented | PRF, AGE, UX |
| KP-25 | Age parse / inventory | Library validation; no silent erase of needed identities | AGE |
| KP-26 | Age recovery bootstrap | External/hardware identity opens root; vault-only identity ≠ independent | AGE, AUTH |
| KP-27 | Untested public recipient | Disclosed grant; marked untested; ≠ last verified | AGE, UX, LIFECYCLE |
| KP-28 | Root recovery vs app codes | High-entropy root path works; OTP/app codes not root keys | LIFECYCLE, UX |
| KP-29 | PIV discovery non-destructive | No key create/slot/PIN/PUK/mgmt change; FIDO-only ≠ PIV | PIV |
| KP-30 | Age/plugin boundary | Pinned path OK; PATH swap/malicious output/timeouts rejected | PIV, AGE |
| KP-31 | Large vault cloud protector | Provider sees only 32-byte wrapping secret | AWS, AZURE, GCP |
| KP-32 | Cloud authority disclosure | Wrapping-secret path recovers root; docs acknowledge | DOCS, UX |
| KP-33 | AWS binding/permissions | Exact key/context; typed failures | AWS |
| KP-34 | Azure algorithm/version | RSA-OAEP-256 on versioned key; refuse secrets endpoint / bad alg | AZURE |
| KP-35 | GCP integrity/resource | CRC/flags/context/version failures rejected | GCP |
| KP-36 | SSRF / resource input | Imported locators cannot hit arbitrary hosts/metadata | AUTH + cloud |
| KP-37 | Cloud credential cycle | In-vault-only token fails bootstrap; independent session can recover | AUTH + cloud |
| KP-38 | Trusted-native transport | Unpaired/wrong origin/replay/wrong purpose denied | AUTH |
| KP-39 | Agent / support surfaces | No root/PRF/wrapping-seed leakage via invoke/MCP/support | AUTH, NATIVE, BROWSER |
| KP-40 | Compromised-root rotation | New gen not decryptable with old root/derived content keys | LIFECYCLE |
| KP-41 | Interrupted rotation | No mixed-key complete gen; restart recovers designated valid gen | LIFECYCLE |
| KP-42 | Historical / removal semantics | Old ciphertext subject to old keys; remove ≠ external key delete | LIFECYCLE, UX, DOCS |
| KP-43 | Optional SOPS | Core vault works without SOPS; UI names required runtime/version | INTEROP, UX |
| KP-44 | Genuine SOPS YAML/JSON | Upstream decrypts ours; we import upstream into sealed vault | INTEROP |
| KP-45 | SOPS MAC / threshold | Tamper fails; thresholds preserved or conversion refused | INTEROP |
| KP-46 | Malicious SOPS config | No editor/exec/plugin/escape from untrusted YAML | INTEROP |
| KP-47 | No secret leakage in evidence | Canaries absent from logs/artifacts/screenshots/argv | All |
| KP-48 | Mixed readers / migrations | New clients reject unknown critical; document old-client limits | LIFECYCLE, DOCS |
| KP-49 | Real UI workflows | Add/prove/lock/unlock/remove with truthful status + a11y | UX, BROWSER |
| KP-50 | Evidence truthfulness | Missing HW/cloud → `blocked`; never count skip as live pass | INT, E2E, DOCS |

ADV findings append to this matrix with owners.

### Additional migration / trust constraints

- Legacy wrappers without new context keep a clearly identified legacy reader; authenticate exact bytes in migrated manifest where applicable; honest weaker historical binding; upgrade via authorized ceremony when inputs available — do not require every dormant hardware key just to preserve readability.
- Fresh imported backup: distinguish initial trust vs verification against trusted local state; no silent replace of existing vault from imported header.
- Before provider ops, bootstrap metadata is untrusted routing — validate endpoint/resource policy first.
- “Previously verified” ≠ “currently usable.” Destructive changes must test retained replacement path in current session/runtime or fail actionably — without globally probing all services on ordinary unlock.

---

## Executable validation contract

### Local deterministic gate

Add **`pnpm verify:key-protection`** (new) aggregating focused suites without production credentials. Emit machine-readable summary: `passed` / `failed` / `blocked`. Required local failure → nonzero exit. Missing optional live infra must not drop unrelated local tests.

Cover: schema/codec vectors; real local crypto; browser/native persisted reload; lifecycle/migration failures; provider contracts with fake transports; auth regressions; local age/SOPS suites.

Also run (reconcile names with checkout):

```bash
pnpm --filter @opensesame/pages typecheck
pnpm --filter @opensesame/pages test
pnpm --filter @opensesame/pages build
pnpm --filter @opensesame/pages verify:keyboard
pnpm --filter @opensesame/pages verify:mobile
pnpm --filter @opensesame/pages verify:experience
pnpm lint
pnpm lint:anti-slop
pnpm quality
pnpm typecheck
pnpm test:security
pnpm audit:gitleaks
cargo +1.88.0 test -p opensesame-human-vault -p opensesame-sealed-store
```

Targeted mutation evidence: deliberately removing context verification, manifest authentication, last-method guard, or stale-session rejection must fail the relevant negatives.

### Live / physical evidence (opt-in)

AWS / Azure / GCP / PIV suites: explicit test-only resources, minimal permissions; no key deletion, production enumeration, PIN guessing, auto-provision, slot overwrite. Live identity lookup alone ≠ wrap/unwrap. Sample wrap ≠ vault integration. Record redacted resource ids; missing resources → `blocked`.

---

## Required deliverables

1. Production implementations + entry-point wiring + migrations + tests + UI copy + docs.
2. ADR: root manifest, cipher preservation, trusted client/cloud boundary, any-of, bootstrap graph, legacy limits, transactions, rollback limits.
3. Operator guide: recovery and root compromise.
4. Traceability ledger (discoverable), minimum columns:

```text
requirement_or_test_id
production_file_and_symbol
owning_swarm
verification_command_and_test_id
result = passed | failed | blocked
artifact_reference
limitation_or_blocked_reason
```

5. Evidence index: tested commit, tool/library versions, fixture hashes, redacted results, support matrix, UI screenshots. Not a checkbox copy of this prompt.
6. No secrets in deliverables.

### Final coding-agent report (required shape)

State what changed in the checkout: commit/working-tree status; principal code paths; real UI/CLI behavior; executed tests with results; externally blocked live checks; known security/compatibility limits; links to source/tests/docs/evidence. Separate **implemented but not live-tested** from **not implemented**; **blocked validation** from **failed validation**. Unresolved in-scope security defects = release blockers. Do not claim complete while UI only writes preferences, adapters are stubs, migrations can lock users out, or tests are disconnected.

---

## Scope resolutions (anti-expansion)

**In scope:** password/PIN preservation; multiple PRF methods; external age root recovery; native YubiKey/PIV-age; AWS/Azure/GCP root-protection adapters (fake-transport contract tests + blocked live); YAML/JSON SOPS path; high-entropy root recovery key if needed.

**Out of scope:** new automatic browser device-key alternate unlock (preserve existing if found); custom human-vault threshold cryptosystem; replacing cloud IAM; new IdPs; rewriting all content formats; unauthenticated device bridge; inventing SOPS threshold via home-grown Shamir.

---

## Source registry

Baseline pinned to `dc3d11878c90f1088d094ff18f5ee9d301e4a57d`.

| Ref | Path / topic |
|---|---|
| [R01] | `packages/app-core/src/lib/capabilities.ts` |
| [R02] | `apps/pages/src/components/KeyVaultCeremony.tsx` |
| [R03] | `packages/app-core/src/lib/capability-bind.ts` |
| [R04] | `packages/app-core/src/lib/vault/crypto.ts` |
| [R05] | `packages/app-core/src/lib/vault/unlock-methods.ts` |
| [R06] | `packages/app-core/src/lib/vault/store.ts` |
| [R07] | `packages/app-core/src/lib/vfs.ts` (+ tomb-migration, projects) |
| [R08] | `packages/app-core/src/lib/age-keys.ts` (+ AgeKeysPanel) |
| [R09] | `apps/pages/package.json` (`age-encryption@0.3.1`) |
| [R10] | `crates/human-vault/src/lib.rs` |
| [R11] | `crates/sealed-store/src/store.rs` (+ lib.rs) |
| [R12] | `crates/sealed-store/src/envelope.rs` |
| [R13] | `crates/connector-host/src/providers.rs` |
| [R14] | `docs/competitors/age.md`, `docs/competitors/sops.md`, ADR 0037 |
| [R15] | root `package.json` |

| Ref | Upstream |
|---|---|
| [S01] | W3C Web Cryptography API |
| [S02] | C2SP age |
| [S03] | FiloSottile/typage |
| [S04] | WebAuthn L3 PRF |
| [S05] | age-plugin-yubikey |
| [S06] | getsops.io security + docs |
| [S07]–[S09] | AWS KMS Encrypt/Decrypt/EncryptionContext |
| [S10] | Azure Key Vault Keys |
| [S11] | GCP KMS envelope + CRC32C integrity |
| [S12]–[S14] | SOPS key groups / key management / age identities |
| [S15] | RFC 8785 JCS |

GitHub deep links (baseline SHA):

- https://github.com/Tyler-R-Kendrick/OpenSesame/blob/dc3d11878c90f1088d094ff18f5ee9d301e4a57d/packages/app-core/src/lib/capabilities.ts
- https://github.com/Tyler-R-Kendrick/OpenSesame/blob/dc3d11878c90f1088d094ff18f5ee9d301e4a57d/apps/pages/src/components/KeyVaultCeremony.tsx
- https://github.com/Tyler-R-Kendrick/OpenSesame/blob/dc3d11878c90f1088d094ff18f5ee9d301e4a57d/packages/app-core/src/lib/capability-bind.ts
- https://github.com/Tyler-R-Kendrick/OpenSesame/blob/dc3d11878c90f1088d094ff18f5ee9d301e4a57d/packages/app-core/src/lib/vault/crypto.ts
- https://github.com/Tyler-R-Kendrick/OpenSesame/blob/dc3d11878c90f1088d094ff18f5ee9d301e4a57d/packages/app-core/src/lib/vault/unlock-methods.ts
- https://github.com/Tyler-R-Kendrick/OpenSesame/blob/dc3d11878c90f1088d094ff18f5ee9d301e4a57d/packages/app-core/src/lib/vault/store.ts
- https://github.com/Tyler-R-Kendrick/OpenSesame/blob/dc3d11878c90f1088d094ff18f5ee9d301e4a57d/crates/human-vault/src/lib.rs
- https://github.com/Tyler-R-Kendrick/OpenSesame/blob/dc3d11878c90f1088d094ff18f5ee9d301e4a57d/crates/sealed-store/src/store.rs
- https://github.com/Tyler-R-Kendrick/OpenSesame/blob/dc3d11878c90f1088d094ff18f5ee9d301e4a57d/docs/adr/0037-git-sealed-store.md

---

## Atomic problem breakdown (for swarm dispatch)

Independent work packages (no serial phases — integrate continuously via MODEL contracts + INT ledger):

1. **Manifest codec + vectors** (MODEL) — schemas, MAC, capsule, TS/Rust fixtures.
2. **Browser header/store integration** (BROWSER) — unlock enumeration from manifest; session cancel.
3. **Native `.opensesame-key` + CLI** (NATIVE) — readers/writers; human commands.
4. **Transaction / migration / rotation** (LIFECYCLE) — expected-revision, last-path, compromise rewrite.
5. **PRF multi-cred ceremonies** (PRF) — preserve legacy domain; real output required.
6. **Age inventory + root protector** (AGE) — parse; multi-id; external recovery.
7. **PIV/age native** (PIV) — non-destructive discover; pinned plugin.
8. **Cloud wrapping-secret trio** (AWS/AZURE/GCP) — shared envelope; fake transport; SSRF policy.
9. **Consent / bootstrap / agent boundary** (AUTH) — stale callbacks; cycles; oracle denial.
10. **Settings IA** (UX) — Protection vs Connections vs Formats; truthful statuses.
11. **SOPS YAML/JSON** (INTEROP) — pinned upstream; both directions; refuse threshold flatten.
12. **Harness + evidence** (E2E/INT) — `verify:key-protection`; ledger.
13. **Adversarial matrix** (ADV) — KP negatives + claim falsification.
14. **ADR + operator + matrix** (DOCS) — match merged behavior.

Dispatch these as parallel subagents with the full contracts above in each prompt; single-writer rules apply; INT merges and runs the completion gate.
