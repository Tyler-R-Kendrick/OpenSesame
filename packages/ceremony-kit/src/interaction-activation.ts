import type { InteractionAuthenticator } from "./interaction-approval.js";
import type { InteractionClient } from "./interaction-client.js";
/** Challenge/assertion/completion share the original surface operation. */
export async function activateInteraction(
  client: InteractionClient,
  authenticator: InteractionAuthenticator,
  ref: string,
  digest: string,
  check: () => void,
): Promise<string | null> {
  check();
  const challenge = await client.beginInteractionActivation(ref, {
    requestDigest: digest,
  });
  check();
  const assertion = await authenticator.assert(challenge.options);
  check();
  const confirmed = await client.completeInteractionActivation(ref, {
    activationId: challenge.activationId,
    ...assertion,
  });
  check();
  return confirmed.activationId === challenge.activationId
    ? challenge.activationId
    : null;
}
