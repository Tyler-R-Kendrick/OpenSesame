import {
  type AccountItem,
  type LoginMethod,
  type PasswordMethod,
  changedFieldKeys,
  completePassword,
  producePassword,
} from "@opensesame/vault-core";
import type { InventoryItem } from "../password-agent/discover.js";
import { itemText } from "./item-departure.js";
export function accountMethodField(methodId: string, field: string): string {
  return `method:${methodId}:${field}`;
}
interface MethodSecret {
  field: string;
  label: string;
  available: boolean;
}
function methodSecrets(method: LoginMethod): MethodSecret[] {
  switch (method.type) {
    case "password":
      return [
        {
          field: "secret",
          label: "Password",
          available: completePassword(producePassword(method)) !== null,
        },
      ];
    case "api-key":
      return [
        { field: "key", label: "API key", available: method.key.length > 0 },
      ];
    case "token":
      return [
        { field: "token", label: "Token", available: method.token.length > 0 },
      ];
    case "oauth":
      return [
        {
          field: "clientSecret",
          label: "OAuth client secret",
          available: method.clientSecret.length > 0,
        },
        {
          field: "refreshToken",
          label: "OAuth refresh token",
          available: method.refreshToken.length > 0,
        },
      ];
    case "authenticator":
      return [
        {
          field: "secret",
          label: "Authenticator seed",
          available: method.secret.length > 0,
        },
      ];
  }
}
export function accountFieldMetadata(
  item: AccountItem,
  reference: (field: string) => string,
): InventoryItem["fields"] {
  return item.methods.flatMap((method) =>
    methodSecrets(method).map((secret) => {
      const metadata: InventoryItem["fields"][number] = {
        label: secret.label,
        type: "concealed",
        section: method.id,
        purpose: method.type,
      };
      if (
        secret.available &&
        item.methods.filter((entry) => entry.id === method.id).length === 1 &&
        !item.fields.some(
          (field) =>
            field.hidden &&
            field.id === accountMethodField(method.id, secret.field),
        )
      )
        metadata.ref = reference(accountMethodField(method.id, secret.field));
      return metadata;
    }),
  );
}
export function selectedPassword(
  item: AccountItem,
  methodId?: string,
): PasswordMethod {
  const methods = item.methods.filter(
    (method): method is PasswordMethod =>
      method.type === "password" &&
      (methodId === undefined || method.id === methodId),
  );
  const selected = methods[0];
  if (
    !selected ||
    methods.length !== 1 ||
    item.methods.filter((method) => method.id === selected.id).length !== 1
  )
    throw new Error("Choose exactly one account password method.");
  privatePasswordValue(selected);
  return selected;
}
/** Human reads receive the produced password, never an algorithm's root secret. */
export function privatePasswordValue(method: PasswordMethod): string {
  const produced = producePassword(method);
  if (produced.status === "absent") return "";
  const password = completePassword(produced);
  if (password === null)
    throw new Error(
      "This password needs human pepper or Sphinx input; use the account's human password action.",
    );
  return password;
}
function methodSecret(method: LoginMethod, field: string): string | undefined {
  switch (method.type) {
    case "password": {
      if (field !== "secret") return undefined;
      return privatePasswordValue(method);
    }
    case "api-key":
      return field === "key" ? method.key : undefined;
    case "token":
      return field === "token" ? method.token : undefined;
    case "oauth":
      return field === "clientSecret"
        ? method.clientSecret
        : field === "refreshToken"
          ? method.refreshToken
          : undefined;
    case "authenticator":
      return field === "secret" ? method.secret : undefined;
  }
}
export function accountSecretField(
  item: AccountItem,
  field: string,
): string | undefined {
  if (field === "password") return privatePasswordValue(selectedPassword(item));
  const matches = item.methods.flatMap((method) =>
    methodSecrets(method).flatMap((secret) =>
      accountMethodField(method.id, secret.field) === field
        ? [{ method, field: secret.field }]
        : [],
    ),
  );
  const selected = matches[0];
  if (!selected) return undefined;
  if (
    matches.length !== 1 ||
    item.fields.some((custom) => custom.hidden && custom.id === field) ||
    item.methods.filter((method) => method.id === selected.method.id).length !==
      1
  )
    throw new Error("The account method reference is ambiguous.");
  return methodSecret(selected.method, selected.field);
}
export function withPrivatePassword(
  item: AccountItem,
  selected: PasswordMethod,
  candidate: string,
  now: string,
): AccountItem {
  return {
    ...item,
    updatedAt: now,
    methods: item.methods.map((method) =>
      method.id === selected.id
        ? {
            ...selected,
            secret: candidate,
            changedAt: now,
            generator: { id: "manual" },
          }
        : method,
    ),
  };
}

/** Verify the exact field-clock transition owned by the store's shared stamper. */
export function matchesWrittenAccount(
  saved: AccountItem,
  expected: AccountItem,
  original: AccountItem,
): boolean {
  const committed = Date.parse(saved.updatedAt);
  const observed = [
    original.createdAt,
    original.updatedAt,
    ...Object.values(original.fieldTimes ?? {}),
  ];
  if (
    !Number.isFinite(committed) ||
    new Date(committed).toISOString() !== saved.updatedAt ||
    committed < Date.parse(expected.updatedAt) ||
    observed.some(
      (stamp) =>
        !Number.isFinite(Date.parse(stamp)) || committed <= Date.parse(stamp),
    )
  )
    return false;
  const fieldTimes = { ...original.fieldTimes };
  // A method's clock is its credential's own `updatedAt`, so the account
  // records none for it (ADR 0179).
  for (const key of changedFieldKeys(original, expected))
    if (key !== "methods" && !key.startsWith("methods."))
      fieldTimes[key] = saved.updatedAt;
  return (
    itemText(saved) ===
    itemText({ ...expected, updatedAt: saved.updatedAt, fieldTimes })
  );
}
