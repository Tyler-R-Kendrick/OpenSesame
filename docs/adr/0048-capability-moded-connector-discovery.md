# ADR 0048 — Capability-moded connector discovery

Status: Accepted
Date: 2026-08-19
Supplements: ADR 0047 (daemon connector discovery); amended by ADR 0049
(derived short-lived materialization)

## Context

ADR 0047 shipped the daemon's discovery offer: `POST /v1/discover` scans
the environment, home-directory dotfiles, and MCP server configurations
and returns a value-blind list of providers that appear configured. That
answer is necessary and not sufficient. "This looks configured" does not
say what OpenSesame could *do* with it, and those are different things:

- A `GITHUB_TOKEN` in the shell profile can be imported — moved under
  the sealed store — or left where it is and invoked through.
- A GitHub App installation (`~/.config/gh` plus an App registration)
  can mint fresh, narrower tokens on demand; importing its stored token
  would be strictly worse than minting.
- A keychain entry can be enumerated by label but its value is behind an
  ACL prompt the OS, not we, controls.
- An MCP server stanza names a connector but says nothing about how its
  credential is held.

Treating every finding as "import me" is the failure mode 1Password
Shell Plugins, aws-vault, and the git/docker credential-helper ecosystem
all independently grew past: the credential stays where it lives, and
the tooling brokers *access*, not *bytes*. Import is one acquisition
mode among three, and for a growing share of real developer machines it
is the worst of the three.

Discovery must therefore stop answering "what is here" and start
answering "what is here, and which modes of acquisition does it
support, at what confidence."

## Decision

1. **Offers are capability-moded, frozen as contract C1.** The probe
   result type, in `crates/connection-detect` (still serde + thiserror +
   std only):

   ```rust
   #[serde(tag = "kind", rename_all = "snake_case")]
   enum ProbeSource { EnvVar, DotFile, Keychain, McpConfig, CliTool }

   enum KeychainStore { SecretService, MacosKeychain, WindowsCredentialManager }

   // Ord ascending: importable < invoke_through < mintable,
   // so capabilities.iter().max() is the preferred mode.
   enum CapabilityClass { Importable, InvokeThrough, Mintable }

   enum Confidence { Low, Medium, High }

   struct OfferItem {
       provider_id: String,
       source: ProbeSource,
       capabilities: Vec<CapabilityClass>,
       confidence: Confidence,
       registry_hint: Option<String>,
   }

   struct ProbeReport {
       schema_version: u8, // = 1
       host_label: String,
       probed_at_unix: u64,
       items: Vec<OfferItem>,
   }
   ```

   The ADR 0047 invariants carry over unchanged: presence and source
   only — no values, no masked prefixes, no lengths, no secret-derived
   hashes.
2. **Probes are pure functions over an injected context, frozen as
   contract C2.**

   ```rust
   trait KeychainBackend { fn enumerate_labels(&self, store: KeychainStore)
       -> Vec<String>; } // labels only — never values
   trait CommandRunner { fn run(&self, argv: &[&str], timeout: Duration)
       -> ExitStatus; }    // scrubbed env, no shell, exit status only
   struct ProbeContext { home_dir, env, keychain: &dyn KeychainBackend,
       commands: &dyn CommandRunner, max_read_bytes }
   trait CapabilityProbe { fn probe(&self, ctx: &ProbeContext)
       -> Vec<OfferItem>; }
   ```

   A probe receives no filesystem handle and no network handle, so
   hermeticism and networklessness hold by construction, not by
   discipline. Every probe is unit-testable on any host against mock
   contexts, which is how the macOS and Windows backends are tested at
   all (see consequences).
3. **Four probe families.** (a) env/dotfile — the ADR 0047 logic,
   unchanged. (b) MCP-config — names-only, exactly as ADR 0047 decision
   3. (c) OS keychain enumeration: Linux Secret Service via the
   `secret-service` crate; macOS via `security-framework` matching known
   service-name prefixes, with the documented caveat that enumeration is
   fine but any value read triggers an OS ACL prompt we neither trigger
   nor suppress; Windows via `CredEnumerateW` over target-name prefixes.
   The pure-Rust `keyring` crate is noted as unable to enumerate and is
   not used for probing. (d) CLI-tool probes: binary presence plus
   networkless liveness — e.g. `gh auth token` exit status — never a
   call that reaches the provider (`aws sts get-caller-identity` is the
   canonical refusal).
