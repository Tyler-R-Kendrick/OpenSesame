/** A verified native identity follows the same vault and account-link outcomes as an OIDC return. */
import { storeAuthOutcome } from "./auth-outcome.js";
import { assertConfiguredIdentitySessionTrusted } from "./federation-configured-token.js";
import {
  type UpstreamIdentity,
  displayName,
  saveSession,
} from "./federation.js";
import { adoptFederatedIdentity, openVaultAfterSignIn } from "./guest-auth.js";

export async function admitConfiguredIdentitySession(
  identity: UpstreamIdentity,
): Promise<void> {
  assertConfiguredIdentitySessionTrusted(identity);
  saveSession(identity);
  const adopted = await adoptFederatedIdentity(identity.idToken);
  const inApp = await openVaultAfterSignIn();
  if (inApp || adopted.kind === "pending_link") return;
  storeAuthOutcome(
    adopted.kind === "linked" || adopted.kind === "local"
      ? { kind: "linked", who: displayName(identity) }
      : {
          kind: "link_failed",
          who: displayName(identity),
          detail: adopted.reason,
        },
  );
}
