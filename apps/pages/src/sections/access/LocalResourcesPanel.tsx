/**
 * Access › Resources — the local resources this vault already dogfoods:
 * vaults, this app, this device, and any capability connector in use.
 */

import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { isGuestSession } from "@opensesame/app-core/lib/guest-isolation.js";
import {
  readLocalDevices,
  thisDeviceId,
} from "@opensesame/app-core/lib/local-devices.js";
import {
  PAGES_APPLICATION_ID,
  PAGES_APPLICATION_NAME,
  SUPPORT_AGENT_ID,
  readLocalDirectory,
} from "@opensesame/app-core/lib/local-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import {
  type LocalShare,
  listLocalShares,
  policyLabel,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import { listDeviceVaults } from "@opensesame/app-core/lib/vaults.js";
import { useEffect, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";

type ResourceRow = {
  id: string;
  title: string;
  kind: string;
  detail: string;
  shares: LocalShare[];
};

function shareSummary(
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

function pushVaultRows(
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

function pushMemberRows(
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

function pushConnectionRows(
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

async function loadResourceRows(
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

function ResourceList({
  rows,
  names,
}: {
  rows: ResourceRow[];
  names: Map<string, string>;
}) {
  if (rows.length === 0) {
    return <p className="hint">Unlock a vault to see local resources.</p>;
  }
  return (
    <ul className="access-resources">
      {rows.map((row) => (
        <li className="access-resource" key={row.id}>
          <div className="access-resource__main">
            <div className="access-resource__id">
              <h3>{row.title}</h3>
              <code className="access-ref">
                {row.kind} · {row.detail}
              </code>
            </div>
            <span className="access-resource__meta">
              {row.kind === "vault" || row.kind === "connection"
                ? shareSummary(row.shares, names)
                : "dogfooded"}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LocalResourcesPanel() {
  const { tomb } = useVault();
  const [rows, setRows] = useState<ResourceRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    const reload = () => {
      void loadResourceRows(tomb)
        .then((next) => {
          if (!alive) return;
          setNames(next.names);
          setRows(next.rows);
        })
        .catch(() => {
          if (alive) setRows([]);
        });
    };
    const off = subscribeLocalIamChanges(reload);
    reload();
    return () => {
      alive = false;
      off();
    };
  }, [tomb]);

  return (
    <section
      className="panel"
      id="local-resources"
      aria-label="Local resources"
    >
      <div className="panel__head">
        <h2>Local resources</h2>
      </div>
      <div className="panel__body">
        <ResourceList rows={rows} names={names} />
      </div>
    </section>
  );
}
