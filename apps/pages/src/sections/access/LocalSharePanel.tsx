import { useCallback, useEffect, useState } from "react";
import { IconPlus, IconRefresh, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { readLocalDirectory } from "../../lib/local-directory.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import {
  type LocalShare,
  createLocalShare,
  listLocalShares,
  policyLabel,
  revokeLocalShare,
} from "../../lib/local-share-grants.js";
import { ShareGrantForm } from "./ShareGrantForm.js";

export function useLocalShares(tomb: string) {
  const [shares, setShares] = useState<LocalShare[]>([]);
  const reload = useCallback(() => {
    void listLocalShares(tomb)
      .then(setShares)
      .catch(() => setShares([]));
  }, [tomb]);
  useEffect(() => {
    const off = subscribeLocalIamChanges(reload);
    reload();
    return off;
  }, [reload]);
  return { shares, reload };
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
  return (
    <fieldset className="vtree__keys" aria-label="Share commands">
      <button
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
  const { shares, reload } = useLocalShares(tomb);
  const [identities, setIdentities] = useState<
    { id: string; name: string; role: string }[]
  >([]);
  const [canGrant, setCanGrant] = useState(false);
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const names = new Map(identities.map((entry) => [entry.id, entry.name]));
  useEffect(() => {
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
          import("../../lib/local-rbac.js"),
        ]);
        const actor = await resolveCurrentAccessRole(tomb);
        setCanGrant(canAccess(actor, "manage_grants"));
        setIdentities(
          directory.entries
            .filter(
              (entry) =>
                (entry.kind === "person" || entry.kind === "agent") &&
                entry.enabled,
            )
            .map((entry) => ({
              id: entry.id,
              name: entry.name,
              role: accessRoleLabel(
                resolveAccessRole(directory, entry.id) ?? "member",
              ),
            })),
        );
      } catch {
        setIdentities([]);
        setCanGrant(false);
      }
    })();
  }, [tomb]);

  async function run(action: () => Promise<LocalShare[] | undefined>) {
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
        {!canGrant ? (
          <p className="hint">
            An operator identity is assigned. Guests and members can view shares
            but cannot grant or revoke them.
          </p>
        ) : null}
        {error ? (
          <p className="note note--err" role="alert">
            {error}
          </p>
        ) : null}
        {draft && canGrant ? (
          <ShareGrantForm
            identities={identities}
            busy={busy}
            onCancel={() => setDraft(false)}
            onSave={(input) => void run(() => createLocalShare(tomb, input))}
          />
        ) : null}
        <ul className="identity-rows">
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
              onRevoke={() => void run(() => revokeLocalShare(tomb, share.id))}
            />
          ))}
        </ul>
      </div>
    </section>
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
          </code>
        </div>
        {role ? <span className="chip">{role}</span> : null}
        <StatusMark
          tone="idle"
          label={`Until ${new Date(share.expiresAt).toLocaleString()}`}
        />
        <div className="actions">
          <button
            type="button"
            className="icon-btn icon-btn--sm icon-btn--danger"
            disabled={busy || !canRevoke}
            aria-label="Revoke"
            title="Revoke"
            onClick={onRevoke}
          >
            <IconTrash size={16} />
          </button>
        </div>
      </div>
    </li>
  );
}
