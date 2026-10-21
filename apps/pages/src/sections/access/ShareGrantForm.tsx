import { listShareTargets } from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import {
  SHARE_DURATIONS,
  SHARE_POLICIES,
  type ShareKind,
  type ShareScopeLists,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconX } from "../../components/Icons.js";
import { shareGrantCommitLabel } from "./share-grant-commit-label.js";

type SaveInput = {
  principalId: string;
  resourceKind: ShareKind;
  resourceId: string;
  resourceLabel: string;
  policy: string;
  durationSeconds: number;
};

type IdentityChoice = { id: string; name: string; kind?: string };

const KIND_LABEL = {
  vault: "Vault",
  connection: "Connector",
  folder: "Folder",
  item: "Item",
} satisfies Record<ShareKind, string>;

const EMPTY_SCOPE = {
  vault: "No vault on this device.",
  connection: "No connector to grant.",
  folder: "No folders in this vault.",
  item: "No items in this vault.",
} satisfies Record<ShareKind, string>;

export function ShareGrantForm({
  identities,
  scopes,
  initialKind,
  initialResourceId,
  busy,
  onCancel,
  onSave,
}: {
  identities: IdentityChoice[];
  scopes?: ShareScopeLists;
  initialKind?: ShareKind;
  initialResourceId?: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: SaveInput) => void;
}) {
  const [kind, setKind] = useState<ShareKind>(initialKind ?? "vault");
  const targets = listShareTargets(scopes);
  const resources = targets.filter((target) => target.kind === kind);
  const requestedItemUnavailable =
    initialKind === "item" &&
    initialResourceId !== undefined &&
    !targets.some(
      (target) => target.kind === "item" && target.id === initialResourceId,
    );
  const [principalId, setPrincipalId] = useState(identities[0]?.id ?? "");
  const [resourceId, setResourceId] = useState(() => {
    if (requestedItemUnavailable) return "";
    if (
      initialResourceId &&
      resources.some((resource) => resource.id === initialResourceId)
    )
      return initialResourceId;
    return resources[0]?.id ?? "";
  });
  const [policy, setPolicy] = useState<string>(
    SHARE_POLICIES[kind][0]?.id ?? "open",
  );
  const [duration, setDuration] = useState<number>(SHARE_DURATIONS[0].seconds);
  useEffect(() => {
    setPolicy(SHARE_POLICIES[kind][0]?.id ?? "open");
  }, [kind]);
  useEffect(() => {
    if (kind === "item" && requestedItemUnavailable) {
      setResourceId("");
      return;
    }
    const next = listShareTargets(scopes).filter(
      (target) => target.kind === kind,
    );
    setResourceId((current) => {
      if (next.some((entry) => entry.id === current)) return current;
      if (
        current === "" &&
        initialResourceId &&
        next.some((entry) => entry.id === initialResourceId)
      )
        return initialResourceId;
      return next[0]?.id ?? "";
    });
  }, [kind, scopes, initialResourceId, requestedItemUnavailable]);

  const selected = identities.find((entry) => entry.id === principalId);
  const identityMatches = selected !== undefined;
  const commitLabel = shareGrantCommitLabel(selected?.kind);

  function submit(event: FormEvent) {
    event.preventDefault();
    const resource = resources.find((entry) => entry.id === resourceId);
    if (!identityMatches || !resource) return;
    onSave({
      principalId,
      resourceKind: kind,
      resourceId: resource.id,
      resourceLabel: resource.label,
      policy,
      durationSeconds: duration,
    });
  }

  if (identities.length === 0) {
    return <p className="hint">No identities.</p>;
  }

  const itemUnavailable = kind === "item" && requestedItemUnavailable;

  return (
    <form onSubmit={submit}>
      <ShareFields
        identities={identities}
        busy={busy}
        kind={kind}
        resources={resources}
        principalId={principalId}
        resourceId={resourceId}
        itemUnavailable={itemUnavailable}
        fixedResource={
          initialKind !== undefined &&
          initialResourceId !== undefined &&
          !requestedItemUnavailable
        }
        policy={policy}
        duration={duration}
        onKind={setKind}
        onPrincipal={setPrincipalId}
        onResource={setResourceId}
        onPolicy={setPolicy}
        onDuration={setDuration}
      />
      <FormCommit
        label={commitLabel}
        disabled={
          busy ||
          itemUnavailable ||
          resources.length === 0 ||
          !resources.some((resource) => resource.id === resourceId) ||
          !identityMatches ||
          !principalId
        }
      >
        <button
          type="button"
          className="icon-btn"
          disabled={busy}
          aria-label="Cancel"
          title="Cancel"
          onClick={onCancel}
        >
          <IconX size={16} />
        </button>
      </FormCommit>
    </form>
  );
}

