import { getBundledProviders } from "../../lib/embedded-catalog.js";
import { isGuestSession } from "../../lib/guest-isolation.js";
import { readLocalDevices, thisDeviceId } from "../../lib/local-devices.js";
import {
  PAGES_APPLICATION_ID,
  PAGES_APPLICATION_NAME,
  SUPPORT_AGENT_ID,
} from "../../lib/local-directory-bootstrap.js";
import { readLocalDirectory } from "../../lib/local-directory.js";
/**
 * View-model logic for `LocalResourcesPanel` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import {
  type LocalShare,
  listLocalShares,
  policyLabel,
} from "../../lib/local-share-grants.js";
import { loadSettings } from "../../lib/settings.js";
import { listDeviceVaults } from "../../lib/vaults.js";

export type ResourceRow = {
  id: string;
  title: string;
  kind: string;
  detail: string;
  shares: LocalShare[];
};

export function shareSummary(
  shares: LocalShare[],
  names: Map<string, string>,
): string {
  if (shares.length === 0) return "no standing share";
  return shares
    .map(
      (share) =>
        `${names.get(share.principalId) ?? share.principalId} · ${policyLabel(share.resourceKind, share.policy)}`,
    )
    .join("; ");
}

export function pushVaultRows(
  next: ResourceRow[],
  shares: LocalShare[],
  guest: boolean,
): void {
  const vaults = guest
    ? listDeviceVaults().filter((vault) => vault.kind === "guest")
    : listDeviceVaults();
  for (const vault of vaults) {
    next.push({
      id: `vault:${vault.id}`,
      title: vault.label,
      kind: "vault",
      detail: vault.id,
      shares: shares.filter(
        (share) =>
          share.resourceKind === "vault" && share.resourceId === vault.id,
      ),
    });
  }
}

export function pushMemberRows(
  next: ResourceRow[],
  devices: Awaited<ReturnType<typeof readLocalDevices>>,
): void {
  next.push({
    id: `app:${PAGES_APPLICATION_ID}`,
    title: PAGES_APPLICATION_NAME,
    kind: "application",
    detail: PAGES_APPLICATION_ID,
    shares: [],
  });
  const mine = thisDeviceId();
  const device = devices.find((row) => row.id === mine);
  next.push({
    id: `device:${mine}`,
    title: device?.name ?? "This device",
    kind: "device",
    detail: device?.platform ?? mine,
    shares: [],
  });
}

export function pushConnectionRows(
  next: ResourceRow[],
  shares: LocalShare[],
  guest: boolean,
): void {
  const providers = getBundledProviders();
  const seen = new Set<string>();
  for (const binding of guest
    ? []
    : Object.values(loadSettings().capabilityConnectors)) {
    const providerId = binding.providerId.trim();
    if (!providerId || seen.has(providerId)) continue;
    seen.add(providerId);
    const label =
      providers.find((row) => row.id === providerId)?.displayName ?? providerId;
    next.push({
      id: `connection:${providerId}`,
      title: label,
      kind: "connection",
      detail: providerId,
      shares: shares.filter(
        (share) =>
          share.resourceKind === "connection" &&
          share.resourceId === providerId,
      ),
    });
  }
  if (guest) return;
  for (const share of shares) {
    if (share.resourceKind !== "connection") continue;
    if (seen.has(share.resourceId)) continue;
    seen.add(share.resourceId);
    next.push({
      id: `connection:${share.resourceId}`,
      title: share.resourceLabel || share.resourceId,
      kind: "connection",
      detail: share.resourceId,
      shares: shares.filter(
        (row) =>
          row.resourceKind === "connection" &&
          row.resourceId === share.resourceId,
      ),
    });
  }
}

export async function loadResourceRows(
  tomb: string,
): Promise<{ rows: ResourceRow[]; names: Map<string, string> }> {
  const [directory, devices, shares] = await Promise.all([
    readLocalDirectory(tomb),
    readLocalDevices(tomb),
    listLocalShares(tomb),
  ]);
  const names = new Map(
    directory.entries.map((entry) => [entry.id, entry.name]),
  );
  if (!names.has(SUPPORT_AGENT_ID)) names.set(SUPPORT_AGENT_ID, "open-sesame");
  const guest = isGuestSession();
  const rows: ResourceRow[] = [];
  pushVaultRows(rows, shares, guest);
  if (!guest) pushMemberRows(rows, devices);
  pushConnectionRows(rows, shares, guest);
  return { rows, names };
}
