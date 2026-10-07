import type { InventoryItem } from "@opensesame/app-core/lib/password-agent/discover.js";
import {
  parseAssignment,
  renderEnv,
} from "@opensesame/app-core/lib/password-agent/env.js";
import {
  comparePrivatePassword,
  passwordWorkflowInventory,
  resolveLocalReference,
} from "@opensesame/app-core/lib/vault/password-workflows.js";
import {
  type AccountItem,
  type PasswordMethod,
  type VaultItem,
  producePassword,
} from "@opensesame/vault-core";
import { useEffect, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import {
  CopyButton,
  FieldRow,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconDownload, IconSecret } from "../../components/Icons.js";
import { useVault } from "../../lib/vault/hooks.js";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { METHOD_LABELS, methodTitle } from "./MethodPicker.js";
import "./password-workflows.css";

export function ItemCredentialActions({ item }: { item: VaultItem }) {
  const vault = useVault();
  const [inventory, setInventory] = useState<InventoryItem | null>(null);
  const [error, setError] = useState("");
  const target = useGuideTarget<HTMLElement>("item.credentials.references");
  useEffect(() => {
    let active = true;
    setInventory(null);
    setError("");
    if (item.deletedAt !== null) return;
    void passwordWorkflowInventory().then(
      (items) => {
        if (active)
          setInventory(
            items.find(
              (entry) =>
                entry.id === item.id &&
                entry.updatedAt === item.updatedAt &&
                entry.vault === vault.tomb,
            ) ?? null,
          );
      },
      () => {
        if (active) setError("Credential references are unavailable.");
      },
    );
    return () => {
      active = false;
    };
  }, [item.id, item.updatedAt, item.deletedAt, vault.tomb]);
  if (
    item.deletedAt !== null ||
    vault.status !== "unlocked" ||
    vault.awaitingSecondStep
  )
    return null;
  const references = inventory?.fields.filter((field) => field.ref) ?? [];
  const firstComparable =
    item.kind === "account"
      ? item.methods.find(
          (method) =>
            method.type === "password" && !requiresPrivateInput(method),
        )
      : undefined;
  if (references.length === 0 && !firstComparable)
    return (
      <FailureNotice
        id={`credential-references:${item.id}`}
        title="Credential references"
        message={error}
      />
    );
  return (
    <section
      className="detail__group password-workflows"
      ref={
        item.kind === "account" || item.kind === "credential"
          ? undefined
          : target
      }
      aria-label="Credential references"
    >
      <h2 className="detail__grouphead">Credential references</h2>
      <FailureNotice
        id={`credential-references:${item.id}`}
        title="Credential references"
        message={error}
      />
      {references.map((field) =>
        field.ref ? (
          <ItemReference
            key={field.ref}
            label={referenceLabel(item, field)}
            reference={field.ref}
          />
        ) : null,
      )}
      {item.kind === "account"
        ? item.methods
            .filter(
              (method): method is PasswordMethod => method.type === "password",
            )
            .map((method) => (
              <ItemPasswordCheck
                key={method.id}
                item={item}
                method={method}
                guide={method === firstComparable}
              />
            ))
        : null}
    </section>
  );
}
function referenceLabel(
  item: VaultItem,
  field: InventoryItem["fields"][number],
): string {
  if (item.kind !== "account") return field.label;
  const method = item.methods.find((entry) => entry.id === field.section);
  if (!method) return field.label;
  const title = methodTitle(item.methods, method);
  const base = METHOD_LABELS[method.type];
  return field.label.startsWith(base)
    ? `${title}${field.label.slice(base.length)}`
    : `${title}: ${field.label}`;
}

function ItemReference({
  label,
  reference,
}: { label: string; reference: string }) {
  const { copied, failed, copy } = useCopyFeedback();
  const [variable, setVariable] = useState("CREDENTIAL");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function download(plaintext: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (plaintext) {
        if (!confirmed) throw new Error("Confirm the plaintext download.");
        downloadSeams.save(
          "credential.txt",
          await resolveLocalReference(reference),
          "text/plain",
        );
        setConfirmed(false);
        setMessage("Credential downloaded.");
      } else {
        const template = renderEnv([
          parseAssignment(`${variable}=${reference}`),
        ]);
        downloadSeams.save(".env.tpl", template, "text/plain");
        setMessage("Reference template downloaded.");
      }
    } catch {
      setError("Download failed. Unlock this vault and check access.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset disabled={busy}>
      <legend>{label}</legend>
      <FieldRow
        label="Reference"
        actions={
          <CopyButton
            value={reference}
            label={`${label} reference`}
            fieldKey={reference}
            copied={copied}
            failed={failed}
            onCopy={copy}
          />
        }
      >
        <code style={{ overflowWrap: "anywhere" }}>{reference}</code>
      </FieldRow>
      <label>
        Environment variable
        <input
          value={variable}
          onChange={(event) => setVariable(event.target.value)}
          autoComplete="off"
        />
      </label>
      <IconKey
        label={`Download ${label} reference template`}
        onClick={() => void download(false)}
      >
        <IconDownload size={17} />
      </IconKey>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        Download this credential as plaintext on this device
      </label>
      <IconKey
        label={`Download ${label} plaintext credential`}
        disabled={!confirmed}
        onClick={() => void download(true)}
      >
        <IconSecret size={17} />
      </IconKey>
      {message ? <output>{message}</output> : null}
      <FailureNotice
        id={`credential-download:${reference}`}
        title="Credential download"
        message={error}
      />
    </fieldset>
  );
}

function ItemPasswordCheck({
  item,
  method,
  guide,
}: { item: AccountItem; method: PasswordMethod; guide: boolean }) {
  const [candidate, setCandidate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const target = useGuideTarget<HTMLFieldSetElement>(
    "item.credentials.compare",
  );
  async function check(apply: boolean) {
    const value = candidate;
    setCandidate("");
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await comparePrivatePassword(
        item.id,
        value,
        apply,
        method.id,
      );
      setMessage(
        result.applied
          ? "Password updated and verified."
          : result.matches
            ? "Password matches."
            : "Password differs.",
      );
    } catch {
      setError("Password operation unverified. Do not retry automatically.");
    } finally {
      setBusy(false);
    }
  }
  if (requiresPrivateInput(method)) return null;
  return (
    <fieldset disabled={busy} ref={guide ? target : undefined}>
      <legend>Compare {methodTitle(item.methods, method).toLowerCase()}</legend>
      <label>
        Candidate password
        <input
          type="password"
          autoComplete="new-password"
          value={candidate}
          onChange={(event) => setCandidate(event.target.value)}
        />
      </label>
      <IconKey label="Compare this password" onClick={() => void check(false)}>
        <IconSecret size={17} />
      </IconKey>
      <IconKey
        label="Apply and verify this password"
        onClick={() => void check(true)}
      >
        <IconCheck size={17} />
      </IconKey>
      {message ? <output>{message}</output> : null}
      <FailureNotice
        id={`password-check:${item.id}:${method.id}`}
        title="Password verification"
        message={error}
      />
    </fieldset>
  );
}

export async function updateItemSecret(
  item: VaultItem,
  value: string,
  save: (item: VaultItem) => Promise<void>,
) {
  if (item.kind !== "secret") throw new Error("Choose a credential item.");
  try {
    await save({ ...item, value, updatedAt: new Date().toISOString() });
  } catch {
    throw new Error(
      "Credential update unverified. Do not retry automatically.",
    );
  }
}

function requiresPrivateInput(
  method: Parameters<typeof producePassword>[0],
): boolean {
  const produced = producePassword(method);
  return produced.status === "slotted" || produced.status === "legacy";
}
