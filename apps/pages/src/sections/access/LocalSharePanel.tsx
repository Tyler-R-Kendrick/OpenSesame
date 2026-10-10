import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import {
  type PendingShare,
  approvePendingShare,
  denyPendingShare,
  listPendingShares,
  submitLocalShare,
} from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import {
  type LocalShare,
  type ShareScopeLists,
  grantIdentities,
  listLocalShares,
  revokeLocalShare,
} from "@opensesame/app-core/lib/local-share-grants.js";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconPlus, IconRefresh } from "../../components/Icons.js";
import { useVault } from "../../lib/vault/hooks.js";
import { GuideTarget, useGuideTarget } from "../../tutorial/registry/react.jsx";
import {
  AccessDetail,
  AccessRecords,
  useAccessRecord,
} from "./AccessRecords.js";
import { PendingRow, ShareRow } from "./ShareDetail.js";
import { ShareGrantForm } from "./ShareGrantForm.js";

async function readApprovals(tomb: string): Promise<PendingShare[]> {
  try {
    return await listPendingShares(tomb);
  } catch {
    // A damaged approval file must not hide the grants that are already active.
    return [];
  }
}

export function useLocalShares(tomb: string) {
  const [shares, setShares] = useState<LocalShare[]>([]);
  const [pending, setPending] = useState<PendingShare[]>([]);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const request = ++generation.current;
    void Promise.all([listLocalShares(tomb), readApprovals(tomb)])
      .then(([nextShares, nextPending]) => {
        if (request !== generation.current) return;
        setShares(nextShares);
        setPending(nextPending);
      })
      .catch(() => {
        if (request !== generation.current) return;
        setShares([]);
        setPending([]);
      });
  }, [tomb]);
  useEffect(() => {
    const off = subscribeLocalIamChanges(reload);
    reload();
    return off;
  }, [reload]);
  return { shares, pending, reload };
}

function itemScopeLabel(item: VaultItem, folders: readonly Folder[]): string {
  const folder = item.folderId
    ? folders.find((entry) => entry.id === item.folderId)
    : undefined;
  const label = folder ? `${folder.name} / ${item.name}` : item.name;
  return label.slice(0, 128);
}

function shareScopes(
  status: string,
  items: readonly VaultItem[],
  folders: readonly Folder[],
): ShareScopeLists {
  if (status !== "unlocked") return { folders: [], items: [] };
  return {
    folders: folders
      .filter((folder) => folder.name.trim())
      .map((folder) => ({
        id: folder.id,
        label: folder.name.slice(0, 128),
      })),
    items: items
      .filter((item) => item.deletedAt === null && item.name.trim())
      .map((item) => ({ id: item.id, label: itemScopeLabel(item, folders) })),
  };
}

function ShareCommands({
  busy,
  onGrant,
  onReload,
}: {
  busy: boolean;
  onGrant: () => void;
  onReload: () => void;
}) {
  // The Grants tab's one +: the tutorial's "grant access" points here.
  const grantRef = useGuideTarget<HTMLButtonElement>("access.grant-access");
  return (
    <fieldset className="vtree__keys" aria-label="Share commands">
      <button
        ref={grantRef}
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Grant identity share"
        title="Grant identity share"
        disabled={busy}
        onClick={onGrant}
      >
        <IconPlus size={15} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Reload shares"
        title="Reload shares"
        disabled={busy}
        onClick={onReload}
      >
        <IconRefresh size={15} />
      </button>
    </fieldset>
  );
}

