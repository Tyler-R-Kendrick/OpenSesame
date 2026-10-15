import type {
  SecretBackendCapabilities,
  SecretBackendItemInput,
  SecretBackendItemSummary,
} from "@opensesame/app-core/lib/secret-backends/types.js";
import { useId, useState } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconCopy, IconEye, IconEyeOff } from "../../../components/Icons.js";

type Props = {
  draft: SecretBackendItemInput;
  editing: boolean;
  busy: boolean;
  onChange: (next: SecretBackendItemInput) => void;
};
function SecretField({ draft, editing, busy, onChange }: Props) {
  const [revealed, setRevealed] = useState(false);
  return (
    <FieldShell
      label={draft.kind === "login" ? "Password" : "Secret value"}
      value={draft.secret}
      type={revealed ? "text" : "password"}
      autoComplete="new-password"
      mono
      readOnly={!editing}
      disabled={busy}
      onValueChange={(secret) => onChange({ ...draft, secret })}
      tail={
        <>
          <IconKey
            label={revealed ? "Hide backend secret" : "Reveal backend secret"}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? <IconEyeOff size={17} /> : <IconEye size={17} />}
          </IconKey>
          <IconKey
            label="Copy backend secret"
            onClick={() =>
              void navigator.clipboard?.writeText(draft.secret).catch(() => {})
            }
          >
            <IconCopy size={17} />
          </IconKey>
        </>
      }
    />
  );
}

export function SecretBackendItemFields(
  props: Props & {
    existing: boolean;
    kinds?: readonly SecretBackendItemSummary["kind"][];
    fields?: SecretBackendCapabilities["itemFields"];
  },
) {
  const { draft, editing, busy, onChange, existing } = props;
  const id = useId();
  const permits = (field: "username" | "url" | "notes" | "secret") =>
    !props.fields || props.fields.includes(field);
  return (
    <>
      <FieldShell
        label="Item name"
        value={draft.name}
        readOnly={!editing}
        disabled={busy}
        onValueChange={(name) => onChange({ ...draft, name })}
      />
      <div className="field">
        <label htmlFor={`${id}-kind`}>Item type</label>
        <select
          id={`${id}-kind`}
          value={draft.kind ?? "note"}
          disabled={!editing || busy || existing}
          onChange={(event) => {
            const kind = event.target.value;
            if (kind === "login" || kind === "secret" || kind === "note")
              onChange({ ...draft, kind });
          }}
        >
          {(props.kinds ?? ["note", "secret", "login"]).map((kind) => (
            <option key={kind} value={kind}>
              {kind === "note"
                ? "Note"
                : kind === "secret"
                  ? "Secret"
                  : "Login"}
            </option>
          ))}
        </select>
      </div>
      {draft.kind === "login" ? (
        <>
          {permits("url") ? (
            <FieldShell
              label="Website"
              value={draft.url ?? ""}
              readOnly={!editing}
              disabled={busy}
              onValueChange={(url) => onChange({ ...draft, url })}
              mono
            />
          ) : null}
          {permits("username") ? (
            <FieldShell
              label="Username"
              value={draft.username ?? ""}
              readOnly={!editing}
              disabled={busy}
              onValueChange={(username) => onChange({ ...draft, username })}
            />
          ) : null}
        </>
      ) : null}
      {draft.kind !== "note" && permits("secret") ? (
        <SecretField {...props} />
      ) : null}
      {permits("notes") ? (
        <div className="field">
          <label htmlFor={`${id}-notes`}>Notes</label>
          <textarea
            id={`${id}-notes`}
            value={draft.notes}
            readOnly={!editing}
            disabled={busy}
            onChange={(event) =>
              onChange({ ...draft, notes: event.target.value })
            }
            rows={5}
          />
        </div>
      ) : null}
    </>
  );
}
