# Local application issuance transaction binding

The final browser-local code-issuance fence checked a consumed request's
identity, version, approving key and expiry, but did not compare the transaction
being issued with the transaction approved by the human.

A regression using real encrypted request storage and the existing passkey test
fixture consumed an approved request, then called issuance with a different
nonce. Before the fix this returned a code. The normal popup redemption wrapper
already checked the transaction digest; this finding concerns the lower-level
issuance boundary, not a demonstrated remote popup exploit.

Creation, redemption and final issuance now share one canonical authorization
digest. Issuance compares that digest against the persisted request under the
existing application/session fence. Nonce, state and PKCE challenge substitution
tests reject at this final boundary. Existing identity, key-revocation, policy
revision, expiry and consumption checks remain in place.

Focused validation: 73 tests across local request authorization, application
authorization, access requests, issuer-channel and agent authentication/authorization
suites passed. All 14 desktop/mobile browser-local IAM journeys passed, including
real passkey approval, person/agent application sign-in and relying-party refusal
after revocation or policy change. Pages build, scoped anti-slop and structural
quality checks also passed. This is not a full security scan or a claim that all
browser-local IAM work is complete.

The low-level issuance functions still support the existing explicit consent
caller contract without a request reference. This change strengthens supplied
request binding; it does not claim to eliminate every alternative internal
issuance path or protect against malicious same-origin code in an unlocked vault.
