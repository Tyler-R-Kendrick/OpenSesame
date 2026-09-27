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
  busy,
  error,
  onSubmit,
}: {
  formLabel: string;
  fileName: string;
  facts: Fact[];
  commit: string;
  busy: boolean;
  error: string | null;
  onSubmit: (password: string) => void;
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
          label="Master password"
          type="password"
          value={password}
          onValueChange={setPassword}
          autoComplete="off"
          lead={<IconLock size={16} />}
          disabled={busy}
          status={<ErrorMark error={error} />}
        />
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

export function SealedCard(props: {
  fileName: string;
  busy: boolean;
  error: string | null;
  onRestore: (password: string) => void;
}) {
  return (
    <PasswordCard
      formLabel="Restore the encrypted backup"
      fileName={props.fileName}
      facts={[
        { key: "Format", value: "OpenSesame encrypted backup" },
        { key: "Brings in", value: "items this vault does not hold" },
      ]}
      commit="Restore items"
      busy={props.busy}
      error={props.error}
      onSubmit={props.onRestore}
    />
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
