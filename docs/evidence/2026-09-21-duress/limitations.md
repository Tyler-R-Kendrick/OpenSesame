# Duress documentation — honest limitations

These statements are **normative for product copy**. If UI, receipts, or
marketing contradict them, that is a defect (DOCS-F / REDTEAM-E).

## Personal safety

OpenSesame duress profiles **do not**:

- Replace a personal safety plan, physical security measures, or emergency
  services.
- Detect coercion, guarantee undetectable use under observation, or ensure
  that alert recipients can help in time.
- Prove that WebAuthn user verification was biometrics or that the holder
  acted willingly (INV-07).

## Forensic erasure and cleanup

Local removal is **enumerated application cleanup** of owner-approved
resources in this origin (INV-22). It is **not**:

- Cryptographic erasure of all historical ciphertext.
- Secure deletion against forensic disk analysis.
- Automatic purge of peer replicas, cloud provider data, or designated
  backups (INV-23, INV-24, AT-081).

Application cleanup, key retirement, provider revocation, and global replica
deletion must never be conflated in UI or receipts (INV-23).

## Clocks and holds

Local application holds are **not** tamper-resistant clocks (INV-19).
Changing the client clock may affect local-only duration handling. Hold
expiry only permits a **fresh recovery attempt**; it never automatically
decrypts data or restores privileges. Independent-authority holds are
enforced by that authority’s durable state when reachable — not by hope on
an offline phone.

## Alerts and acknowledgements

- Queued ≠ delivered ≠ recipient-received ≠ human-acknowledged ≠ emergency
  response (INV-16).
- Notification acknowledgement **never unlocks** anything (INV-14).
- Alert failure/expiry never triggers unconfigured deletion or silently
  changes the visible profile (INV-17).

## Historical residual access

An old offline snapshot with a still-usable old key remains decryptable.
Root rotation is **not** retroactive secrecy (INV-24). Exposure summaries
must set `historicalCopyDisclosure` when applicable.

## Distributed atomicity

Local transitions aim for crash consistency; external effects are idempotent
with separately reported outcomes. The product **does not** claim
cross-system atomic commit (INV-31).
