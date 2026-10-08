import type { InventoryItem } from "@opensesame/app-core/lib/password-agent/discover.js";
import { itemEnvTemplate } from "@opensesame/app-core/lib/vault/item-references.js";
import {
  passwordWorkflowInventory,
  resolveLocalEnvTemplate,
} from "@opensesame/app-core/lib/vault/password-workflows.js";
import type { VaultItem } from "@opensesame/vault-core";
import { useEffect, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconAlert, IconDownload } from "../../components/Icons.js";
import { useVault } from "../../lib/vault/hooks.js";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { METHOD_LABELS, methodTitle } from "./MethodPicker.js";

/** The label a reference carries on an account: its method's title, not a bare field name. */
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

type Reference = { label: string; ref: string };

/** What the two downloads read and set on the group: the second press, and a failure. */
type DownloadState = {
  armed: boolean;
  setArmed: (armed: boolean) => void;
  setError: (message: string) => void;
};

/**
 * This item's inventory entry, read again whenever the item or the vault
 * changes; an item the vault has since moved past answers nothing.
 */
function useItemInventory(item: VaultItem, tomb: string) {
  const [inventory, setInventory] = useState<InventoryItem | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setInventory(null);
    setFailed(false);
    if (item.deletedAt !== null) return;
    void passwordWorkflowInventory().then(
      (items) => {
        if (active)
          setInventory(
            items.find(
              (entry) =>
                entry.id === item.id &&
                entry.updatedAt === item.updatedAt &&
                entry.vault === tomb,
            ) ?? null,
          );
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [item.id, item.updatedAt, item.deletedAt, tomb]);
  return { inventory, failed };
}

/**
 * The two files a group of references can write: the template, which holds no
 * value, and a plaintext `.env`, which asks twice. A failure is reported
 * without its cause.
 */
function useReferenceDownloads(
  name: string,
  references: readonly Reference[],
  state: DownloadState,
) {
  const { armed, setArmed, setError } = state;
  const template = () => itemEnvTemplate(name, references);
  const saveTemplate = () => {
    setError("");
    try {
      downloadSeams.save("references.env.tpl", template(), "text/plain");
    } catch {
      setError("The template could not be written.");
    }
  };
  const savePlaintext = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setError("");
    try {
      const resolved = await resolveLocalEnvTemplate(template());
      downloadSeams.save("plaintext.env", resolved.content, "text/plain");
    } catch {
      setError("The environment file could not be written.");
    }
  };
  return { saveTemplate, savePlaintext };
}

/**
 * The item's two reference keys, on its toolbar beside the other verbs. The
 * fields a reference names are already the rows above, each with its own reveal
 * and copy; these write them out by reference. The first key writes a
 * reference-only environment template, which holds no value. The second writes
 * a plaintext `.env` and asks twice: the first press writes nothing.
 */
export function ReferenceKeys({ item }: { item: VaultItem }) {
  const vault = useVault();
  const [writeError, setWriteError] = useState("");
  const [armed, setArmed] = useState(false);
  const { inventory, failed: unavailable } = useItemInventory(item, vault.tomb);
  const target = useGuideTarget<HTMLButtonElement>(
    "item.credentials.references",
  );
  const error =
    writeError || (unavailable ? "References are unavailable." : "");
  const references = (inventory?.fields ?? []).flatMap((field) =>
    field.ref ? [{ label: referenceLabel(item, field), ref: field.ref }] : [],
  );
  const downloads = useReferenceDownloads(item.name || "Item", references, {
    armed,
    setArmed,
    setError: setWriteError,
  });
  const failure = (
    <FailureNotice
      id={`item-references:${item.id}`}
      title="References"
      message={error}
    />
  );
  const hidden =
    item.deletedAt !== null ||
    vault.status !== "unlocked" ||
    vault.awaitingSecondStep;
  if (hidden || references.length === 0) return failure;
  const really = "Really download a plaintext .env? Press again to confirm";
  return (
    <>
      {failure}
      <IconKey
        keyRef={target}
        label="Download reference template"
        onClick={downloads.saveTemplate}
      >
        <IconDownload size={17} />
      </IconKey>
      <IconKey
        armed={armed}
        label={armed ? really : "Download plaintext .env"}
        onClick={() => void downloads.savePlaintext()}
        onBlur={() => setArmed(false)}
      >
        <IconAlert size={17} />
      </IconKey>
    </>
  );
}
