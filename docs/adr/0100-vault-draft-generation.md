# ADR 0100: Generated vault drafts and public link prefills

Status: accepted · 2026-09-09

## Decision

New-item creation uses `lib/vault/new-draft.ts`; imports and edits keep the
existing model constructors. New drafts receive an editable name, a fictional
username alias where the type declares one, and independent WebCrypto-generated
passwords, PINs and custom-secret values. Manifest defaults remain authoritative
for non-concealed fields. Issued credentials, real identities, authenticator
enrollment seeds, certificates and payment details are not fabricated.

Links open `/vault/new/{installed-type}` with a bounded, closed query vocabulary:
`name`, `username`, `uri`, `folder`, `ref`. These are public suggestions only.
Typed items additionally accept `field.<id>` for manifest-declared scalar
string, URL, number, boolean, select and country fields. Secret fields, personal
record types, multiline values and unknown fields are refused. Select values
must occur in the manifest's closed options. The link author must classify the
actual content as public; a text field's type alone does not establish that.
Duplicate/unknown keys, control characters, malformed identifiers and URLs with
credentials/query/fragment are refused as a whole. Links never submit, approve,
invoke a model, or supply secret values. Existing folder/path handling remains
the saving authority. The type in the path stays locked.

On-device AI can suggest only a name and fictional username. The human sees the
exact category/site-origin context before requesting inference and previews the
result before applying it. Existing item values, vault contents, DOM, storage,
free-form instructions and URL paths do not enter the prompt. We reuse the native
Prompt API adapter; no remote fallback or bundled credential. Model preparation
requires explicit UI consent and active browser user activation, never a link
or agent request. An unavailable model leaves the generated defaults intact.

The existing WebMCP metadata tool supports `action=suggest`, with `source=random`
or explicit `source=browser`. Suggestions return labels only and never save.
The navigation tool accepts the same public prefill vocabulary. Generated secret
values may be sealed by normal creation but never appear in tool results.
This extends `vault.items.write_meta` and `app.navigate`, not an agent reveal API.
Browser-only inference remains on WebMCP; native MCP servers do not pretend to
have a browser model or acquire the browser's vault.

## Consequences

Generated credentials are proposals, not evidence that an upstream account was
created or changed. People adding an existing account must replace them with its
actual credential. Link authors must never place confidential data in query
parameters: browser history, hosting logs and referrers are outside vault custody.
Public metadata is not authenticated provenance. Same-origin malicious script is
not contained by a local model or a non-extractable vault key.

Tests cover generation, import preservation, hostile links, AI output validation,
session disposal and approval-before-apply. The native Chrome WebMCP gate exercises
discovery, defaulted forms, metadata suggestions and prefilled navigation through
CDP rather than an injected registration mock.
