import {
  type DeadmanRelease as Release,
  loadDeadmanRelease,
  releaseDeadmanSwitch,
} from "@opensesame/app-core/lib/deadman/index.js";
import { KIND_LABEL, type VaultItem } from "@opensesame/vault-core";
import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { FailureNotice } from "../components/FailureNotice.js";
import { FormCommit } from "../components/FormCommit.js";
import { StatusMark } from "../components/StatusMark.js";
import { useVault } from "../lib/vault/hooks.js";
import "./deadman-release.css";

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

function readable(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value))
    return value.length === 0 ? null : value.map(String).join(", ");
  return null;
}

function fieldsOf(item: VaultItem): Field[] {
  const out: Field[] = [];
  for (const [key, value] of Object.entries(item)) {
    if (COMMON.has(key)) continue;
    if (key === "method" && value && typeof value === "object") {
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subKey === "id") continue;
        const text = readable(subValue);
        if (text !== null) out.push({ label: subKey, value: text });
      }
      continue;
    }
    if (key === "values" && value && typeof value === "object") {
      for (const [subKey, subValue] of Object.entries(value)) {
        const text = readable(subValue);
        if (text !== null) out.push({ label: subKey, value: text });
      }
      continue;
    }
    const text = readable(value);
    if (text !== null) out.push({ label: key, value: text });
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

export function DeadmanRelease() {
  const { tomb, guest } = useVault();
  const [release, setRelease] = useState<Release | null>(null);
  const [items, setItems] = useState<VaultItem[] | null>(null);
  const [releaseKey, setReleaseKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // A released tab is still a tab. Hiding it drops the decrypted copy even
  // though the vault itself was never opened.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") setItems(null);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  useEffect(() => {
    if (guest) {
      setError("A deadman switch is not available in a guest session.");
      return;
    }
    let live = true;
    void loadDeadmanRelease(tomb)
      .then((next) => {
        if (live) setRelease(next);
      })
      .catch((caught) => {
        if (live)
          setError(
            caught instanceof Error
              ? caught.message
              : "No deadman switch is available here.",
          );
      });
    return () => {
      live = false;
    };
  }, [guest, tomb]);

  function open(event: FormEvent) {
    event.preventDefault();
    if (busy || !release) return;
    setBusy(true);
    setError("");
    void releaseDeadmanSwitch(tomb, releaseKey)
      .then((opened) => {
        setItems(opened);
        setReleaseKey("");
      })
      .catch((caught) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "That release key did not open the switch.",
        );
      })
      .finally(() => setBusy(false));
  }

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
