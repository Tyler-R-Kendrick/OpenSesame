import {
  type PasswordAgentPort,
  type RecordValue,
  id,
  json,
  record,
  records,
  string,
} from "./transport.js";
import { preserves } from "./verify-template.js";
export interface Destination {
  title: string;
  vault: string;
  account?: string;
  desktop?: boolean;
  url?: string;
  notes?: string;
}
const uncertain =
  "Creation is unverified; do not retry creation; inspect the destination first (details suppressed)";
function template(destination: Destination, credential: string) {
  const fields = [
    {
      id: "credential",
      type: "CONCEALED",
      label: "credential",
      value: credential,
    },
  ];
  const result: RecordValue = {
    title: destination.title,
    category: "API_CREDENTIAL",
    fields,
  };
  if (destination.notes !== undefined)
    fields.push({
      id: "notesPlain",
      type: "STRING",
      label: "notesPlain",
      value: destination.notes,
    });
  if (destination.notes !== undefined)
    Object.assign(fields[1] ?? {}, { purpose: "NOTES" });
  if (destination.url !== undefined)
    result.urls = [{ href: destination.url, primary: true }];
  return result;
}
async function checkTitle(port: PasswordAgentPort, destination: Destination) {
  const listed = records(
    await json(
      port,
      ["item", "list", "--vault", destination.vault, "--format", "json"],
      destination,
      "Could not check the destination; nothing was created (details suppressed)",
    ),
  );
  if (
    listed.some(
      (item) =>
        string(item.title).trim().toLowerCase() ===
        destination.title.toLowerCase(),
    )
  )
    throw new Error(
      "An item with this title already exists; nothing was created or overwritten",
    );
}
function checkReceipt(receipt: RecordValue, destination: Destination) {
  const itemId = id(receipt.id);
  const vault = record(receipt.vault);
  const vaultId = id(vault.id);
  string(vault.name);
  if (
    receipt.title !== destination.title ||
    receipt.category !== "API_CREDENTIAL"
  )
    throw new Error(uncertain);
  if (vault.name !== destination.vault && vaultId !== destination.vault)
    throw new Error(uncertain);
  return { itemId, vaultId, vaultName: vault.name };
}
function checkCredential(fields: RecordValue[], credential: string) {
  const matches = fields.filter((field) => field.id === "credential");
  if (matches.length !== 1) throw new Error(uncertain);
  const field = matches[0];
  if (
    !preserves(
      {
        type: "CONCEALED",
        label: "credential",
        value: credential,
      },
      field,
    )
  )
    throw new Error(uncertain);
  if (field?.section !== undefined) throw new Error(uncertain);
  if (field?.purpose !== undefined && field.purpose !== "PASSWORD")
    throw new Error(uncertain);
}
function checkStored(
  stored: RecordValue,
  receipt: ReturnType<typeof checkReceipt>,
  destination: Destination,
  credential: string,
) {
  const vault = record(stored.vault);
  if (
    !preserves(
      {
        id: receipt.itemId,
        title: destination.title,
        category: "API_CREDENTIAL",
      },
      stored,
    )
  )
    throw new Error(uncertain);
  if (vault.id !== receipt.vaultId || vault.name !== receipt.vaultName)
    throw new Error(uncertain);
  const fields = records(stored.fields);
  checkCredential(fields, credential);
  if (destination.notes !== undefined) {
    const notes = fields.filter(
      (field) => field.id === "notesPlain" && field.section === undefined,
    );
    if (
      notes.length !== 1 ||
      !preserves(
        { type: "STRING", purpose: "NOTES", value: destination.notes },
        notes[0],
      )
    )
      throw new Error(uncertain);
  }
  if (
    destination.url !== undefined &&
    !records(stored.urls).some((url) => url.href === destination.url)
  )
    throw new Error(uncertain);
}
export async function createApiCredential(
  port: PasswordAgentPort,
  destination: Destination,
  sourceValue: string,
) {
  const normalized = {
    ...destination,
    title: destination.title.trim(),
    vault: destination.vault.trim(),
  };
  const credential = sourceValue.replace(/\r?\n$/, "");
  if (!normalized.title || !normalized.vault || !credential.trim())
    throw new Error(
      "A title, explicit vault and non-empty credential are required; nothing was created",
    );
  await checkTitle(port, normalized);
  try {
    const rawReceipt = record(
      await json(
        port,
        [
          "item",
          "create",
          "-",
          "--vault",
          normalized.vault,
          "--format",
          "json",
        ],
        {
          ...normalized,
          input: JSON.stringify(template(normalized, credential)),
        },
        uncertain,
      ),
    );
    const receipt = checkReceipt(rawReceipt, normalized);
    const stored = record(
      await json(
        port,
        [
          "item",
          "get",
          receipt.itemId,
          "--vault",
          receipt.vaultId,
          "--format",
          "json",
          "--reveal",
        ],
        normalized,
        uncertain,
      ),
    );
    checkStored(stored, receipt, normalized, credential);
    return {
      id: receipt.itemId,
      title: normalized.title,
      vault: normalized.vault,
      kind: "api-credential",
      field: "credential",
      ref: `op://${receipt.vaultId}/${receipt.itemId}/credential`,
      verified: true,
    };
  } catch {
    throw new Error(uncertain);
  }
}
