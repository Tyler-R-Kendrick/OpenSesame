import {
  SHARE_DURATIONS,
  SHARE_POLICIES,
  type ShareKind,
  listShareTargets,
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

export function ShareGrantForm({
  identities,
  busy,
  onCancel,
  onSave,
  initialKind = "vault",
  initialResourceId,
}: {
  identities: { id: string; name: string }[];
  busy: boolean;
  /** Absent on a sheet, whose close key is the one way out (DESIGN.md). */
  onCancel?: () => void;
  onSave: (input: SaveInput) => void;
  /** The resource the sheet was opened for; the person may still change it. */
  initialKind?: ShareKind;
  initialResourceId?: string;
}) {
  const [kind, setKind] = useState<ShareKind>(initialKind);
  const resources = listShareTargets().filter((target) => target.kind === kind);
  const [principalId, setPrincipalId] = useState(identities[0]?.id ?? "");
  const [resourceId, setResourceId] = useState(
    initialResourceId ?? resources[0]?.id ?? "",
  );
  const [policy, setPolicy] = useState<string>(
    SHARE_POLICIES[kind][0]?.id ?? "open",
  );
  const [duration, setDuration] = useState<number>(SHARE_DURATIONS[0].seconds);
  useEffect(() => {
    const next = listShareTargets().filter((target) => target.kind === kind);
    setResourceId(next[0]?.id ?? "");
    setPolicy(SHARE_POLICIES[kind][0]?.id ?? "open");
  }, [kind]);

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
      <FormCommit label="Grant" disabled={busy}>
        {onCancel ? (
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
        ) : null}
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
}: {
  identities: { id: string; name: string }[];
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
}) {
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
          <option value="item">Item or folder</option>
        </select>
      </Field>
      <Field
        id="share-resource"
        label={
          kind === "vault" ? "Vault" : kind === "item" ? "Item" : "Connector"
        }
      >
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