export function LocalSharePanel({ tomb }: { tomb: string }) {
  const { shares, pending, reload } = useLocalShares(tomb);
  const vault = useVault();
  const scopes = useMemo(
    () => shareScopes(vault.status, vault.items, vault.folders),
    [vault],
  );
  const [identities, setIdentities] = useState<
    { id: string; name: string; kind: string; role: string }[]
  >([]);
  const [canGrant, setCanGrant] = useState(false);
  const selection = useAccessRecord("identity-shares", "grants", "share-");
  const draft = selection.creating;
  const setDraft = selection.setCreating;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const names = new Map(identities.map((entry) => [entry.id, entry.name]));
  useEffect(() => {
    let live = true;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      void (async () => {
        try {
          const [
            directory,
            {
              accessRoleLabel,
              canAccess,
              resolveAccessRole,
              resolveCurrentAccessRole,
            },
          ] = await Promise.all([
            readLocalDirectory(tomb),
            import("@opensesame/app-core/lib/local-rbac.js"),
          ]);
          if (!live || request !== generation) return;
          const actor = await resolveCurrentAccessRole(tomb);
          if (!live || request !== generation) return;
          setCanGrant(canAccess(actor, "manage_grants"));
          setIdentities(
            grantIdentities(directory.entries).map((entry) => ({
              id: entry.id,
              name: entry.name,
              kind: entry.kind,
              role:
                entry.kind === "application"
                  ? "Application"
                  : entry.kind === "agent"
                    ? "Agent"
                    : accessRoleLabel(
                        resolveAccessRole(directory, entry.id) ?? "member",
                      ),
            })),
          );
        } catch {
          if (!live || request !== generation) return;
          setIdentities([]);
          setCanGrant(false);
        }
      })();
    };
    const off = subscribeLocalIamChanges(load);
    load();
    return () => {
      live = false;
      off();
    };
  }, [tomb]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();

      reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not update shares.",
      );
    } finally {
      setBusy(false);
    }
  }

  const selectedShare = shares.find((share) => share.id === selection.id);
  const selectedPending = pending.find(
    (row) => row.id === selection.id || `pending-${row.id}` === selection.id,
  );
  const name = (principal: string) => names.get(principal) ?? principal;
  return (
    <AccessRecords
      title="Identity shares"
      createGuide="access.grant-access"
      selection={selection}
      rows={[
        ...pending.map((row) => ({
          id: row.id,
          label: `${name(row.principalId)} → ${row.resourceLabel}`,
          extension: "pending",
          to: selection.path(row.id),
        })),
        ...shares.map((row) => ({
          id: row.id,
          label: `${name(row.principalId)} → ${row.resourceLabel}`,
          extension: "share",
          to: selection.path(row.id),
        })),
      ]}
      commands={
        <ShareCommands
          busy={busy || !canGrant}
          onGrant={() => setDraft(true)}
          onReload={() => {
            setError("");
            reload();
          }}
        />
      }
      status={
        <FailureNotice id="access:shares" title="Shares" message={error} />
      }
    >
      {draft && canGrant ? (
        <AccessDetail title="New identity share" kind="Share">
          <GuideTarget id="access.grant-ceremony">
            <ShareGrantForm
              identities={identities}
              scopes={scopes}
              busy={busy}
              onCancel={() => setDraft(false)}
              onSave={(input) =>
                void run(async () => {
                  const result = await submitLocalShare(tomb, input);
                  const record =
                    result.outcome === "pending"
                      ? result.pending.id
                      : result.shares[0]?.id;
                  if (record) selection.select(record);
                  else selection.close();
                })
              }
            />
          </GuideTarget>
        </AccessDetail>
      ) : null}
      {!draft && selectedShare ? (
        <ShareRow
          share={selectedShare}
          name={name(selectedShare.principalId)}
          principalRole={
            identities.find((row) => row.id === selectedShare.principalId)?.role
          }
          busy={busy}
          canRevoke={canGrant}
          onRevoke={() =>
            void run(async () => {
              await revokeLocalShare(tomb, selectedShare.id);
              selection.close();
            })
          }
        />
      ) : null}
      {!draft && selectedPending ? (
        <PendingRow
          pending={selectedPending}
          name={name(selectedPending.principalId)}
          role={
            identities.find((row) => row.id === selectedPending.principalId)
              ?.role
          }
          busy={busy}
          canDecide={canGrant}
          onApprove={() =>
            void run(async () => {
              await approvePendingShare(tomb, selectedPending.id);
            })
          }
          onDeny={() =>
            void run(async () => {
              await denyPendingShare(tomb, selectedPending.id);
              selection.close();
            })
          }
        />
      ) : null}
    </AccessRecords>
  );
}
