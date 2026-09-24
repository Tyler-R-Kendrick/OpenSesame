import type {
  LocalDirectory,
  LocalDirectoryChange,
  LocalIdentity,
  LocalIdentityKind,
} from "@opensesame/app-core/lib/local-directory.js";
import { useEffect, useRef } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import {
  IconCheck,
  IconEdit,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { LocalAgentKeys } from "./LocalAgentKeys.js";
import { LocalApplicationSettings } from "./LocalApplicationSettings.js";
import { LocalMemberships } from "./LocalMemberships.js";
import { LocalPasskeys } from "./LocalPasskeys.js";

export const LABELS = {
  person: { heading: "People", singular: "person" },
  agent: { heading: "Agents", singular: "agent" },
  application: { heading: "Applications", singular: "application" },
  organization: { heading: "Organizations", singular: "organization" },
} satisfies Record<LocalIdentityKind, { heading: string; singular: string }>;

export type DirectoryModel = {
  directory: LocalDirectory | null;
  draft: LocalIdentity | null;
  setDraft: (draft: LocalIdentity | null) => void;
  removing: string | null;
  setRemoving: (id: string | null) => void;
  busy: boolean;
  error: string;
  change: (change: LocalDirectoryChange) => Promise<void>;
};

export function DirectoryRows({
  model,
  kind,
  tomb,
}: {
  model: DirectoryModel;
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
              <StatusMark
                tone={entry.enabled ? "ok" : "warn"}
                label={entry.enabled ? "Enabled" : "Disabled"}
              />
              <div className="actions">
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  disabled={busy || draft !== null}
                  onClick={() => setDraft(entry)}
                  aria-label={`Edit ${entry.name}`}
                  title={`Edit ${entry.name}`}
                >
                  <IconEdit size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  disabled={busy || draft !== null}
                  aria-label={entry.enabled ? "Disable" : "Enable"}
                  title={entry.enabled ? "Disable" : "Enable"}
                  onClick={() =>
                    void change({
                      action: "update",
                      id: entry.id,
                      name: entry.name,
                      enabled: !entry.enabled,
                    })
                  }
                >
                  {entry.enabled ? (
                    <IconX size={16} />
                  ) : (
                    <IconCheck size={16} />
                  )}
                </button>
                {removing === entry.id ? (
                  <>
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm icon-btn--danger is-armed"
                      disabled={busy || draft !== null}
                      aria-label="Confirm deletion"
                      title="Confirm deletion"
                      onClick={() =>
                        void change({ action: "delete", id: entry.id })
                      }
                    >
                      <IconTrash size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm"
                      disabled={busy}
                      aria-label={`Keep ${label.singular}`}
                      title={`Keep ${label.singular}`}
                      onClick={() => setRemoving(null)}
                    >
                      <IconX size={16} />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm icon-btn--danger"
                    disabled={busy || draft !== null}
                    aria-label="Delete"
                    title="Delete"
                    onClick={() => setRemoving(entry.id)}
                  >
                    <IconTrash size={16} />
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
      <>
        <LocalAgentKeys
          tomb={tomb}
          principalId={entry.id}
          disabled={disabled}
          enabled={entry.enabled}
        />
      </>
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

export function DirectoryForm({
  model,
  kind,
}: { model: DirectoryModel; kind: LocalIdentityKind }) {
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
      <FormCommit label="Save changes" disabled={busy || !draft.name.trim()}>
        <button
          type="button"
          className="icon-btn"
          disabled={busy}
          onClick={() => setDraft(null)}
          aria-label="Cancel"
          title="Cancel"
        >
          <IconX size={16} />
        </button>
      </FormCommit>
    </form>
  ) : null;
}
