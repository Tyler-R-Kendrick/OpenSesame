import {
  type PasswordAgentPort,
  type RecordValue,
  id,
  invoke,
  json,
  record,
  records,
  string,
} from "./transport.js";
import { templatePreserved } from "./verify-template.js";
export interface PasswordOptions {
  item: string;
  vault: string;
  account?: string;
  desktop?: boolean;
  apply?: boolean;
  repairImportedFields?: boolean;
}
const builtIn = (fields: RecordValue[]) =>
  fields.filter(
    (field) =>
      field.id === "password" &&
      field.purpose === "PASSWORD" &&
      field.type === "CONCEALED" &&
      field.section === undefined,
  );
export async function password(
  port: PasswordAgentPort,
  options: PasswordOptions,
  value: string,
) {
  if (!options.item.trim() || !options.vault.trim() || !value.trim())
    throw new Error(
      "An item, explicit vault and non-empty password are required; nothing was changed",
    );
  const inspectFailure =
    "Could not inspect login; nothing was changed (details suppressed)";
  const args = (item: string, vault: string) => [
    "item",
    "get",
    item,
    "--vault",
    vault,
    "--format",
    "json",
    "--reveal",
  ];
  const { item, fields, itemId, vaultId, vault } = await inspect(
    port,
    options,
    args,
    inspectFailure,
  );
  const current = builtIn(fields);
  if (item.category !== "LOGIN" || current.length !== 1)
    throw new Error(
      "Expected a Login with exactly one built-in password; nothing was changed",
    );
  const receipt = {
    id: itemId,
    title: item.title,
    vault: vault.name,
    ref: `op://${vaultId}/${itemId}/password`,
  };
  if (!options.apply)
    return { ...receipt, matches: current[0]?.value === value };
  if (current[0]?.value === value)
    return { ...receipt, changed: false, verified: true };
  prepareFields(item, fields, current[0], value, options);
  item.fields = fields;
  const uncertain =
    "Password update is unverified; check this item before retrying (details suppressed)";
  await invoke(
    port,
    ["item", "edit", itemId, "--vault", vaultId, "--format", "json"],
    { ...options, input: JSON.stringify(item) },
    uncertain,
  );
  try {
    const stored = record(
      await json(port, args(itemId, vaultId), options, uncertain),
    );
    verifyStored(item, stored, value, uncertain);
  } catch {
    throw new Error(uncertain);
  }
  return { ...receipt, changed: true, verified: true };
}

function prepareFields(
  item: RecordValue,
  fields: RecordValue[],
  current: RecordValue | undefined,
  value: string,
  options: PasswordOptions,
) {
  if (
    (Array.isArray(item.passkeys) && item.passkeys.length) ||
    fields.some((field) => field.type === "PASSKEY")
  )
    throw new Error(
      "Cannot safely edit a login with passkeys; nothing was changed",
    );
  const existingIds = new Set(
    fields.flatMap((field) =>
      field.id === undefined ? [] : [string(field.id)],
    ),
  );
  for (const [index, field] of fields.entries()) {
    if (!field.id && !field.label) {
      if (!options.repairImportedFields)
        throw new Error(
          "Unnamed imported fields require explicit repair; nothing was changed",
        );
      const repairedId = `imported_field_${index + 1}`;
      if (existingIds.has(repairedId))
        throw new Error(
          "Imported field repair would collide; nothing was changed",
        );
      existingIds.add(repairedId);
      field.id = repairedId;
      field.label = `Imported field ${index + 1}`;
      field.type = "CONCEALED";
    }
    if (field === current) field.value = value;
  }
}

async function inspect(
  port: PasswordAgentPort,
  options: PasswordOptions,
  args: (item: string, vault: string) => string[],
  inspectFailure: string,
) {
  let item: RecordValue;
  let fields: RecordValue[];
  let itemId: string;
  let vaultId: string;
  let vault: RecordValue;
  try {
    item = record(
      await json(
        port,
        args(options.item, options.vault),
        options,
        inspectFailure,
      ),
    );
    fields = records(item.fields);
    itemId = id(item.id);
    vault = record(item.vault);
    vaultId = id(vault.id);
    string(item.title);
    string(item.category);
    string(vault.name);
  } catch {
    throw new Error(inspectFailure);
  }
  return { item, fields, itemId, vaultId, vault };
}

function verifyStored(
  item: RecordValue,
  stored: RecordValue,
  value: string,
  uncertain: string,
) {
  const passwords = builtIn(records(stored.fields));
  if (
    stored.id !== item.id ||
    record(stored.vault).id !== record(item.vault).id ||
    stored.title !== item.title ||
    stored.category !== item.category ||
    passwords.length !== 1 ||
    passwords[0]?.value !== value ||
    !templatePreserved(item, stored)
  )
    throw new Error(uncertain);
}
