# Travel mode — 1Password's design and the state of the art

> Research behind [ADR 0140](../adr/0140-travel-mode.md). Checked
> 2026-09-24. Sources are linked inline. Where a point is an inference and
> not a documented fact, it says so.

## 1. 1Password Travel Mode

- **Where it is switched.** Only on 1Password.com (name → Manage Account →
  Travel Mode), and switched off there too. The apps have no switch.
  <https://support.1password.com/travel-mode/>
- **The per-vault flag.** A vault is marked **Safe for Travel** on the web.
  While Travel Mode is on, only those vaults stay in the apps and the browser
  extension, and the others are also unavailable on 1Password.com.
- **Deleted, not hidden.** The other vaults are "entirely removed from your
  devices", including their items and encryption keys. The launch post says
  "There are no traces left for anyone to find."
  <https://1password.com/features/travel-mode>,
  <https://1password.com/blog/introducing-travel-mode-protect-your-data-when-crossing-borders>
- **Devices must sync.** "Whenever you turn Travel Mode on or off, you'll need
  to open 1Password on your devices while connected to the internet for the
  change to take effect." A device that never syncs keeps every vault. Turned
  off, the vaults return on the next sync.
- **No indicator.** At launch 1Password said there is no way to tell Travel
  Mode is on. The current support page is silent on this.
- **Business accounts.** Administrators decide which shared vaults are safe
  for travel and turn Travel Mode on or off per member. It stays on "until the
  team member *or* a team administrator turns it off", so the member can end
  it with their own credentials.
- **A limitation 1Password documents.** "Travel Mode removes vaults from the
  browser extension, but it doesn't stop the extension from signing you in to
  1Password.com." Anyone who can unlock the extension can turn Travel Mode
  off. 1Password advises removing the extension before travel.
- **2025–2026.** No documented change to the design.

## 2. Comparable designs

| Design | What it does | How it differs |
|---|---|---|
| [GrapheneOS duress PIN/password](https://grapheneos.org/features) | Entering the duress credential at any prompt wipes the device and its eSIMs, without a reboot and without a way to interrupt it. | Destroys everything instead of choosing what stays. Separate 72-hour auto-reboot. |
| [Apple Stolen Device Protection](https://support.apple.com/en-us/120340) | Away from familiar places, sensitive actions need biometrics with no passcode fallback, and critical changes wait an hour. | Limits a thief who knows the passcode. Nothing leaves the device. |
| [iOS inactivity reboot](https://www.magnetforensics.com/blog/understanding-the-security-impacts-of-ios-18s-inactivity-reboot/) | After 72 h (iOS 18.1) the Secure Enclave reboots the phone into Before First Unlock. | A lock-state protection, not a data-minimisation one. |
| [Android Identity Check](https://security.googleblog.com/2025/01/android-theft-protection-identity-check-expanded-features.html) | Biometrics required for sensitive actions outside trusted places; optional 72 h auto-restart. | Same class as Apple's. |
| [VeraCrypt hidden volumes](https://veracrypt.io/en/Plausible%20Deniability.html) | A second volume inside the first volume's random free space. | Deniability through encryption. Snapshots taken at different times show which sectors changed. |
| [Keeper self-destruct](https://help.keeper.io/article/163-what-is-self-destruct) | Erases the local vault after five failed logins; the cloud copy stays. | Triggered by an attacker, not planned by the owner. |
| Bitwarden, Proton Pass, Dashlane | No travel mode. Bitwarden's [request](https://community.bitwarden.com/t/travel-mode/6364) dates from 2019. Proton's [request](https://protonmail.uservoice.com/forums/953584-proton-pass/suggestions/48536921-travel-mode) has no status. | — |

No password manager shipped a travel or border mode in 2024–2026.

**EFF border guidance (2025).** Don't lie to border officials, and don't
volunteer what they don't ask for. Log out of accounts you don't want
accessed. Border officers have no authority to search live cloud content.
Power devices off before crossing. EFF names 1Password's travel vaults.
<https://www.eff.org/deeplinks/2025/06/journalist-security-checklist-preparing-devices-travel-through-us-border>

## 3. Criticisms of 1Password's design

- **It invites a lie.** Schneier: "When … asked … 'have you enabled travel
  mode,' you can't tell them the truth. In the US, lying to a federal officer
  is a felony." Also: "Since you can turn travel mode off at will, a border
  official can just demand you do so." 1Password's security lead, Jeffrey
  Goldberg, advised against lying and framed Travel Mode as a way to make
  complying with a search safe.
  <https://www.schneier.com/blog/archives/2018/07/1passwords_trav.html>
- **The account is still one sign-in away.** The vaults still exist in the
  account. Whoever can compel a web sign-in (account password and Secret Key)
  or an unlocked extension can turn Travel Mode off.
- **Hiding looks suspicious.** Taking data out of reach can itself be a
  reason for further questions.
- **Timing.** Travel Mode has to be on, and every device synced, before the
  border. A phone that stayed offline still holds everything.
- **Traces (inference, untested).** Only 1Password's own "no traces" claim
  exists. What an almost-empty account, the business "People traveling"
  record, or leftovers in the OS reveal has not been independently audited.

## 4. What a good travel mode needs

1. **The switch is held somewhere other than the carried device.** A
   server, a second device, or another person. The carried device must not
   be able to end travel mode on its own.
2. **The data is deleted, not hidden.** Item data and the keys that wrap it
   leave the device's storage, caches and indexes, and come back only from
   somewhere else.
3. **The owner marks each vault safe to carry.** Off by default, so a vault
   nobody thought about stays home.
4. **The removal is confirmed.** The device reports that the removal took
   effect.
5. **Honesty or concealment is chosen on purpose.** A hard lock the
   traveller truly cannot undo (another person's approval, a code left at
   home) makes "I cannot open it" a true statement. A hidden indicator
   pushes the traveller toward lying.
6. **No other way back in.** Signed-in sessions, backups and recovery routes
   must not quietly reopen what left.
7. **It stays separate from duress wipe.** Travel mode is planned in
   advance; duress is a response at the moment of coercion. They should
   compose, not merge.
8. **Policy only narrows.** An administrator can require travel mode but
   can never widen what a traveller carries.

## 5. What OpenSesame takes from this

OpenSesame Pages has no server to hold the vaults that stay home
([ADR 0090](../adr/0090-static-frontend-complete-without-backend.md)). So the
place they go is the answer to lesson 1: a **bundle** sealed under a
**return code**, both kept off the carried device. The design is in
[ADR 0140](../adr/0140-travel-mode.md).
