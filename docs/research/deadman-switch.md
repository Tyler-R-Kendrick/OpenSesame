# Research: deadman switches for a browser-local vault

Date: 2026-10-20
Status: research behind [ADR 0209](../adr/0209-deadman-switch.md)

## Question

A person wants selected vault items to become reachable after a run of days
without authenticating on the device that configured the switch. The initial
idea was a local timer that decrypts the items and a relay that accepts a
signed event. This note asks what the state of the art actually does, and
which parts a static browser app can do honestly.

## What mature products do

| Product | Trigger | Who receives access | Delay / denial | Where the secret sits |
| --- | --- | --- | --- | --- |
| Bitwarden Emergency Access | A trusted contact **requests** access | Another Bitwarden account | Owner can approve/deny; otherwise the configured wait time lapses | Owner's vault key is encrypted to the contact's public key; server never gets the plaintext key |
| Proton Emergency Access | A trusted contact requests access | Another Proton account | Owner-controlled wait; read-only access after it | Account/key material is released by the service to the contact |
| Google Inactive Account Manager | Google's own inactivity signals (last sign-in, activity, Android check-ins) | Up to 10 trusted contacts | 3–18 months, with a warning before action | Google holds the account data; it is a service-side release |
| Apple Legacy Contact | A request after death, with the access key and a death certificate | A named contact | Apple reviews the request | Apple holds the account key material; the access key alone is not enough |
| 1Password | No inactivity switch | Emergency Kit or recovery code | None | A printed kit holds the account secret outside the service |
| KeePassXC / KeePass | No built-in inactivity release | The database file and its key, arranged by the owner | None | The owner arranges a separate handoff |

The common shape is **not** "silently decrypt for whoever opens the device".
It is a release ceremony with an independent trigger, a delay in which the
owner can deny, and a secret that only the intended recipient has. Google's
activity monitor is the only one that infers death from inactivity; it is
centralized and has the signals a static browser does not.

## What the cryptography literature says

The 2026 paper *Dead Man's Switch Cryptography* (Banerjee, Bozhko, Heitjohann
and Rupp, IACR ePrint 2026/1352) is the first formal treatment of the
primitive. It separates two modes:

- **release**: the secret goes only to designated nominees;
- **delete**: the secret is provably destroyed.

Its constructions use an evolving committee, proactive secret sharing and
public-key encryption to nominees. The important lesson for this app is not
to copy the committee: it is that a deadman switch is a **release protocol
with a recipient**, not a local boolean that turns decryption on. A single
device holding both the ciphertext and the release key is just a delayed
disclosure to whoever holds the device.

Time-lock puzzles and "decrypt after wall-clock time" constructions were also
considered. A browser has no trusted clock: `Date.now()` is controlled by the
person holding the device, and a service worker cannot be relied on to run
while the tab is closed. A local VDF would let an attacker compute the same
output early. Neither belongs in a password manager's release path.

## What webhook practice says

The operational deadman-switch pattern is a **heartbeat monitor**: the job
sends a success signal, and an independent monitor alerts when the signal is
missing, late or invalid. DataShelter's backup-monitoring guidance and
cron-monitoring services use this shape because the monitored machine cannot
be trusted to report its own failure.

The relay is therefore a witness, not a decryption service. The browser signs
each heartbeat; the relay owns the wall clock and the timeout. The webhook
contract should follow Standard Webhooks practice: an event id, a timestamp
inside the signed bytes, replay rejection, a bounded body, HTTPS only, and a
public key or shared secret agreed before the event. OpenSesame already has a
Standard Webhooks implementation in `@opensesame/webhooks`.

## Findings

1. **Inactivity is a trigger, not proof of death.** Every false positive needs
   a warning and a denial window. The owner's next authenticated unlock must
   reset the clock and be able to stop the relay.
2. **An independent clock is required.** A browser-only timestamp can be
   rolled back or forward. The relay's server time is the authority for the
   event; the local timestamp only decides when this device offers the release
   screen.
3. **Do not store the release secret next to the ciphertext.** The item
   snapshot is sealed under a random release key. The key is shown once and is
   meant to live with a trusted person, a safe, or the owner's emergency kit.
   The device and the relay never hold it.
4. **Keep the relay value-blind.** Send a schedule, a package digest, a public
   signing key and a webhook address. Never an item name, an item value, a
   vault key or a release key.
5. **Sign the policy and every liveness signal.** A tampered local record must
   fail closed. A webhook must be able to tell the owner's policy from a
   forged alert.
6. **Device locality is an honest limit.** The package is on one device and is
   not synced. If the device is destroyed, the package is gone. The relay can
   notify, but it cannot reconstruct the snapshot.
7. **Keep the snapshot explicit.** Editing an item after arming does not
   rewrite the package. The UI says a new arming is needed, and the package
   records its creation time.
8. **A release package is not a vault export.** It carries only the chosen
   items, refuses trash and drops, is capped, and is not merged or backed up.

## Resulting design

- **Arming** is two-phase. Preparation seals a snapshot under a fresh
  `osdm1_…` release key and shows the key once. Nothing is stored or sent
  until the person acknowledges that the key is stored elsewhere.
- **Commit** registers a signed policy with a user-configured relay, writes a
  sealed private record inside the vault (signing key, relay token, webhook),
  and writes the encrypted package plus a signed public record in device-local
  KV.
- **Heartbeats** are sent after each authenticated unlocking. The local record
  moves first; the relay signal is best-effort and cannot block the unlock.
- **Relay timeout** sends the webhook a release event and the public key. The
  relay does not hold the package or the release key.
- **Release** is available on the lock screen only after the local signed
  deadline. It still asks for the release key, verifies the signed record and
  the package digest, then decrypts in the tab.
- **Disarm** needs the relay's acknowledgement; otherwise a local "off" would
  leave a relay still counting down.

The full decision, threat model and limits are in
[ADR 0209](../adr/0209-deadman-switch.md).

## Sources

- Banerjee, Bozhko, Heitjohann and Rupp, *Dead Man's Switch Cryptography*,
  IACR ePrint 2026/1352.
- Bitwarden, *About Emergency Access* and *Request & Grant Emergency Access*.
- Proton, *Emergency access*.
- Google, *About Inactive Account Manager* and the 2021 Google Online Security
  Blog post on inactivity planning.
- Apple, *How to add a Legacy Contact for your Apple Account*.
- 1Password, *Get to know your Emergency Kit* and *Implement a recovery plan
  for your family*.
- DataShelter, *Backup Monitoring: Solving the Dead Man's Switch Problem*.
- Standard Webhooks specification; OpenSesame's `@opensesame/webhooks`.
