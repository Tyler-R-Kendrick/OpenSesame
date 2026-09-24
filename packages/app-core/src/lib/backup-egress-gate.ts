/**
 * Whether git backup may make its *automatic* calls now: the observer's
 * start, its webhook poll and the push after a vault mutation (ADR 0138).
 *
 * Git backup is always on, and always on is not a way round the operator's
 * network envelope (ADR 0135 §1). A plan that does not allow external
 * services — the Family preset, a managed policy, an unverified one, or no
 * plan yet — holds every automatic call, whichever surface asked for it: the
 * capability's background job, a Settings tile reading the backup status, or
 * a target being enabled. A sync a person asks for by hand is theirs to ask.
 *
 * `allowedServiceOrigins` is not read here, as no runtime consumer reads it
 * yet (ambient SSO included); an operator who needs git backup silent sets
 * external services to deny.
 */

import { compositionStore } from "./capabilities/store.js";

export const backupEgressGate = {
  allowed: (): boolean =>
    compositionStore.getSnapshot().plan?.network.externalServices === "allow",
};
