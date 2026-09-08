# Static authentication artifact validation

Date: 2026-09-08

The release generator now builds from clean, committed SDK inputs. Candidate
1.0.2 was rebuilt from `6ba92e2a2ba701fc859b20646cf06d94809956fb`; earlier
unpublished local candidates were retired, not represented as deployed releases.

The approved generated-code policy replaces authored-code Biome checks only for
the exact manifest-listed bundles. It does not exclude their directory or source.
Both normal lint entry points require an exact regular-file inventory, SHA-384
sidecars, syntax validation without execution, byte-for-byte source rebuild,
SDK tests, and shipped-byte tests. Prior reviewed hashes cannot be removed or
changed by updating the manifest alongside an artifact. Later releases retain
historical inventory and the frozen compatibility alias.

Validation performed against the regenerated candidate:

- Artifact policy: 17 passing cases, including hash changes, symlinks, extra
  files/directories, broader lint exceptions, and immutable release transitions.
- SDK source: 27 passing tests; shipped-byte contract: 2 passing tests.
- Chromium against fixture Identity: actual CORS, SRI, code/PKCE, nonce,
  issuer/state binding, single-use callback, and server code replay passed.
- Repeated in-memory builds matched the checked-in candidate bytes.

The source commit is a generation-time audit reference, not a cryptographically
authenticated provenance claim. The checker verifies current source against the
artifact; it does not authenticate that historical commit annotation after a
squash merge. SRI likewise authenticates pinned bytes, not publisher intent.
Repository review and release controls remain necessary. Full integrated
verification and remote delivery must be recorded separately when completed.

## Additional gate review

The artifact policy now has 23 passing cases. Added regressions reject invalid
UTF-8 rather than hashing replacement characters, indirect ignore patterns, and
global lint disabling outside the exact generated-file override. SDK bytes are
unchanged; the original generation and browser evidence above remain valid.

## Browser entry-point coverage

Four additional tests exercise the actual browser entry points with simulated
browser ports and HTTP responses, without mocking protocol modules. They prove
that hosted navigation and absent callbacks emit no authenticated event,
unsolicited callbacks are scrubbed and refused, and both distributed entry points
wait for the pinned active-session verdict and redact rejection details.

The same V8 package measurement before and after these tests reports lines
74.03% → 87.29%, functions 77.77% → 96.29%, statements 73.54% → 86.24%, and
branches 78.85% → 82.28%. This is scoped unit coverage, not repository-wide
coverage or a claim that aggregate coverage floors passed. All 31 SDK tests,
typechecking, strict authored-source lint, and the complete artifact gate pass;
production source and immutable artifact bytes are unchanged.
