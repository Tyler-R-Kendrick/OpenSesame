/**
 * What browser-local IAM can vouch for about the unlocked vault (ADR 0160).
 *
 * The device Identity host reports `provisional` for every session. It
 * reports more only when a *local identity session* from a real passkey
 * authentication (ADR 0104: the WebAuthn verifier ran, the evidence was
 * spent once, the session is bound to this origin and this vault) is live in
 * this tab. It does not ask for a passkey, and it does not read one from how
 * the vault was opened: unlocking with a password proves a password.
 */

import type { DeviceAssurance } from "./device-identity-routes.js";
import {
  type LocalSession,
  currentLocalIdentitySession,
  listLocalIdentitySessions,
} from "./local-sessions.js";

/** The two reads of local sessions this needs, as a port a test can fake. */
export type LocalSessionPort = Readonly<{
  list(tomb: string): Promise<readonly LocalSession[]>;
  current(tomb: string, principalId: string): Promise<LocalSession | null>;
}>;

export function passkeyAssuranceFrom(
  port: LocalSessionPort,
): (tomb: string) => Promise<DeviceAssurance | null> {
  return async (tomb) => {
    try {
      for (const row of await port.list(tomb)) {
        if (row.authentication !== "passkey") continue;
        // Held by this tab and still valid under the shared fence: a record
        // another tab wrote is not evidence this tab can present.
        const held = await port.current(tomb, row.principalId);
        if (held?.authentication === "passkey") {
          return { level: "phishing_resistant", verifiedAt: held.authTime };
        }
      }
    } catch {
      // Locked, no Web Locks, or unreadable: no proof, so no assurance.
    }
    return null;
  };
}

export const localPasskeyAssurance = passkeyAssuranceFrom({
  list: listLocalIdentitySessions,
  current: currentLocalIdentitySession,
});
