/**
 * The files Settings › Security keeps (ADR 0134): Travel's safe list and the
 * device duress code's status, wired to the seams the Travel and Duress
 * sheets use — the same reads, the same write, the same fence.
 */

import {
  DEVICE_DURESS_PROFILE,
  duressStatus,
} from "../../lib/duress/settings/device-duress.js";
import { kvDurability } from "../../lib/kv.js";
import { activeProject } from "../../lib/projects.js";
import { retiredCredentialStatus } from "../../lib/retired-credentials/index.js";
import { readSafeFlags, writeSafeFlags } from "../../lib/travel/safe-flags.js";
import { listDeviceVaults } from "../../lib/vaults.js";
import { duressStatusFiles } from "./duress-status-files.js";
import { retiredCredentialFiles } from "./retired-credential-files.js";
import { travelSafeFiles } from "./travel-safe-files.js";
import {
  type VirtualFileProvider,
  mergeFileProviders,
} from "./virtual-files.js";

/** `owner`: an open vault's owner is at the device — the Duress row's own test. */
export function securityFiles(
  owner: () => boolean,
  tomb: () => string = () => activeProject().id,
): VirtualFileProvider {
  return mergeFileProviders([
    travelSafeFiles({
      owner,
      vaultIds: () =>
        listDeviceVaults()
          .filter((vault) => vault.kind !== "guest")
          .map((vault) => vault.id),
      read: readSafeFlags,
      write: writeSafeFlags,
      held: () => duressStatus().incidents > 0,
      durable: () => kvDurability() !== "memory",
    }),
    duressStatusFiles({
      owner,
      status: duressStatus,
      profileId: DEVICE_DURESS_PROFILE,
    }),
    retiredCredentialFiles({
      owner,
      status: () => retiredCredentialStatus(tomb()),
    }),
  ]);
}
