# D7-2 adversarial review (rubber duck)

**Status:** Overrides `D7-2-DEVICE-KEY-RESEARCH.md` where they conflict.

## Threat model (summary)

- Same-user writable daemon state and trust store; attacker with user UID can rewrite files.
- PTY is a TTY; agents can supply one — **no** `/dev/tty` enrollment fallback.
- Loopback TCP does not bind to a kernel peer; approvals must use UDS peer credentials.
- Downgrade paths (`oschip1`, ARK-only after passkey) must be closed.

## Decisions

1. **Headless enrollment:** Hosts without an OS secure prompt **refuse local enrollment**. No `--allow-tty-enroll`. Headless machines join only as a **remote CLI** endorsed from a machine with a real OS prompt.

2. **Key custody:** The **unlocked app** holds key material for secrets. Authenticate the daemon trust store: **versioned**, with an **ARK-signed epoch** the PWA verifies. Lost or altered store → **fail closed**, never silent re-enrollment. Recovery requires a human at a real OS prompt.

3. **Enrollment entry:** Replace TTY checks with a credential the attacker lacks: **OS prompt** (fixed APIs, show code-signing identity), with the **host arming** the enrollment window first.

4. **Bootstrap:** Freeze approver key and origin in the first message; daemon **proves itself** with a signature; **operator token not** on the enrollment path; **fingerprint/SAS** on both ends; **alarm** on changed ARK or `D_pub`.

5. **Downgrade closure:** Wipe legacy pairings; reject `oschip1`/`oschip2` downgrade; **no ARK-only fallback** once a passkey exists.

6. **Passkey tiering:** Software or virtual passkeys may authorize **low-risk verbs only** — never `run`, `env-resolve`, or reveal-class verbs.

7. **Approval hygiene:** More than one pending approval → **refuse all**. Sessions tied to **kernel peer**. **No approvals over loopback TCP.**

## Residual risks (honest)

- OS secure prompts vary by platform; a compromised desktop session can still click through.
- Same-user malware can race the enrollment window while armed; arming TTL and single-flight mitigate but do not eliminate.
- Remote CLI endorsement shifts trust to the endorsing machine; compromise there affects joiners.
- Software passkey detection relies on authenticator metadata; misclassification is possible until WebAuthn signals are wired end-to-end.
