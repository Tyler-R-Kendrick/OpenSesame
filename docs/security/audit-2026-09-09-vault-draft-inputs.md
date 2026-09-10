# Vault draft generation and input boundaries

Date: 2026-09-09. Local implementation review, not a model-backed security scan.

New-item forms previously reused empty record construction, and their URL
prefills lacked a shared validation boundary. The fix isolates new drafts from
imports/edits, uses the existing cryptographic generator, and validates public
prefills before applying any of them. Unknown fields, concealed values,
duplicate parameters, credential-bearing URLs and unsupported scalar values
are refused without echoing their contents. Certificate issuance now requires
an explicit common name instead of silently substituting localhost.

On-device label suggestions receive only an authored category and an explicitly
previewed website origin. No vault record, existing username, field value, DOM,
storage, URL path or free-form instruction is passed to the model. Model output
is bounded and parsed into exactly two plain-text labels. Applying suggestions
requires a separate human action. Closing/replacing the ceremony aborts its
request and disposes of the isolated model session. Model download requires an
explicit disclosed human action and browser user activation; WebMCP cannot
request it. There is no remote-model fallback.

Validation evidence:

- Pages suite: 265 files, 3,318 tests passed.
- New generation/suggestion modules: 100% lines/functions, 97.27% branches
  in the focused V8 run; this is not whole-repository coverage.
- Native Chromium 151 WebMCP: 20 unlocked / 3 locked tools, 48 CDP
  invocations, including defaulted forms, suggestions, prefills and refusals.
- Static-origin guest/Shoo-mock checks passed with zero page/console errors,
  missing assets or loopback requests. Desktop/mobile form checks passed.
- Pages typecheck, structural/package quality and all three bundle budgets
  passed without raising baselines. No dependencies were added.

The available browser had no ready local language model. Real model inference
is **not** claimed: Prompt API binding, output validation, preparation consent,
refusals and cancellation were tested with a controlled API seam; native
Chrome discovery/invocation and the unsupported-model UI were tested live.

Residuals: public-prefill authors must classify their actual values as public;
an unconcealed field is not automatically harmless. Once a caller has put a
secret in a URL, the app cannot remove it from prior history or server logs.
Generated credentials are proposals, not upstream provisioning. Same-origin
malicious JavaScript is outside the protection offered by local inference.
See ADR 0100 and `docs/operators/vault-draft-links.md`.
