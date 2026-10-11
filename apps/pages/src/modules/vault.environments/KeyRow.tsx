/**
 * One key in the active environment: the variable the item derives, whether it
 * is required here, and the value sealed for here. The value is concealed
 * until its reveal key is pressed, and is only ever copied by its own key,
 * through the vault's clipboard path (which clears it).
 */

import type { EnvironmentsEdit } from "@opensesame/app-core/lib/vault/body-environments.js";
import type { SchemaKey } from "@opensesame/app-core/lib/vault/environments.js";
import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import { cellOf } from "@opensesame/vault-core";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import {
  IconCopy,
  IconEye,
  IconEyeOff,
  IconTrash,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useCopySecret } from "../../lib/vault/hooks.js";
import { useArmed } from "./use-armed.js";
import { useDraft } from "./use-draft.js";

type Edit = (edit: EnvironmentsEdit) => Promise<boolean>;

type RowProps = Readonly<{
  entry: SchemaKey;
  environment: string;
  edit: Edit;
}>;

/** The variable, whether it has what it needs here, and the item it came from. */
function KeyId({
  entry,
  environment,
  required,
  saved,
}: Pick<RowProps, "entry" | "environment"> &
  Readonly<{ required: boolean; saved: string }>) {
  return (
    <div className="env__id">
      <code className="env__key">{entry.key}</code>
      {required && saved === "" ? (
        <StatusMark
          tone="warn"
          label={`${entry.key} is required in ${environment} and has no value`}
        />
      ) : saved !== "" ? (
        <StatusMark
          tone="ok"
          label={`${entry.key} has a value in ${environment}`}
        />
      ) : null}
      <span className="env__from">{entry.name}</span>
    </div>
  );
}

/** The value, concealed until shown, committed when typing settles. */
function ValueField({
  entry,
  environment,
  edit,
  saved,
}: RowProps & { saved: string }) {
  const copy = useCopySecret();
  const [reveal, setReveal] = useState(false);
  const draft = useDraft(saved, (value) => {
    void edit({
      op: "set-cell",
      itemId: entry.id,
      environment,
      cell: { value },
    });
  });
  return (
    <div className="env__field">
      <input
        className="env__input"
        type={reveal ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        maxLength={FIELD_LIMITS.secret}
        aria-label={`${entry.key} in ${environment}`}
        value={draft.value}
        onChange={(event) => draft.change(event.target.value)}
        onBlur={draft.flush}
        onKeyDown={(event) => {
          if (event.key === "Enter") draft.flush();
        }}
      />
      <IconKey
        label={reveal ? `Hide ${entry.key}` : `Show ${entry.key}`}
        aria-pressed={reveal}
        onClick={() => setReveal((on) => !on)}
      >
        {reveal ? <IconEyeOff size={17} /> : <IconEye size={17} />}
      </IconKey>
      {saved !== "" ? (
        <IconKey
          label={`Copy ${entry.key}`}
          onClick={() => {
            void copy(saved);
          }}
        >
          <IconCopy size={17} />
        </IconKey>
      ) : null}
    </div>
  );
}

/** Whether the key is required here, and a way to take it out of the schema. */
function RuleControls({
  entry,
  environment,
  edit,
  required,
}: RowProps & { required: boolean }) {
  const [armed, press] = useArmed(() => {
    void edit({ op: "remove-key", itemId: entry.id });
  });
  return (
    <div className="env__rule">
      <span className="env__ruletext" aria-hidden="true">
        Required
      </span>
      <button
        type="button"
        role="switch"
        className="toggle"
        aria-checked={required}
        aria-label={`${entry.key} required in ${environment}`}
        title={`Required in ${environment}`}
        onClick={() => {
          void edit({
            op: "set-cell",
            itemId: entry.id,
            environment,
            cell: { required: !required },
          });
        }}
      />
      <IconKey
        label={
          armed
            ? `Press again to take ${entry.key} out of every environment`
            : `Remove ${entry.key} from the schema`
        }
        armed={armed}
        onClick={press}
      >
        <IconTrash size={17} />
      </IconKey>
    </div>
  );
}

export function KeyRow({ entry, environment, edit }: RowProps) {
  const cell = cellOf(entry.cells, environment);
  const required = cell?.required === true;
  const saved = cell?.value ?? "";
  const missing = required && saved === "";
  return (
    <li className="env__row" data-missing={missing ? "" : undefined}>
      <KeyId
        entry={entry}
        environment={environment}
        required={required}
        saved={saved}
      />
      <RuleControls
        entry={entry}
        environment={environment}
        edit={edit}
        required={required}
      />
      <ValueField
        entry={entry}
        environment={environment}
        edit={edit}
        saved={saved}
      />
    </li>
  );
}
