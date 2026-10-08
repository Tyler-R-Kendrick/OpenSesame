import type { InventoryItem } from "@opensesame/app-core/lib/password-agent/discover.js";
import { itemEnvTemplate } from "@opensesame/app-core/lib/vault/item-references.js";
import {
  passwordWorkflowInventory,
  resolveLocalEnvTemplate,
} from "@opensesame/app-core/lib/vault/password-workflows.js";
import type { VaultItem } from "@opensesame/vault-core";
import { useEffect, useRef, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconAlert, IconDownload } from "../../components/Icons.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
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

type Admission = { inventory: InventoryItem; check: () => void };
type Failure = { message: string; check: () => void };

function currentFailure(failure: Failure | null): string {
  try {
    failure?.check();
    return failure?.message ?? "";
  } catch {
    return "";
  }
}

/** Retain the session and item version that admitted an inventory request. */
function pinItemInventory(
  store: ReturnType<typeof useVaultStore>,
  id: VaultItem["id"],
  updatedAt: VaultItem["updatedAt"],
  tomb: string,
): () => void {
  const session = store.pinContinuation();
  return () => {
    session();
    const current = store.getSnapshot();
    const present = current.items.find((entry) => entry.id === id);
    if (
      current.status !== "unlocked" ||
      current.awaitingSecondStep ||
      current.tomb !== tomb ||
      !present ||
      present.deletedAt !== null ||
      present.updatedAt !== updatedAt
    )
      throw new Error("The item changed.");
  };
}

/** Inventory and its original session authority travel together. */
function useItemInventory(item: VaultItem, tomb: string) {
  const store = useVaultStore();
  const vault = useVault();
  const [admitted, setAdmitted] = useState<Admission | null>(null);
  const [failure, setFailure] = useState<
    | (Failure & {
        id: string;
        updatedAt: string;
        tomb: string;
      })
    | null
  >(null);
  useEffect(() => {
    let active = true;
    setAdmitted(null);
    setFailure(null);
    if (item.deletedAt !== null || vault.status !== "unlocked") return;
    let check: () => void;
    try {
      check = pinItemInventory(store, item.id, item.updatedAt, tomb);
      check();
    } catch {
      return;
    }
    void passwordWorkflowInventory().then(
      (items) => {
        if (!active) return;
        try {
          check();
          const inventory = items.find(
            (entry) =>
              entry.id === item.id &&
              entry.updatedAt === item.updatedAt &&
              entry.vault === tomb,
          );
          setAdmitted(inventory ? { inventory, check } : null);
        } catch {
          /* Retired inventory cannot be published. */
        }
      },
      () => {
        if (!active) return;
        try {
          check();
          setFailure({
            message: "References are unavailable.",
            check,
            id: item.id,
            updatedAt: item.updatedAt,
            tomb,
          });
        } catch {
          /* Retired failures cannot be published. */
        }
      },
    );
    return () => {
      active = false;
    };
  }, [item.id, item.updatedAt, item.deletedAt, tomb, vault, store]);
  let admission: Admission | null = null;
  try {
    admitted?.check();
    const entry = admitted?.inventory;
    if (
      entry?.id === item.id &&
      entry.updatedAt === item.updatedAt &&
      entry.vault === tomb &&
      item.deletedAt === null
    )
      admission = admitted;
  } catch {
    /* Retained metadata cannot belong to a successor. */
  }
  const sameItem =
    failure?.id === item.id &&
    failure.updatedAt === item.updatedAt &&
    failure.tomb === tomb &&
    item.deletedAt === null;
  return {
    admission,
    error: sameItem ? currentFailure(failure) : "",
    occurrence: sameItem ? failure : null,
  };
}

/** Both downloads and the two presses retain the inventory's admission. */
function useReferenceDownloads(
  name: string,
  references: readonly Reference[],
  admission: Admission | null,
) {
  const current = useRef(admission);
  current.current = admission;
  const [consent, setConsent] = useState<Admission | null>(null);
  const pendingConsent = useRef<Admission | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    current.current = admission;
    return () => {
      current.current = null;
    };
  }, [admission]);
  const check = (intent: Admission) => {
    intent.check();
    if (current.current !== intent) throw new Error("The references changed.");
  };
  let armed = false;
  try {
    if (
      consent &&
      consent === admission &&
      pendingConsent.current === consent
    ) {
      check(consent);
      armed = true;
    }
  } catch {
    /* A prior first press carries no authority. */
  }
  const notice = (intent: Admission, message: string) => {
    try {
      check(intent);
      setFailure({ message, check: () => check(intent) });
    } catch {
      /* A retired intent cannot publish into its successor. */
    }
  };
  const template = () => itemEnvTemplate(name, references);
  const saveTemplate = () => {
    if (!admission) return;
    try {
      check(admission);
      setFailure(null);
      downloadSeams.save("references.env.tpl", template(), "text/plain");
    } catch {
      notice(admission, "The template could not be written.");
    }
  };
  const savePlaintext = async () => {
    const intent = armed ? consent : admission;
    if (!intent) return;
    try {
      check(intent);
      if (!armed) {
        pendingConsent.current = intent;
        setConsent(intent);
        return;
      }
      if (pendingConsent.current !== intent) return;
      pendingConsent.current = null;
      setConsent(null);
      setFailure(null);
      const resolved = await resolveLocalEnvTemplate(template());
      check(intent);
      downloadSeams.save("plaintext.env", resolved.content, "text/plain");
    } catch {
      notice(intent, "The environment file could not be written.");
    }
  };
  return {
    armed,
    error: currentFailure(failure),
    occurrence: failure,
    saveTemplate,
    savePlaintext,
    disarm: () => {
      pendingConsent.current = null;
      setConsent(null);
    },
  };
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
  const {
    admission,
    error: inventoryError,
    occurrence: inventoryFailure,
  } = useItemInventory(item, vault.tomb);
  const inventory = admission?.inventory;
  const target = useGuideTarget<HTMLButtonElement>(
    "item.credentials.references",
  );
  const references = (inventory?.fields ?? []).flatMap((field) =>
    field.ref ? [{ label: referenceLabel(item, field), ref: field.ref }] : [],
  );
  const downloads = useReferenceDownloads(
    item.name || "Item",
    references,
    admission,
  );
  const { armed } = downloads;
  const error = downloads.error || inventoryError;
  const failure = (
    <FailureNotice
      id={`item-references:${item.id}`}
      title="References"
      message={error}
      occurrence={downloads.error ? downloads.occurrence : inventoryFailure}
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
        onBlur={downloads.disarm}
      >
        <IconAlert size={17} />
      </IconKey>
    </>
  );
}
