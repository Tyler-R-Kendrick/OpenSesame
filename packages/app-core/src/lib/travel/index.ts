/**
 * Travel mode (ADR 0143): cross a border carrying only the vaults that are
 * safe to carry. The rest leave this device whole, sealed in a bundle under
 * a return code the traveller does not carry, and come back from both.
 */

import { kvHydrate } from "../kv.js";
import {
  forgetDepartedProjects,
  projectScopedKeys,
  refreshProjectsView,
} from "../projects.js";
import { vaultStore } from "../vault/store.js";
import { tombStorageKeys } from "../vault/tomb-migration.js";
import { listDeviceVaults } from "../vaults.js";
import {
  type CompleteOutcome,
  type DeparturePackage,
  type PackOutcome,
  type TravelDeps,
  completeDeparture,
  packDeparture,
} from "./depart.js";
import {
  type OpenReturnOutcome,
  type OpenedReturn,
  type ReturnReceipt,
  completeReturn,
  openReturn,
} from "./return.js";
import { originTravelStorage } from "./storage.js";

export type {
  CompleteOutcome,
  DepartingVault,
  DeparturePackage,
  DepartureReceipt,
  DepartureRefusal,
  PackOutcome,
  TravelDeps,
  TravelVaultInfo,
} from "./depart.js";
export type { TravelPlan, TravelPlanRefusal } from "./plan.js";
export type {
  OpenReturnOutcome,
  OpenedReturn,
  ReturnPreview,
  ReturnReceipt,
  ReturnRefusal,
  ReturnStatus,
  ReturningVault,
} from "./return.js";

async function duressActive(): Promise<boolean> {
  const { duressSessionFence } = await import("../duress/session/fence.js");
  const fence = duressSessionFence.readFence();
  return fence.activeIncidentIds.length > 0 || fence.retiredDevice;
}

const defaultDeps: TravelDeps = {
  storage: originTravelStorage,
  vaults: () =>
    listDeviceVaults().map((vault) => ({
      id: vault.id,
      kind: vault.kind,
      state: vault.state,
      label: vault.label,
      name: vault.named && vault.kind !== "guest" ? vault.label : null,
    })),
  duressActive,
  ownerPresent: () => {
    const snapshot = vaultStore.getSnapshot();
    return snapshot.status === "unlocked" && !snapshot.guest;
  },
  forgetVaults: forgetDepartedProjects,
  async welcomeVaults(ids) {
    await kvHydrate(
      ids.flatMap((id) => [...tombStorageKeys(id), ...projectScopedKeys(id)]),
    );
    await refreshProjectsView();
  },
  now: () => new Date(),
};

export const travelSeams = { deps: defaultDeps };

/** Seal the vaults not marked safe into a bundle. Removes nothing. */
export function packTravelDeparture(safe: readonly string[]) {
  return packDeparture(travelSeams.deps, {
    safe,
  }) satisfies Promise<PackOutcome>;
}

/** Take the packed vaults off this device once both halves are elsewhere. */
export function departForTravel(
  pkg: DeparturePackage,
  ack: { bundleSaved: boolean; codeRecorded: boolean },
): Promise<CompleteOutcome> {
  return completeDeparture(travelSeams.deps, pkg, ack);
}

/** Open a bundle with its return code and say what would come home. */
export function openTravelReturn(input: {
  bundleJson: string;
  returnCode: string;
}): Promise<OpenReturnOutcome> {
  return openReturn(travelSeams.deps, input);
}

/** Bring the vaults home. */
export function returnFromTravel(opened: OpenedReturn): Promise<ReturnReceipt> {
  return completeReturn(travelSeams.deps, opened);
}
