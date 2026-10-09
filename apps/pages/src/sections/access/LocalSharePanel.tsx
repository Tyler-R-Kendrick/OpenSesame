import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import {
  type PendingShare,
  approvePendingShare,
  denyPendingShare,
  listPendingShares,
  policyLabel,
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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconCheck,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { GuideTarget, useGuideTarget } from "../../tutorial/registry/react.jsx";
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
  const [draft, setDraft] = useState(false);
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
      setDraft(false);
      reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not update shares.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="panel"
      id="identity-shares"
      aria-label="Identity shares"
    >
      <div className="panel__head">
        <h2>Identity shares</h2>
        <ShareCommands
          busy={busy || !canGrant}
          onGrant={() => setDraft(true)}
          onReload={() => {
            setError("");
            reload();
          }}
        />
      </div>
      <div className="panel__body">
        {!canGrant ? <p className="hint">View only.</p> : null}
        <FailureNotice id="access:shares" title="Shares" message={error} />
        {draft && canGrant ? (
          <GuideTarget id="access.grant-ceremony">
            <ShareGrantForm
              identities={identities}
              scopes={scopes}
              busy={busy}
              onCancel={() => setDraft(false)}
              onSave={(input) =>
                void run(async () => {
                  await submitLocalShare(tomb, input);
                })
              }
            />
          </GuideTarget>
        ) : null}
        <ul className="identity-rows">
          {pending.map((row) => (
            <PendingRow
              key={row.id}
              pending={row}
              name={names.get(row.principalId) ?? row.principalId}
              role={
                identities.find((entry) => entry.id === row.principalId)?.role
              }
              busy={busy}
              canDecide={canGrant}
              onApprove={() =>
                void run(async () => {
                  await approvePendingShare(tomb, row.id);
                })
              }
              onDeny={() =>
                void run(async () => {
                  await denyPendingShare(tomb, row.id);
                })
              }
            />
          ))}
          {shares.map((share) => (
            <ShareRow
              key={share.id}
              share={share}
              name={names.get(share.principalId) ?? share.principalId}
              role={
                identities.find((row) => row.id === share.principalId)?.role
              }
              busy={busy}
              canRevoke={canGrant}
              onRevoke={() =>
                void run(async () => {
                  await revokeLocalShare(tomb, share.id);
                })
              }
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function PendingRow({
  pending,
  name,
  role,
  busy,
  canDecide,
  onApprove,
  onDeny,
}: {
  pending: PendingShare;
  name: string;
  role: string | undefined;
  busy: boolean;
  canDecide: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <li className="identity-row" id={`pending-${pending.id}`}>
      <div className="identity-row__main">
        <div className="identity-row__id">
          <h3>
            {name} → {pending.resourceLabel}
          </h3>
          <code className="identity-ref">
            {pending.resourceKind} ·{" "}
            {policyLabel(pending.resourceKind, pending.policy)}
            {role ? ` · ${role}` : ""}
          </code>
        </div>
        <StatusMark tone="warn" label="Awaiting approval" />
        <div className="actions">
          <IconKey
            label={`Approve ${name}`}
            small
            disabled={busy || !canDecide}
            onClick={onApprove}
          >
            <IconCheck size={16} />
          </IconKey>
          <IconKey
            label={`Deny ${name}`}
            small
            disabled={busy || !canDecide}
            onClick={onDeny}
          >
            <IconX size={16} />
          </IconKey>
        </div>
      </div>
    </li>
  );
}
function ShareRow({
  share,
  name,
  role,
  busy,
  canRevoke,
  onRevoke,
}: {
  share: LocalShare;
  name: string;
  role: string | undefined;
  busy: boolean;
  canRevoke: boolean;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!busy) setConfirming(false);
  }, [busy, share.id]);
  const revokeLabel = confirming ? "Confirm revoke" : "Revoke";
  return (
    <li className="identity-row" id={`share-${share.id}`}>
      <div className="identity-row__main">
        <div className="identity-row__id">
          <h3>
            {name} → {share.resourceLabel}
          </h3>
          <code className="identity-ref">
            {share.resourceKind} ·{" "}
            {policyLabel(share.resourceKind, share.policy)}
            {role ? ` · ${role}` : ""}
          </code>
        </div>
        <StatusMark
          tone="idle"
          label={`Until ${new Date(share.expiresAt).toLocaleString()}`}
        />
        <div className="actions">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            disabled={busy || !canRevoke}
            aria-label={revokeLabel}
            title={revokeLabel}
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              onRevoke();
            }}
          >
            <IconTrash size={16} />
          </button>
        </div>
      </div>
    </li>
  );
}
