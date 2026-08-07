# Security Boundaries

1. **Transport vs authorization** — Tailnet membership only allows contact.
2. **AuthN vs vault unlock** — separate ceremonies.
3. **Human vault vs authority** — ciphertext-only vs broker-usable secrets.
4. **Inbound token vs outbound connection** — no passthrough.
5. **WASM guest** — no ambient FS/env/net/clock/random beyond imports.
6. **Public edge** — OAuth/webhook/ACME only; no vault read / general API.
7. **Export** — `credential.export` denied by default; step-up + audit.
