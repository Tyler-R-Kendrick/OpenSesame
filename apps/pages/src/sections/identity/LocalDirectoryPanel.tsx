import { useCallback, useEffect, useRef, useState } from "react";
import { IconPlus, IconRefresh } from "../../components/Icons.js";
import { kvDurability } from "../../lib/kv.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import {
  type LocalDirectory,
  type LocalDirectoryChange,
  LocalDirectoryError,
  type LocalIdentity,
  type LocalIdentityKind,
  changeLocalDirectory,
  currentOwnerPersonName,
  ensureOwnerPerson,
} from "../../lib/local-directory.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import { LocalAgentKeys } from "./LocalAgentKeys.js";
import { LocalApplicationSettings } from "./LocalApplicationSettings.js";
import { LocalMemberships } from "./LocalMemberships.js";
import { LocalPasskeys } from "./LocalPasskeys.js";

const LABELS = {
  person: { heading: "People", singular: "person" },
  agent: { heading: "Agents", singular: "agent" },
  application: { heading: "Applications", singular: "application" },
  organization: { heading: "Organizations", singular: "organization" },
} satisfies Record<LocalIdentityKind, { heading: string; singular: string }>;

export function LocalDirectoryPanel({ kind }: { kind: LocalIdentityKind }) {
  const tomb = useVaultStore().activeTomb();
  return <DirectoryEditor key={`${tomb}:${kind}`} tomb={tomb} kind={kind} />;
}

function useDirectory(tomb: string) {
  const [directory, setDirectory] = useState<LocalDirectory | null>(null);
  const [draft, setDraft] = useState<LocalIdentity | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setError("");
    try {
      const next = await ensureOwnerPerson(tomb, currentOwnerPersonName());
      if (current === generation.current) setDirectory(next);
    } catch (error) {
      if (current === generation.current)
        setError(
          error instanceof LocalDirectoryError
            ? error.message
            : "Could not read the local directory. Unlock this vault and reload; restore a backup if the problem persists.",
        );
    }
  }, [tomb]);
  useEffect(() => {
    void load();
    const off = subscribeLocalIamChanges(() => void load());
    return () => {
      generation.current += 1;
      off();
    };
  }, [load]);

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
        <fieldset className="vtree__keys" aria-label={`${label.heading} commands`}>
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

function DirectoryRows({
  model,
  kind,
  tomb,
}: {
  model: ReturnType<typeof useDirectory>;
  kind: LocalIdentityKind;
  tomb: string;
}) {
  const { directory, draft, setDraft, busy, removing, setRemoving, change } =
    model;
  const label = LABELS[kind];
  return (
    <ul className="identity-rows">
      {directory?.entries
        .filter((entry) => entry.kind === kind)
        .map((entry) => (
          <li key={entry.id} className="identity-row" id={entry.id}>
            <div className="identity-row__main">
              <div className="identity-row__id">
                <h3>{entry.name}</h3>
                <code className="identity-ref">{entry.id}</code>
              </div>
              <span className="chip">
                {entry.enabled ? "Enabled" : "Disabled"}
              </span>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy || draft !== null}
                  onClick={() => setDraft(entry)}
                  aria-label={`Edit ${entry.name}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy || draft !== null}
                  onClick={() =>
                    void change({
                      action: "update",
                      id: entry.id,
                      name: entry.name,
                      enabled: !entry.enabled,
                    })
                  }
                >
                  {entry.enabled ? "Disable" : "Enable"}
                </button>
                {removing === entry.id ? (
                  <>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={busy || draft !== null}
                      onClick={() =>
                        void change({ action: "delete", id: entry.id })
                      }
                    >
                      Confirm deletion
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy}
                      onClick={() => setRemoving(null)}
                    >
                      Keep {label.singular}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={busy || draft !== null}
                    onClick={() => setRemoving(entry.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
            <DirectoryAuthority
              tomb={tomb}
              entry={entry}
              directory={directory}
              disabled={busy || draft !== null}
              onChange={change}
            />
          </li>
        ))}
    </ul>
  );
}

function DirectoryAuthority({
  tomb,
  entry,
  directory,
  disabled,
  onChange,
}: {
  tomb: string;
  entry: LocalIdentity;
  directory: LocalDirectory;
  disabled: boolean;
  onChange: (change: LocalDirectoryChange) => Promise<void>;
}) {
  if (entry.kind === "agent")
    return (
      <LocalAgentKeys
        tomb={tomb}
        principalId={entry.id}
        disabled={disabled}
        enabled={entry.enabled}
      />
    );
  if (entry.kind === "person")
    return (
      <LocalPasskeys
        tomb={tomb}
        principalId={entry.id}
        disabled={disabled}
        enabled={entry.enabled}
      />
    );
  if (entry.kind === "organization")
    return (
      <LocalMemberships
        directory={directory}
        organizationId={entry.id}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (entry.kind === "application")
    return (
      <LocalApplicationSettings
        tomb={tomb}
        applicationId={entry.id}
        directory={directory}
        disabled={disabled || !entry.enabled}
      />
    );
  return null;
}

function DirectoryForm({
  model,
  kind,
}: { model: ReturnType<typeof useDirectory>; kind: LocalIdentityKind }) {
  const { draft, busy, error, setDraft, change } = model;
  const label = LABELS[kind];
  const input = useRef<HTMLInputElement>(null);
  const draftId = draft?.id;
  useEffect(() => {
    if (error && !busy && draftId !== undefined) input.current?.focus();
  }, [error, busy, draftId]);
  useEffect(() => {
    if (draftId === undefined) return;
    const previous = document.activeElement;
    const field = input.current;
    field?.focus();
    return () => {
      if (
        previous instanceof HTMLElement &&
        (document.activeElement === document.body ||
          field?.form?.contains(document.activeElement))
      )
        previous.focus();
    };
  }, [draftId]);
  return draft ? (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void change(
          draft.id
            ? {
                action: "update",
                id: draft.id,
                name: draft.name.trim(),
                enabled: draft.enabled,
              }
            : { action: "create", kind, name: draft.name.trim() },
        );
      }}
    >
      <div className="field">
        <label className="label" htmlFor="local-identity-name">
          Name
        </label>
        <input
          ref={input}
          id="local-identity-name"
          required
          maxLength={128}
          disabled={busy}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </div>
      <div className="actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !draft.name.trim()}
        >
          {busy
            ? "Saving…"
            : draft.id
              ? "Save changes"
              : `Create ${label.singular}`}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => setDraft(null)}
        >
          Cancel
        </button>
      </div>
    </form>
  ) : null;
}
