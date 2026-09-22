# ADR 0130 — Browser-local SOPS

- **Status:** Accepted
- **Date:** 2026-09-22
- **Deciders:** OpenSesame maintainers
- **Supersedes:** [ADR 0129](0129-vault-key-protection-manifest.md) §7

## Context

ADR 0129 §7 said SOPS YAML and JSON documents with local age identities
"run in the static browser" and that a native `sops` binary "is an optional
operator tool and is not required for the PWA". The shipped code did not do
that, and it took two commits to get from there to here.

As of `7724fa3`, `lib/vault/protection/sops-browser.ts` stated plainly that
SOPS YAML/JSON was "not available in-browser" and directed the person to
`opensesame pass protect sops-encrypt|sops-decrypt` "with
`OPENSESAME_SOPS_BIN`". On the GitHub Pages deployment — no Host, no daemon,
no way to reach a local binary — that is an instruction nobody can follow,
and phrasing it as an environment variable made an absent feature look like
a configuration mistake.

`424bc48` removed that wording and started a browser engine: roughly 2,100
lines covering the record format, a tree, YAML and JSON codecs, Shamir, and
a vault-secrets sheet. It was a real start and it was not finished. There
was no way to open an arbitrary SOPS document — Settings → Formats offered
the native manifest, the vault sheet and age armor, and nothing else — while
the SOPS row already claimed read, write and "this browser". Nothing checked
any of it against upstream `sops`, in either direction.

So the state this ADR replaces is not "a prompt for an environment
variable"; it is a panel whose claim about itself was ahead of what it could
do.

[ADR 0090](0090-static-frontend-complete-without-backend.md) already
forbids putting a local host in front of a browser capability. A prompt for
`OPENSESAME_SOPS_BIN` is exactly that prompt in a different costume.

## Decision

1. **The engine is ours, it runs in the browser, and the whole workflow is
   reachable.** SOPS YAML and JSON encrypt, decrypt, edit, import and export
   with local age identities are implemented in `apps/pages/src/lib/sops`
   and execute in the page, in a module Web Worker, on a static origin. A
   person can open an arbitrary SOPS document from Settings → Formats, not
   only export the vault into one. No Host, no daemon, no browser extension,
   no installed `sops`, no environment variable, no Node service, no
   serverless function and no separately installed runtime takes part.
   `pnpm verify:sops-browser` scans the built bundle so no native runtime —
   `OPENSESAME_SOPS_BIN` included — can come back by accident.

2. **Upstream owns the wire format; we match it, we do not define it.** The
   compatibility target is SOPS v3.13.3 (source commit
   `26e2f4784ca61353082c32dbd987c25eda086dc9`). Where upstream's behaviour
   is surprising — Go's float formatting, base-0 integer parsing, comments
   as tree items, the `:`-terminated path AAD, the MAC sealed under
   `lastmodified` — the engine reproduces upstream, and
   `docs/security/sops-wire-compatibility.md` records why. A pinned,
   checksum-verified upstream binary is the oracle for
   `pnpm verify:sops-conformance`; a missing oracle reports **incomplete**
   and never a pass.

3. **Refuse rather than reinterpret.** Anything the engine does not
   implement exactly — an unsupported master-key kind, a regex feature
   outside the RE2 subset, a YAML alias, a merge key, a non-string key, a
   duplicate key, an unknown tag — is an error naming the unsupported
   feature. The engine never silently drops a recipient, flattens a
   threshold group to any-of, re-types a scalar, or writes a document it
   cannot read back.

4. **Key groups keep their threshold.** One group is an OR of its master
   keys; several groups are a Shamir threshold over distinct groups, with
   upstream's default of all groups. A document whose threshold cannot be
   met fails to open; it is never opened partially and never rewritten with
   a weaker policy.

5. **Nothing leaves the origin for local age.** The whole local-age path is
   offline-capable and is verified offline. The cloud master-key adapters
   (AWS KMS, Azure Key Vault, GCP KMS) are wire-contract implementations
   only: they are unit-tested against the documented encodings, they are
   not claimed to work against every provider or tenancy, and
   `pnpm verify:sops-cloud-live` is optional and reports
   **blocked-external** when no disposable resource is supplied.

6. **SOPS remains a document format.** It is not a vault root protector.
   ADR 0129's manifest is unchanged by this ADR; only §7's implementation
   claim is replaced by an implemented one.

7. **Agents do not get a decryption oracle.** Document plaintext is reached
   only through a handle bound to an execution permit and the session
   generation, and never through an agent-facing surface. This is
   [ADR 0005](0005-authority-handle-connectionref.md)'s boundary applied to
   documents.

## Consequences

- Settings → Formats can open, decrypt, edit, encrypt and save a SOPS
  document on `tyler-r-kendrick.github.io/OpenSesame/`, offline, with no
  backend of any kind — which is what ADR 0129 §7 promised.
- `pnpm verify:sops-browser` (product gate, required) and
  `pnpm verify:sops-conformance` (compatibility gate, required, incomplete
  without the oracle) join the local gate set;
  `pnpm verify:sops-cloud-live` is optional and separately reported.
- Fixing this exposed a production bug outside SOPS: the service worker was
  adding `Cross-Origin-Embedder-Policy: require-corp` to navigations while
  serving worker scripts without it, which broke **every** dedicated worker
  on the installed app, including the pre-existing website-pattern worker.
  `apps/pages/src/sw.ts` now sets the matching headers on worker responses.
- Upstream can change its wire format. The pin, the checksums and the
  conformance gate make that a visible failure rather than a silent
  incompatibility, but they do not prevent it: a SOPS release newer than
  the pin is untested here until the pin moves.
- Documents are bounded (8 MiB input, 64 levels, 100,000 nodes, 32
  documents, 32 groups, 128 recipient entries). A document above a bound is
  refused with a named limit rather than degraded.
