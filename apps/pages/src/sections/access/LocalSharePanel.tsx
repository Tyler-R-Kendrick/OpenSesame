import { useCallback, useEffect, useState } from "react";
import { IconPlus, IconRefresh } from "../../components/Icons.js";
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
  const [identities, setIdentities] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const names = new Map(identities.map((entry) => [entry.id, entry.name]));
  useEffect(() => {
    void readLocalDirectory(tomb)
      .then((directory) =>
        setIdentities(
          directory.entries.filter(
            (entry) =>
              (entry.kind === "person" || entry.kind === "agent") &&
              entry.enabled,
          ),
        ),
      )
      .catch(() => setIdentities([]));
  }, [tomb]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      setDraft(false);
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
          busy={busy}
          onGrant={() => setDraft(true)}
          onReload={() => {
            setError("");
            reload();
          }}
        />
      </div>
      <div className="panel__body">
        {error ? (
          <p className="note note--err" role="alert">
            {error}
          </p>
        ) : null}
        {draft ? (
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
              busy={busy}
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
  busy,
  onRevoke,
}: {
  share: LocalShare;
  name: string;
  busy: boolean;
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
        <span className="chip">
          until {new Date(share.expiresAt).toLocaleString()}
        </span>
        <div className="actions">
          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={busy}
            onClick={onRevoke}
          >
            Revoke
          </button>
        </div>
      </div>
    </li>
  );
}
