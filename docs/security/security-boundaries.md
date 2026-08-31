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
