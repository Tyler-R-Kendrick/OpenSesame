import { kvDurability } from "@opensesame/app-core/lib/kv.js";
import { ensureDefaultAccess } from "@opensesame/app-core/lib/local-access-bootstrap.js";
import { changeLocalDirectory } from "@opensesame/app-core/lib/local-directory-admin.js";
import {
  type LocalDirectory,
  type LocalDirectoryChange,
  LocalDirectoryError,
  type LocalIdentity,
  type LocalIdentityKind,
  readLocalDirectory,
} from "@opensesame/app-core/lib/local-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import { IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { byId, useFocusAfter } from "../../lib/use-focus-after.js";
import { useVault } from "../../lib/vault/hooks.js";
import {
  DirectoryForm,
  DirectoryRows,
  LABELS,
  newEntryKeyId,
} from "./LocalDirectoryViews.js";

export function LocalDirectoryPanel({ kind }: { kind: LocalIdentityKind }) {
  const { tomb } = useVault();
  return <DirectoryEditor key={`${tomb}:${kind}`} tomb={tomb} kind={kind} />;
}

const READ_ERROR =
  "Could not read the local directory. Unlock this vault and reload; restore a backup if the problem persists.";

/**
 * Seed defaults once per tomb, then follow changes. Returns whether the
 * first seed is still in flight. Do not fold the seed into the
 * subscription: ensureDefaultAccess writes and notifies, which would
 * re-enter it forever and leave the panel stuck on "Loading directory…".
 *
 * Until the seed's own read lands, the rows on screen come from a snapshot
 * its writes are about to replace, and a change made on it would be refused
 * as "changed in another tab" — so the directory's keys wait for it.
 */
function useDirectorySeed(
  tomb: string,
  readDirectory: (clearError: boolean) => Promise<void>,
  setError: (error: string) => void,
  generation: { current: number },
): boolean {
  const [seeding, setSeeding] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureDefaultAccess(tomb);
      } catch (error) {
        if (!cancelled) {
          setError(
            error instanceof LocalDirectoryError ? error.message : READ_ERROR,
          );
          setSeeding(false);
        }
        return;
      }
      if (cancelled) return;
      // Not a clearing read: the panel mounts per tomb with no error, and a
      // clearing read could wipe one raised after the rows appeared.
      await readDirectory(false);
      if (!cancelled) setSeeding(false);
    })();
    const off = subscribeLocalIamChanges(() => {
      if (!cancelled) void readDirectory(false);
    });
    return () => {
      cancelled = true;
      generation.current += 1;
      off();
    };
  }, [tomb, readDirectory, setError, generation]);
  return seeding;
}

export function useDirectory(
  tomb: string,
  onSaved?: (next: LocalDirectory, command: LocalDirectoryChange) => void,
) {
  const [directory, setDirectory] = useState<LocalDirectory | null>(null);
  const [draft, setDraft] = useState<LocalIdentity | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const focusAfter = useFocusAfter(busy);
  const readDirectory = useCallback(
    async (clearError = false) => {
      const current = ++generation.current;
      // Subscription invalidations must not wipe a save/validation alert the
      // operator is still looking at (control-character refusal, revision
      // conflict, etc.). Only the explicit Reload clears.
      if (clearError) setError("");
      try {
        const next = await readLocalDirectory(tomb);
        if (current === generation.current) setDirectory(next);
      } catch (error) {
        if (current === generation.current)
          setError(
            error instanceof LocalDirectoryError ? error.message : READ_ERROR,
          );
      }
    },
    [tomb],
  );
  const seeding = useDirectorySeed(tomb, readDirectory, setError, generation);
  const load = () => void readDirectory(true);

  async function change(command: LocalDirectoryChange, focusId?: string) {
    if (!directory || busy || seeding) return;
    setBusy(true);
    setError("");
    try {
      const next = await changeLocalDirectory(
        tomb,
        directory.revision,
        command,
      );
      setDirectory(next);
      setDraft(null);
      setRemoving(null);
      onSaved?.(next, command);
      if (focusId) focusAfter(byId(focusId));
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
    seeding,
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
  const { directory, draft, setDraft, busy, seeding, error, load } = model;
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
          <IconKey
            id={newEntryKeyId(kind)}
            label={`New ${label.singular}`}
            small
            disabled={busy || seeding || !directory || draft !== null}
            onClick={() => setDraft({ id: "", kind, name: "", enabled: true })}
          >
            <IconPlus size={15} />
          </IconKey>
          <ReloadKey
            label="Reload directory"
            disabled={busy}
            onReload={() => void load()}
          />
        </fieldset>
      </div>
      <div className="panel__body">
        <div className="actions">
          {kvDurability() === "memory" ? (
            <StatusMark
              tone="warn"
              label="Browser storage is unavailable. Changes last only until this tab closes."
            />
          ) : null}
          {error ? (
            <>
              <StatusMark tone="err" label={error} />
              <span role="alert" className="visually-hidden">
                {error}
              </span>
            </>
          ) : null}
          {!directory && !error ? (
            <StatusMark tone="idle" label="Loading directory…" />
          ) : null}
          {directory?.entries.filter((entry) => entry.kind === kind).length ===
          0 ? (
            <StatusMark
              tone="idle"
              label={`No ${label.heading.toLowerCase()} yet.`}
            />
          ) : null}
        </div>
        <DirectoryRows model={model} kind={kind} tomb={tomb} />
        <DirectoryForm model={model} kind={kind} />
      </div>
    </section>
  );
}
