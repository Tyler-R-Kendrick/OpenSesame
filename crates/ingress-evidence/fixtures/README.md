# Shared RFC 9440 parser corpus

Read by `crates/ingress-evidence/src/corpus_tests.rs` and
`packages/ingress-evidence/src/corpus.test.ts`. A case is a list of physical
header fields (`[name, value]`, wire order), optional limit overrides, and one
expected outcome: `{"ok": {leaf_sha256, intermediates_sha256}}` or
`{"error": <code>}`. The codes are the `IngressError::code()` /
`IngressErrorCode` strings; every code is pinned by at least one case.

The certificates are public bytes only. They were made once with `openssl`
(P-256, 100-year validity so the corpus never ages out): a root, an
intermediate (`pathlen:0`), and two end-entity certificates with
`extendedKeyUsage=clientAuth` and DNS + SPIFFE-style URI SANs. Their private
keys were deleted; nothing in this directory can sign anything.
