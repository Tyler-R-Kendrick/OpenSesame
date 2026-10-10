/**
 * `src/lib/vault-relay*`: sealed snapshot push and pull (ADR 0181).
 *
 * Split out of `classification-lib.ts` for the 400-line module budget.
 * Re-exported from there so the lib rule list stays the one callers import.
 */

import { optional } from "./classification-rule.js";

const L = "src/lib/";

export const VAULT_RELAY_RULES = [
  // No trailing slash: `vault-relay/` is the client, and `vault-relay-sync*`
  // is the two-device check. Both belong only to sharing.relay (ADR 0181).
  optional(
    `${L}vault-relay`,
    "sharing.relay",
    "sealed snapshot push and pull on a paired relay (ADR 0181)",
  ),
];