4. **Acquisition preference is strict: MINT → INVOKE-THROUGH → IMPORT.**
   Promotion logic walks `CapabilityClass` from the top. A provider-
   native mint path (ADR 0049) is always preferred to brokering a stored
   credential, and brokering is always preferred to moving one. IMPORT
   is legacy-compat and is visibly marked as such in the offer UI.
5. **Dependency quarantine holds.** `connection-detect` stays
   serde+thiserror+std; the platform keychain backends live in the
   daemon behind the injected `KeychainBackend` trait. The daemon's
   dependency budget is recorded: `secrecy`, `zeroize`, `hyper`,
   `hyper-rustls`, `nix` are permitted; **no new** `reqwest` usage (the
   daemon already depends on reqwest for its pre-existing loopback
   proxies — the budget forbids new call sites, not the existing
   dependency); no `sqlx`, `oauth2`, `jsonwebtoken`, `chacha20poly1305`,
   or the task bus — the ADR 0047 argument against grafting the
   credential-exchange surface onto a loopback agent stands.
6. **Helper protocols are resolved, not refused.** git credential
   helpers, docker credential helpers, AWS `credential_process`, and
   kubectl exec plugins all require printing usable secret material to
   stdout. That is permitted **only** for provider-natively minted,
   short-lived, revocable derived tokens under an explicit per-connection
   policy (ADR 0049) — never for a decrypted stored credential. The
   tempting "just print the stored token" is a refusal here.
7. **Invoke-through is memory-resident end to end.** When the daemon
   brokers a call against a credential that stays on the machine, the
   token is held in `secrecy::SecretString`, zeroized on drop, and is
   never cached, persisted, logged, or transmitted; the daemon executes
   the upstream call and returns only the response. An optional
   `per_invoke_confirmation` flag makes each use a prompt (the
   `ssh-add -c` answer from ADR 0046's agent-forwarding analysis).
8. **Tailnet identity authorizes daemon callers without bearer tokens.**
   Where the daemon is reachable over Tailscale, the LocalAPI `whois`
   lookup over the tailscaled unix socket authorizes a caller by
   node/user identity instead of an operator token. This adopts the
   SPIFFE Workload API *pattern* — identity from the platform, not from
   a presented secret — without adopting SPIFFE itself. `tsidp` is noted
   as experimental, docs-only, and never load-bearing. Windows has no
   UDS daemon mode in v1: TCP plus operator token only.
9. **Prior work is cited and its license traps fenced.** The broker
   model is ssh-agent/gpg-agent generalized, inheriting the
   agent-forwarding footgun ADR 0046 already analyzed (OpenSSH 8.9
   destination constraints, per-use confirmation). Vault Agent response
   wrapping, aws-vault (abandoned upstream; the ByteNess fork is noted
   and we take **no dependency**), and 1Password Shell Plugins
   (import → wipe → inject) are the reference implementations for their
   modes. ToolHive and Docker MCP Toolkit justify meta-connector offers:
   we surface MCP *management* tools as offers rather than managing MCP
   servers ourselves. Chrome App-Bound Encryption and DBSC are why
   browser profiles are never touched — the credential is bound to the
   browser's process identity by design, so file-scanning is the floor,
   not the ceiling. **License trap:** TruffleHog v3 (AGPL-3.0) and Nosey
   Parker (GPL-3.0) detector regexes must never be copied into this
   repo; gitleaks (MIT) and Yelp detect-secrets (Apache-2.0) are safe
   pattern references, and the default remains: write patterns from
   provider documentation.

## Consequences

- Security invariants are reaffirmed and now load-bearing across four
  probe families: **value-blindness** (presence and source only),
  **no silent import** (promotion stays the explicit per-provider action
  of ADR 0047), **no network in probes** (structural, via C2),
  **loopback is not a boundary** (the operator-token and tailnet fences
  of decision 8), **egress fencing** with no credential-following
  redirects, and full **auditability** of offers and promotions.
- The macOS and Windows keychain backends are `cfg`-gated and
  **mock-tested only** — dev and CI run on Linux. This is a recorded
  limitation, not an oversight: probing behavior on those platforms is
  validated against mocked backends, and real-hardware validation is
  owed before the feature is declared complete there.
- The offer schema is versioned (`schema_version: 1`) because the
  daemon and any consumer may upgrade independently; contract C1 is
  frozen and changes are additive or a new version.
- Confidence is explicit (`low | medium | high`) so the UI can rank a
  definite keychain hit above a coincidental env var name, closing ADR
  0047's "these look configured" hedge with something a person can act
  on.
- ADR 0049 is the only path by which a helper protocol or a mint
  capability becomes real; without it, `Mintable` offers exist but the
  mint endpoint does not.
