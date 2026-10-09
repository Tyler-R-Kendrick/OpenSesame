import type {
  LocalDirectory,
  LocalDirectoryChange,
  LocalIdentity,
  LocalIdentityKind,
} from "@opensesame/app-core/lib/local-directory.js";
import { useEffect, useRef } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
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
  /**
   * True until the panel's first seed has landed: the directory's own keys
   * wait for it, since a change on the snapshot drawn mid-seed is refused.
   * A record's credentials and settings keep their own stores and do not.
   */
  seeding: boolean;
  error: string;
  /** Apply a change; on success focus lands on the element with `focusId`. */
  change: (change: LocalDirectoryChange, focusId?: string) => Promise<void>;
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
  const { directory, draft, busy, change } = model;
  return (
    <ul className="identity-rows">
      {directory?.entries
        .filter((entry) => entry.kind === kind)
        .map((entry) => (
          <li key={entry.id} className="identity-row" id={entry.id}>
            <div className="identity-row__main">
              <div className="identity-row__id">
                {/* The state rides the name: in a column of its own it
                    pressed a phone card's id into three lines. */}
                <div className="identity-row__title">
                  <h3>{entry.name}</h3>
                  <StatusMark
                    tone={entry.enabled ? "ok" : "warn"}
                    label={entry.enabled ? "Enabled" : "Disabled"}
                  />
                </div>
                <code className="identity-ref">{entry.id}</code>
              </div>
              <DirectoryRowKeys model={model} entry={entry} kind={kind} />
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

/** The add key in a directory panel's head; focus lands there when a row leaves. */
export function newEntryKeyId(kind: LocalIdentityKind): string {
  return `local-directory-new-${kind}`;
}

/**
 * A record's keys: edit, enable/disable, and delete behind an armed key
 * whose keep hands focus back to it. A confirmed delete takes the row, and
 * the focused key with it, so focus lands on the panel's add key instead.
 */
export function DirectoryRowKeys({
  model,
  entry,
  kind,
}: {
  model: DirectoryModel;
  entry: LocalIdentity;
  kind: LocalIdentityKind;
}) {
  const { draft, setDraft, busy, seeding, removing, setRemoving, change } =
    model;
  const deleteKey = useRef<HTMLButtonElement>(null);
  const locked = busy || seeding || draft !== null;
  const armed = removing === entry.id;
  return (
    <div className="actions">
      <IconKey
        label={`Edit ${entry.name}`}
        small
        disabled={locked}
        onClick={() => setDraft(entry)}
      >
        <IconEdit size={16} />
      </IconKey>
      <IconKey
        label={entry.enabled ? "Disable" : "Enable"}
        small
        disabled={locked}
        onClick={() =>
          void change({
            action: "update",
            id: entry.id,
            name: entry.name,
            enabled: !entry.enabled,
          })
        }
      >
        {entry.enabled ? <IconX size={16} /> : <IconCheck size={16} />}
      </IconKey>
      <IconKey
        keyRef={deleteKey}
        label={armed ? "Confirm deletion" : "Delete"}
        small
        armed={armed}
        disabled={locked}
        onClick={() =>
          armed
            ? void change(
                { action: "delete", id: entry.id },
                newEntryKeyId(kind),
              )
            : setRemoving(entry.id)
        }
      >
        <IconTrash size={16} />
      </IconKey>
      {armed ? (
        <IconKey
          label={`Keep ${LABELS[kind].singular}`}
          small
          disabled={busy}
          onClick={() => {
            setRemoving(null);
            deleteKey.current?.focus();
          }}
        >
          <IconX size={16} />
        </IconKey>
      ) : null}
    </div>
  );
}

export function DirectoryAuthority({
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
        <IconKey label="Cancel" disabled={busy} onClick={() => setDraft(null)}>
          <IconX size={16} />
        </IconKey>
      </FormCommit>
    </form>
  ) : null;
}
