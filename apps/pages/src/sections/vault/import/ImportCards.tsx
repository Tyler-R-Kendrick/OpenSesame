import type { SourceId } from "@opensesame/app-core/lib/vault/import/index.js";
import {
  type Fact,
  LISTED_ADAPTERS,
  doneFacts,
  formatLabel,
  plural,
} from "@opensesame/app-core/sections/vault/import/preview.js";
import { overlapCast } from "@opensesame/os-domain";
import { type ReactNode, useId, useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconLock } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";

/** A failure is a mark beside what failed, never a box (DESIGN.md). */
export function ErrorMark({ error }: { error: string | null }) {
  return error ? <StatusMark tone="err" label={error} /> : null;
}

/** "Read it as": the person names the format when detection guessed wrong. */
export function FormatField({
  value,
  status,
  onPick,
}: {
  value: SourceId | null;
  status?: ReactNode;
  onPick: (source: SourceId) => void;
}) {
  const id = useId();
  return (
    <div className="field imp__format">
      <label htmlFor={id}>Read it as</label>
      <select
        id={id}
        value={value ?? ""}
        onChange={(event) => onPick(overlapCast(event.target.value))}
      >
        {value === null ? (
          <option value="" disabled>
            Choose a format…
          </option>
        ) : null}
        {LISTED_ADAPTERS.map((adapter) => (
          <option key={adapter.id} value={adapter.id}>
            {adapter.label}
          </option>
        ))}
      </select>
      {status ? <span className="imp__marks">{status}</span> : null}
    </div>
  );
}

export function ReadingCard({ fileName }: { fileName: string }) {
  return (
    <div className="imp__reading" aria-busy="true">
      <CeremonyShell
        ok
        name={fileName}
        facts={[{ key: "Reading", value: "on this device" }]}
      />
    </div>
  );
}

export function UnreadableCard({
  fileName,
  error,
}: {
  fileName: string;
  error: string | null;
}) {
  return (
    <CeremonyShell ok={false} top="Not read" name={fileName}>
      <p className="imp__marks">
        <ErrorMark error={error} />
      </p>
    </CeremonyShell>
  );
}

export function FailedCard({
  fileName,
  error,
  busy,
  onPick,
}: {
  fileName: string;
  error: string | null;
  busy: boolean;
  onPick: (source: SourceId) => void;
}) {
  return (
    <CeremonyShell ok={false} top="Not recognised" name={fileName}>
      <fieldset className="imp__plain" disabled={busy}>
        <FormatField
          value={null}
          status={<ErrorMark error={error} />}
          onPick={onPick}
        />
      </fieldset>
    </CeremonyShell>
  );
}

/**
 * One password field and its commit. The password is handed to the one
 * operation that needs it and the field is emptied at once — it is never
 * kept in the sheet's state beyond this card.
 */
export function PasswordCard({
  formLabel,
  fileName,
  facts,
  commit,
  fieldLabel = "Master password",
  busy,
  error,
  onSubmit,
  children,
}: {
  formLabel: string;
  fileName: string;
  facts: Fact[];
  commit: string;
  fieldLabel?: string;
  busy: boolean;
  error: string | null;
  onSubmit: (password: string) => void;
  /** A choice the person makes beside the password, kept in the card. */
  children?: ReactNode;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      aria-label={formLabel}
      onSubmit={(event) => {
        event.preventDefault();
        if (password === "") return;
        onSubmit(password);
        setPassword("");
      }}
    >
      <CeremonyShell
        ok={error === null}
        name={fileName}
        facts={facts}
        primary={{
          label: commit,
          submit: true,
          busy,
          disabled: password === "",
          onClick: () => undefined,
        }}
      >
        <FieldShell
          label={fieldLabel}
          type="password"
          value={password}
          onValueChange={setPassword}
          autoComplete="off"
          lead={<IconLock size={16} />}
          disabled={busy}
          status={<ErrorMark error={error} />}
        />
        {children}
      </CeremonyShell>
    </form>
  );
}

export function LockedCard(props: {
  fileName: string;
  source: SourceId;
  note: string;
  busy: boolean;
  error: string | null;
  onUnlock: (password: string) => void;
}) {
  const facts: Fact[] = [{ key: "Format", value: formatLabel(props.source) }];
  if (props.note !== "") facts.push({ key: "Note", value: props.note });
  return (
    <PasswordCard
      formLabel="Open the encrypted database"
      fileName={props.fileName}
      facts={facts}
      commit="Open database"
      busy={props.busy}
      error={props.error}
      onSubmit={props.onUnlock}
    />
  );
}

function sealedFacts(opener: "password" | "passkey" | "pin" | null): Fact[] {
  const opens =
    opener === "passkey"
      ? "the passkey"
      : opener === "pin"
        ? "the PIN"
        : "the master password";
  return [
    { key: "Format", value: "OpenSesame encrypted backup" },
    { key: "Brings in", value: "items this vault does not hold" },
    { key: "Opens with", value: opens },
  ];
}

/**
 * Whether to take the backup's device identity: offered only for a vault that
 * has done nothing yet, and off until the person chooses it. A restore that
 * takes it can replace the principal this vault already speaks as.
 */
function IdentityChoice({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="check imp__identity">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>Also take its device identity</span>
    </label>
  );
}

export function SealedCard(props: {
  fileName: string;
  opener: "password" | "passkey" | "pin" | null;
  busy: boolean;
  error: string | null;
  /** The vault has done nothing yet, so the backup's identity can be taken. */
  canTakeIdentity: boolean;
  onRestore: (secret: string, adoptIdentity: boolean) => void;
  onPasskey: (adoptIdentity: boolean) => void;
}) {
  const facts = sealedFacts(props.opener);
  const [take, setTake] = useState(false);
  const choice = props.canTakeIdentity ? (
    <IdentityChoice checked={take} disabled={props.busy} onChange={setTake} />
  ) : null;
  if (props.opener === "passkey") {
    return (
      <CeremonyShell
        ok={props.error === null}
        name={props.fileName}
        facts={facts}
        primary={{
          label: "Restore with passkey",
          busy: props.busy,
          onClick: () => props.onPasskey(props.canTakeIdentity && take),
        }}
      >
        {choice}
        {props.error ? (
          <p className="imp__marks">
            <ErrorMark error={props.error} />
          </p>
        ) : null}
      </CeremonyShell>
    );
  }
  return (
    <PasswordCard
      formLabel="Restore the encrypted backup"
      fileName={props.fileName}
      facts={facts}
      commit="Restore items"
      fieldLabel={props.opener === "pin" ? "PIN" : "Master password"}
      busy={props.busy}
      error={props.error}
      onSubmit={(secret) =>
        props.onRestore(secret, props.canTakeIdentity && take)
      }
    >
      {choice}
    </PasswordCard>
  );
}

export function DoneCard({
  added,
  skipped,
  restored,
  updated,
  onClose,
}: {
  added: number;
  skipped: number;
  restored: boolean;
  updated?: number;
  onClose: () => void;
}) {
  return (
    <CeremonyShell
      ok
      top={restored ? "Restored" : "Imported"}
      name={plural(added, "item", "items")}
      facts={doneFacts({ added, skipped, restored, updated })}
      primary={{ label: "Done", onClick: onClose }}
    />
  );
}
