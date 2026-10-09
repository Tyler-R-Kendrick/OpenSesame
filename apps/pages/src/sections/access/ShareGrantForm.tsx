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
  busy,
  onCancel,
  onSave,
}: {
  identities: IdentityChoice[];
  scopes?: ShareScopeLists;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: SaveInput) => void;
}) {
  const [kind, setKind] = useState<ShareKind>("vault");
  const resources = listShareTargets(scopes).filter(
    (target) => target.kind === kind,
  );
  const [principalId, setPrincipalId] = useState(identities[0]?.id ?? "");
  const [resourceId, setResourceId] = useState(resources[0]?.id ?? "");
  const [policy, setPolicy] = useState<string>(
    SHARE_POLICIES[kind][0]?.id ?? "open",
  );
  const [duration, setDuration] = useState<number>(SHARE_DURATIONS[0].seconds);
  useEffect(() => {
    setPolicy(SHARE_POLICIES[kind][0]?.id ?? "open");
  }, [kind]);
  useEffect(() => {
    const next = listShareTargets(scopes).filter(
      (target) => target.kind === kind,
    );
    setResourceId((current) =>
      next.some((entry) => entry.id === current)
        ? current
        : (next[0]?.id ?? ""),
    );
  }, [kind, scopes]);

  const selected = identities.find((entry) => entry.id === principalId);
  const commitLabel = selected?.kind === "agent" ? "Request approval" : "Grant";

  function submit(event: FormEvent) {
    event.preventDefault();
    const resource = resources.find((entry) => entry.id === resourceId);
    if (!principalId || !resource) return;
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

  return (
    <form onSubmit={submit}>
      <ShareFields
        identities={identities}
        busy={busy}
        kind={kind}
        resources={resources}
        principalId={principalId}
        resourceId={resourceId}
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
        disabled={busy || resources.length === 0 || !principalId}
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
          {options(
            identities.map((entry) => ({ id: entry.id, label: entry.name })),
          )}
        </select>
      </Field>
      <Field id="share-kind" label="Resource">
        <select
          id="share-kind"
          disabled={busy}
          value={kind}
          // SAFETY: test/fixture or boundary-checked value matches ShareKind)}.
          onChange={(event) => onKind(event.target.value as ShareKind)}
        >
          <option value="vault">Vault</option>
          <option value="connection">Connector</option>
          <option value="folder">Folder</option>
          <option value="item">Item</option>
        </select>
      </Field>
      {resources.length === 0 ? (
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
