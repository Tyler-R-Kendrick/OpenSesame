/** Optional metadata delivery cannot change credential admission or local evidence. */
import type { RetiredCredentialEvent } from "../retired-credentials/records.js";

export async function queueRetiredCredentialObservation(
  tomb: string,
  event: RetiredCredentialEvent,
): Promise<void> {
  try {
    const [
      { queueCredentialObservation },
      { currentCredentialObservationIdentity },
    ] = await Promise.all([
      import("./queue.js"),
      import("../credential-canaries/owner.js"),
    ]);
    await queueCredentialObservation(tomb, {
      v: 1,
      eventId: crypto.randomUUID(),
      vaultIdentity: currentCredentialObservationIdentity(tomb),
      ...event,
    });
  } catch {
    /* An unavailable receiver or legacy identity never restores retired authority. */
  }
}
