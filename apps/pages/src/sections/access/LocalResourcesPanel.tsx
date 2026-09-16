/**
 * Access › Resources — the local resources this vault already dogfoods:
 * vaults, this app, this device, and any capability connector in use.
 */

import { useEffect, useState } from "react";
import { getBundledProviders } from "../../lib/embedded-catalog.js";
import { readLocalDevices, thisDeviceId } from "../../lib/local-devices.js";
import {
  PAGES_APPLICATION_ID,
  PAGES_APPLICATION_NAME,
  SUPPORT_AGENT_ID,
  readLocalDirectory,
} from "../../lib/local-directory.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import {
  type LocalShare,
  listLocalShares,
  policyLabel,
} from "../../lib/local-share-grants.js";
import { loadSettings } from "../../lib/settings.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import { listDeviceVaults } from "../../lib/vaults.js";

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

export function LocalResourcesPanel() {
  const tomb = useVaultStore().activeTomb();
  const [rows, setRows] = useState<ResourceRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    const reload = () => {
      void (async () => {
        try {
          const [directory, devices, shares] = await Promise.all([
            readLocalDirectory(tomb),
            readLocalDevices(tomb),
            listLocalShares(tomb),
          ]);
          if (!alive) return;
          const nameMap = new Map(
            directory.entries.map((entry) => [entry.id, entry.name]),
          );
          if (!nameMap.has(SUPPORT_AGENT_ID)) {
            nameMap.set(SUPPORT_AGENT_ID, "open-sesame");
          }
          setNames(nameMap);

          const next: ResourceRow[] = [];
          for (const vault of listDeviceVaults()) {
            next.push({
              id: `vault:${vault.id}`,
              title: vault.label,
              kind: "vault",
              detail: vault.id,
              shares: shares.filter(
                (share) =>
                  share.resourceKind === "vault" &&
                  share.resourceId === vault.id,
              ),
            });
          }
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
          const providers = getBundledProviders();
          const seen = new Set<string>();
          for (const binding of Object.values(
            loadSettings().capabilityConnectors,
          )) {
            const providerId = binding.providerId.trim();
            if (!providerId || seen.has(providerId)) continue;
            seen.add(providerId);
            const label =
              providers.find((row) => row.id === providerId)?.displayName ??
              providerId;
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
          setRows(next);
        } catch {
          if (alive) setRows([]);
        }
      })();
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
        <p className="hint">
          Configured by default for Operators: this person, app, device, and
          standing vault shares. Guests are a separate Access role with the
          guest vault only — connectors and admin scopes stay closed until an
          Operator grants them here.
        </p>
        {rows.length === 0 ? (
          <p className="hint">Unlock a vault to see local resources.</p>
        ) : (
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
        )}
      </div>
    </section>
  );
}
