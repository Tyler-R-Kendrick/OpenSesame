import { useCallback, useEffect, useRef, useState } from "react";
import { IconPlus, IconRefresh } from "../../components/Icons.js";
import { kvDurability } from "../../lib/kv.js";
import { ensureDefaultAccess } from "../../lib/local-access-bootstrap.js";
import {
  type LocalDirectory,
  type LocalDirectoryChange,
  LocalDirectoryError,
  type LocalIdentity,
  type LocalIdentityKind,
  changeLocalDirectory,
  readLocalDirectory,
} from "../../lib/local-directory.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import { useVault } from "../../lib/vault/hooks.js";
import { DirectoryForm, DirectoryRows, LABELS } from "./LocalDirectoryViews.js";

export function LocalDirectoryPanel({ kind }: { kind: LocalIdentityKind }) {
  const { tomb } = useVault();
  return <DirectoryEditor key={`${tomb}:${kind}`} tomb={tomb} kind={kind} />;
}

function useDirectory(tomb: string) {
  const [directory, setDirectory] = useState<LocalDirectory | null>(null);
  const [draft, setDraft] = useState<LocalIdentity | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const readDirectory = useCallback(
    async (clearError = false) => {
      const current = ++generation.current;
      // Subscription invalidations must not wipe a save/validation alert the
      // operator is still looking at (control-character refusal, revision
      // conflict, etc.). Explicit Reload and the initial seed may clear.
      if (clearError) setError("");
      try {
        const next = await readLocalDirectory(tomb);
        if (current === generation.current) setDirectory(next);
      } catch (error) {
        if (current === generation.current)
          setError(
            error instanceof LocalDirectoryError
              ? error.message
              : "Could not read the local directory. Unlock this vault and reload; restore a backup if the problem persists.",
          );
      }
    },
    [tomb],
  );
  // Seed defaults once per tomb. Do not fold this into the IAM subscription:
  // ensureDefaultAccess writes devices/shares and notifies, which would
  // re-enter load forever and leave the panel stuck on "Loading directory…".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureDefaultAccess(tomb);
      } catch (error) {
        if (!cancelled)
          setError(
            error instanceof LocalDirectoryError
              ? error.message
              : "Could not read the local directory. Unlock this vault and reload; restore a backup if the problem persists.",
          );
        return;
      }
      if (!cancelled) await readDirectory(true);
    })();
    const off = subscribeLocalIamChanges(() => {
      if (!cancelled) void readDirectory(false);
    });
    return () => {
      cancelled = true;
      generation.current += 1;
      off();
    };
  }, [tomb, readDirectory]);
  const load = () => void readDirectory(true);

  async function change(command: LocalDirectoryChange) {
    if (!directory || busy) return;
    setBusy(true);
    setError("");
    try {
      setDirectory(
        await changeLocalDirectory(tomb, directory.revision, command),
      );
      setDraft(null);
      setRemoving(null);
    } catch (error) {
      setError(
        error instanceof LocalDirectoryError
          ? error.message
          : "Could not save this change. Check that the vault is unlocked and browser storage has space, then retry. Your draft has been kept.",
      );
    } finally {
      setBusy(false);
    }
  }

  return {
    directory,
    draft,
    setDraft,
    removing,
    setRemoving,
    busy,
    error,
    load,
    change,
  };
}

function DirectoryEditor({
  tomb,
  kind,
}: { tomb: string; kind: LocalIdentityKind }) {
  const model = useDirectory(tomb);
  const { directory, draft, setDraft, busy, error, load } = model;
  const label = LABELS[kind];

  return (
    <section
      className="panel"
      aria-label={`Local ${label.heading.toLowerCase()}`}
    >
      <div className="panel__head">
        <h2>{label.heading}</h2>
        <fieldset
          className="vtree__keys"
          aria-label={`${label.heading} commands`}
        >
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            disabled={busy || !directory || draft !== null}
            title={`New ${label.singular}`}
            aria-label={`New ${label.singular}`}
            onClick={() => setDraft({ id: "", kind, name: "", enabled: true })}
          >
            <IconPlus size={15} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            disabled={busy}
            title="Reload directory"
            aria-label="Reload directory"
            onClick={() => void load()}
          >
            <IconRefresh size={15} />
          </button>
        </fieldset>
      </div>
      <div className="panel__body">
        <p className="hint">
          Local to this encrypted vault. Manage credentials and registrations
          below. Creating a record does not grant resource access.
        </p>
        {kvDurability() === "memory" ? (
          <p className="note note--warn">
            Browser storage is unavailable. Changes last only until this tab
            closes.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="note note--err">
            {error}
          </p>
        ) : null}
        {!directory && !error ? <output>Loading directory…</output> : null}
        {directory?.entries.filter((entry) => entry.kind === kind).length ===
        0 ? (
          <p className="hint">
            No {label.heading.toLowerCase()} yet. Create the first{" "}
            {label.singular} in this vault.
          </p>
        ) : null}
        <DirectoryRows model={model} kind={kind} tomb={tomb} />
        <DirectoryForm model={model} kind={kind} />
      </div>
    </section>
  );
}