function identityLabel(
  entry: IdentityChoice,
  identities: readonly IdentityChoice[],
): string {
  const sameName = identities.filter((row) => row.name === entry.name);
  if (sameName.length === 1) return entry.name;
  const sameKind = sameName.filter((row) => row.kind === entry.kind);
  return `${entry.name} (${sameKind.length === 1 ? (entry.kind ?? "identity") : entry.id.slice(0, 8)})`;
}

function options(rows: readonly { id: string | number; label: string }[]) {
  return rows.map((row) => (
    <option key={String(row.id)} value={row.id}>
      {row.label}
    </option>
  ));
}

type ShareFieldProps = {
  identities: IdentityChoice[];
  busy: boolean;
  kind: ShareKind;
  resources: { id: string; label: string }[];
  principalId: string;
  resourceId: string;
  itemUnavailable: boolean;
  fixedResource: boolean;
  policy: string;
  duration: number;
  onKind: (kind: ShareKind) => void;
  onPrincipal: (id: string) => void;
  onResource: (id: string) => void;
  onPolicy: (id: string) => void;
  onDuration: (seconds: number) => void;
};

function ShareFields({
  identities,
  busy,
  kind,
  resources,
  principalId,
  resourceId,
  itemUnavailable,
  fixedResource,
  policy,
  duration,
  onKind,
  onPrincipal,
  onResource,
  onPolicy,
  onDuration,
}: ShareFieldProps) {
  const resourceLabel = KIND_LABEL[kind];
  return (
    <>
      <Field id="share-identity" label="Identity">
        <select
          id="share-identity"
          required
          disabled={busy}
          value={principalId}
          onChange={(event) => onPrincipal(event.target.value)}
        >
          <option value="" disabled>
            Choose an identity
          </option>
          {identities.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {identityLabel(entry, identities)}
            </option>
          ))}
        </select>
      </Field>
      {fixedResource ? null : (
        <>
          <Field id="share-kind" label="Resource">
            <select
              id="share-kind"
              disabled={busy}
              value={kind}
              // SAFETY: test/fixture or boundary-checked value matches ShareKind.
              onChange={(event) => onKind(event.target.value as ShareKind)}
            >
              <option value="vault">Vault</option>
              <option value="connection">Connector</option>
              <option value="folder">Folder</option>
              <option value="item">Item</option>
            </select>
          </Field>
          {itemUnavailable ? (
            <p className="hint" role="alert">
              That item is no longer available to share. Choose another item or
              resource.
            </p>
          ) : resources.length === 0 ? (
            <p className="hint">{EMPTY_SCOPE[kind]}</p>
          ) : (
            <Field id="share-resource" label={resourceLabel}>
              <select
                id="share-resource"
                required
                disabled={busy}
                value={resourceId}
                onChange={(event) => onResource(event.target.value)}
              >
                {options(resources)}
              </select>
            </Field>
          )}
        </>
      )}
      <Field id="share-policy" label="Policy">
        <select
          id="share-policy"
          disabled={busy}
          value={policy}
          onChange={(event) => onPolicy(event.target.value)}
        >
          {options(SHARE_POLICIES[kind])}
        </select>
      </Field>
      <Field id="share-duration" label="Duration">
        <select
          id="share-duration"
          disabled={busy}
          value={duration}
          onChange={(event) => onDuration(Number(event.target.value))}
        >
          {options(
            SHARE_DURATIONS.map((entry) => ({
              id: entry.seconds,
              label: entry.label,
            })),
          )}
        </select>
      </Field>
    </>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}
