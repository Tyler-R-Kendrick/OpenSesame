/**
 * `storage.encrypted-search` — the databases this browser keeps for
 * identifiers (history backups, retired-password digests) become encrypted
 * databases in which no table, field, id or name is readable, and which can
 * still be searched by blind index (ADR 0173).
 *
 * The contribution is a routing, not a surface: the core stores answer
 * through a seam (`HistoryRowStore`, `PasswordDigestStore`) that this module
 * points at the encrypted ones for as long as the capability is on, moving
 * what the device-sealed databases held and deleting them. Turning it off
 * routes back; the encrypted databases stay, unreadable without the device
 * key, until Reset this browser removes them.
 *
 * Egress: none. Everything stays in this browser profile.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { installEncryptedStores } from "@opensesame/app-core/lib/encrypted-db/install.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "storage.encrypted-search";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    const stores = installEncryptedStores();
    activation.onDispose(stores.uninstall);
    return activation.handle();
  },
};
