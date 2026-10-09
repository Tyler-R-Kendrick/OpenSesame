/**
 * Share grant types and catalog constants for the local PAM ledger.
 */

import { getBundledProviders } from "./embedded-catalog.js";
import { vaultStore } from "./vault/store.js";
import { listDeviceVaults } from "./vaults.js";

export const SHARE_KINDS = ["vault", "connection", "item"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export const SHARE_POLICIES = {
  vault: [
    { id: "open", label: "Open" },
    { id: "items", label: "Use items" },
  ],
  connection: [
    { id: "use", label: "Use" },
    { id: "invoke", label: "Invoke" },
  ],
  item: [
    { id: "read", label: "Read" },
    { id: "use", label: "Use" },
  ],
} as const satisfies Record<
  ShareKind,
  readonly { readonly id: string; readonly label: string }[]
>;

export const SHARE_DURATIONS = [
  { seconds: 3600, label: "1 hour" },
  { seconds: 8 * 3600, label: "8 hours" },
  { seconds: 86400, label: "1 day" },
  { seconds: 7 * 86400, label: "1 week" },
] as const;

export type LocalShare = {
  id: string;
  principalId: string;
  resourceKind: ShareKind;
  resourceId: string;
  resourceLabel: string;
  policy: string;
  issuedAt: number;
  expiresAt: number;
  /** Set when this share was issued by a vault session run. */
  sessionId?: string;
};

export type ShareTarget = {
  kind: ShareKind;
  id: string;
  label: string;
};

/**
 * A folder's synthetic share-target id (`item` kind): folder PAM is recorded
 * as a grant on the folder's own scope, labelled with its path.
 */
export const FOLDER_TARGET_PREFIX = "folder:";

export function listShareTargets(): ShareTarget[] {
  const vaults = listDeviceVaults().map((vault) => ({
    kind: "vault" as const,
    id: vault.id,
    label: vault.label,
  }));
  const connectors = getBundledProviders().map((provider) => ({
    kind: "connection" as const,
    id: provider.id,
    label: provider.displayName,
  }));
  const snapshot = vaultStore.getSnapshot();
  const open =
    snapshot.status === "unlocked"
      ? ([
          ...snapshot.folders.map((folder) => ({
            kind: "item" as const,
            id: `${FOLDER_TARGET_PREFIX}${folder.id}`,
            label: `Folder · ${folder.name}`,
          })),
          ...snapshot.items
            .filter((item) => item.deletedAt === null)
            .map((item) => ({
              kind: "item" as const,
              id: item.id,
              label: item.name || item.id,
            })),
        ] satisfies ShareTarget[])
      : [];
  return [...vaults, ...connectors, ...open];
}

export function policyLabel(kind: ShareKind, policy: string): string {
  return (
    SHARE_POLICIES[kind].find((entry) => entry.id === policy)?.label ?? policy
  );
}
