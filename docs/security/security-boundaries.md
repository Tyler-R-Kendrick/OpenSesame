# Security Boundaries

1. **Transport vs authorization** — Tailnet membership only allows contact.
2. **AuthN vs vault unlock** — separate ceremonies.
3. **Human vault vs authority** — ciphertext-only vs broker-usable secrets.
4. **Inbound token vs outbound connection** — no passthrough.
5. **WASM guest** — no ambient FS/env/net/clock/random beyond imports.
6. **Public edge** — OAuth/webhook/ACME only; no vault read / general API.
7. **Export** — `credential.export` denied by default; step-up + audit.
8. **Breach corpus vs tenant data** — a k-anonymity prefix and a public
   catalogue fetch leave; account identifiers never do (ADR 0080).
9. **Detection vs notification** — a detector publishes a `SecurityNotice`; it
   never owns a private notification path (ADR 0080).
10. **Browser vs operator authority** — explicit origin/key-bound pairing grants
    a bounded browser capability, never an operator credential. Credential kinds
    and route ceilings remain distinct; CORS and local-network permission do not
    authenticate a request.
11. **Pairing vs verified identity vs elevated action** — local pairing reports
    unverified local assurance. Identity evidence binds a real WebAuthn ceremony
    to a frozen Host challenge. Browser control additionally consumes an exact,
    one-use run/transition/version authorization atomically with its effect.
12. **Authentication vs current authorization** — identity evidence cannot raise
    native Host role ceilings. Replay claims, membership narrowing and authority
    issuance commit together. Open browser observation streams recheck expiry,
    revocation, current membership, capability and ownership before further data.
13. **Dedicated origin vs URL path** — unrelated content on the same origin shares
    its browser trust boundary. A shared-origin demo remains restricted; endpoint
    configuration cannot turn a path into origin isolation. DPoP does not stop
    malicious JavaScript already executing at an approved origin.

Implementation and checkpoint evidence:
[Host authority review](audit-2026-09-08-host-authority.md). Pending verification
in that record is not implied complete by this boundary summary.
