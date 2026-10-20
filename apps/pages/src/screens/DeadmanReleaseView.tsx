import type { DeadmanRelease as Release } from "@opensesame/app-core/lib/deadman/index.js";
import {
  type BoundaryValue,
  isBoolean,
  isNumber,
  isString,
  isTypeofObject,
} from "@opensesame/os-domain";
import { KIND_LABEL, type VaultItem } from "@opensesame/vault-core";
import type { FormEvent } from "react";
import { Link } from "react-router";
import { FailureNotice } from "../components/FailureNotice.js";
import { FormCommit } from "../components/FormCommit.js";
import { StatusMark } from "../components/StatusMark.js";

type Field = { label: string; value: string };

const COMMON = new Set([
  "id",
  "kind",
  "name",
  "folderId",
  "favorite",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "fieldTimes",
  "notes",
  "fields",
  "environments",
]);

function readable(value: BoundaryValue): string | null {
  if (isString(value)) return value.length > 0 ? value : null;
  if (isNumber(value) || isBoolean(value)) return String(value);
  if (Array.isArray(value))
    return value.length === 0 ? null : value.map(String).join(", ");
  return null;
}

function appendReadableField(
  out: Field[],
  label: string,
  value: BoundaryValue,
): void {
  const text = readable(value);
  if (text !== null) out.push({ label, value: text });
}

function fieldsOf(item: VaultItem): Field[] {
  const out: Field[] = [];
  for (const [key, value] of Object.entries(item)) {
    if (COMMON.has(key)) continue;
    if (key === "method" && isTypeofObject(value) && value) {
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subKey === "id") continue;
        appendReadableField(out, subKey, subValue);
      }
      continue;
    }
    if (key === "values" && isTypeofObject(value) && value) {
      for (const [subKey, subValue] of Object.entries(value)) {
        appendReadableField(out, subKey, subValue);
      }
      continue;
    }
    appendReadableField(out, key, value);
  }
  for (const field of item.fields) {
    if (field.value.length > 0)
      out.push({ label: field.name, value: field.value });
  }
  return out;
}

function ReleasedItem({ item }: { item: VaultItem }) {
  const fields = fieldsOf(item);
  return (
    <article className="deadman-release__item">
      <h2>{item.name}</h2>
      <StatusMark tone="idle" label={KIND_LABEL[item.kind]} />
      {fields.length > 0 ? (
        <dl>
          {fields.map((field) => (
            <div key={`${field.label}:${field.value.slice(0, 20)}`}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {item.notes.length > 0 ? <p>{item.notes}</p> : null}
    </article>
  );
}

type ReleaseViewProps = {
  release: Release | null;
  items: VaultItem[] | null;
  releaseKey: string;
  busy: boolean;
  error: string;
  open: (event: FormEvent) => void;
  setReleaseKey: (value: string) => void;
};

export function DeadmanReleaseView({
  release,
  items,
  releaseKey,
  busy,
  error,
  open,
  setReleaseKey,
}: ReleaseViewProps) {
  return (
    <div className="deadman-release">
      <h1>Deadman switch</h1>
      {items ? (
        <>
          <StatusMark
            tone="warn"
            label={`${items.length} ${items.length === 1 ? "item" : "items"} released. They are decrypted in this tab only.`}
          />
          <div className="deadman-release__items">
            {items.map((item) => (
              <ReleasedItem key={item.id} item={item} />
            ))}
          </div>
          <Link className="deadman-release__leave" to="/">
            Leave and lock
          </Link>
        </>
      ) : release ? (
        <form className="deadman-release__form" onSubmit={open}>
          <p>
            The deadline passed on this device. Enter the release key that was
            stored when the switch was armed.
          </p>
          <div className="field">
            <label htmlFor="deadman-release-key">Release key</label>
            <input
              id="deadman-release-key"
              autoComplete="off"
              spellCheck={false}
              value={releaseKey}
              disabled={busy}
              onChange={(event) => setReleaseKey(event.target.value)}
            />
          </div>
          <FailureNotice
            id="deadman-release:error"
            title="Deadman switch"
            message={error}
          />
          <FormCommit
            label="Open released items"
            disabled={busy || releaseKey.trim().length === 0}
            busy={busy}
          />
        </form>
      ) : error ? (
        <>
          <FailureNotice
            id="deadman-release:error"
            title="Deadman switch"
            message={error}
          />
          <Link className="deadman-release__leave" to="/">
            Back to unlock
          </Link>
        </>
      ) : (
        <StatusMark
          tone="idle"
          label="Checking this device's deadman record…"
        />
      )}
    </div>
  );
}
