# ADR 0139 — One definition, every target

- Status: Accepted
- Date: 2026-09-24
- Builds on: [ADR 0065](0065-agent-surface-parity.md) (agent-surface parity),
  [ADR 0087](0087-vault-item-type-plugins.md) (one item-type corpus for both
  planes), [ADR 0133](0133-shared-app-core.md) (one client core),
  [ADR 0138](0138-self-issued-identity-one-native-host.md) (one native binary)

## Context

OpenSesame is one vault product with several interfaces: the Pages PWA, the
native binary (`opensesame`: CLI, daemon, Host API), the browser extension and
Android. In practice each target kept its own copy of what the product is. An
audit on 2026-09-24 found:

- **Integrations.** At least 25 hand-maintained provider lists across Rust,
  TypeScript and SQL, four of them checked against another. The Host broker
  catalog and the connector host named the same seven providers differently
  (`aws` / `aws-secrets-manager`, `azure-kms` / `azure-key-vault-keys`, …), and
  the Host served both vocabularies. The Pages app rendered its own copy of the
  Host catalog with different egress hosts, operations, auth kinds and docs
  links (GitHub gained `github.com`, every LLM collapsed to `model.invoke`,
  fnox documentation links pointed at pages that do not exist).
- **Capabilities.** One registry (`packages/capability-registry`) drives the
  MCP tool lists, but a `null` surface needs no reason, the WebMCP parity test
  is skipped, the CLIs are checked by word search in one direction only, and
  the extension, Android and daemon routes are outside it.
- **Vaults and behaviour.** Three at-rest vault formats; TOTP implemented four
  times (TypeScript silently clamps what Rust rejects); password generation with
  different alphabets and default lengths; one Host API reached under five
  environment names and three default ports.

Each copy was correct when written. None of them can stay correct, because
nothing makes them agree.

## Decision

**Anything more than one target needs is defined once, as data, under
`spec/`, and every target consumes that definition — by embedding it or by
generating code from it — with a test in each consumer that fails when the
consumer and the definition disagree.**

1. A definition lives in `spec/<topic>/`, in a language-neutral format
   (JSON, validated where a schema exists). It is the only place a list or a
   rule is written.
2. Where one language computes a projection of the definition that others
   need (the Host API's provider view, for one), that language writes the
   projection to a checked-in file beside the definition, and a test fails
   when the file is stale. The other languages read the projection; they do
   not re-derive it.
3. Each consumer has a drift test: every id it names resolves in the
   definition, and whatever it shows about an entry comes from the
   definition. An id that is not in the definition is a failing test, not a
   review comment.
4. A target that shows less than the whole definition says so as data it
   owns (an ordered selection of ids), never as a second copy of the entries.
   A divergence that cannot be removed yet is pinned by its test as a list that
   may only shrink.
5. The same concept has one id. Other names are declared as aliases in the
   definition and resolved through it; an alias can never become a second row.

## First application: the integration catalog

- `spec/connectors/catalog.json` is the integration catalog (moved from
  `crates/connection-broker/src/catalog.json`). Rows gained `aliases` (the
  fnox long names; `github-oauth`, `cloudflare-api-token`) and the
  integrations only one target knew: the credential leases (`aws-sts`,
  `gcp-iam`, `azure-access-token`, `github-app`, `custom-command`), `docker`,
  `kubernetes`, `webcrypto`, `git` and `vault-self`. Key protectors list the
  operations they perform (`key.wrap`, `key.unwrap`).
- `spec/connectors/catalog.view.json` is the Host API's own provider view of
  every row, written by the connection-broker test `catalog_view`.
- `packages/app-core/src/lib/connector-catalog.generated.ts` embeds that view
  for the client plane; `connector-catalog.ts` resolves ids and aliases. The
  Pages bundled list is now an ordered selection of catalog ids
  (`embedded-catalog-data.ts`); every row's name, category, auth kind,
  operations, scopes and egress come from the catalog.
- Drift tests: connector-host (`tests/one_catalog.rs`, its catalog and the fnox
  parity snapshot), connection-detect (discovery aliases, generic API-key
  providers, mint-capable providers), the daemon (its CLI and keychain probe
  tables), the connection broker (the view file) and app-core (the embedded
  view, the bundled list, capability connector ids, wallet issuers, git backup
  forges).

## The rest of the stack

Each is a stacked pull request applying the same rule:

| Topic | Definition | Consumers |
|---|---|---|
| Capabilities and surfaces | `packages/capability-registry` → language-neutral, every surface mapped or excluded with an ADR (no `null`), extension and Android surfaces, reverse checks from each CLI's command tree and the WebMCP tools | both CLIs, MCP servers, WebMCP, Pages catalog, agent card |
| Behaviour cases | `spec/conformance/`: one-time passwords (`otp-cases.json`), the password generator (`password-policy.json`), item-type validation and native projection (`item-type-cases.json`) | Rust and TypeScript load the same file; the password policy is also the generators' runtime source of alphabets and defaults |
| Endpoint configuration | `spec/config/endpoints.json`: one variable (`OPENSESAME_HOST_API`, `OPENSESAME_IDENTITY_API`, `OPENSESAME_DAEMON_API`), its aliases and one default per endpoint | clap `env =` names and defaults (`opensesame_host_core::endpoints`), every TypeScript reader (`@opensesame/os-domain` `endpointAddress`), Pages runtime config and loopback suggestions, the extension; a test fails on an alias read anywhere else |
| Vault format | `docs/architecture/vault-format-v1.md` + `vault-vectors.json` | a Rust reader and writer checked against the same vectors, so the native binary opens the vault Pages writes |

## Consequences

- Adding an integration, a capability or a configuration key is one edit
  under `spec/`, and the drift tests name every target that must follow.
- The Host API and the client plane cannot disagree about a provider: the
  client embeds the Host's own projection.
- Some ids differ from the catalog's today (the Pages app stores fnox long
  names). They resolve as aliases; renaming stored data is a separate
  migration.
- Field sets the Pages app collects for twelve providers still differ from
  the catalog's (key protectors take a wrapping key; the catalog's fnox rows
  take a secret store). The test pins them; the list only shrinks.
