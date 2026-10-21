import type { BoundaryValue } from "@opensesame/os-domain";
/** Native Azure Key Vault Secrets REST 2025-07-01 data; no app-specific value wrapper. */
import { z } from "zod";
import { zodJitless } from "../zod-jitless.js";
zodJitless();
import { secretBackendUrl } from "./http.js";
import {
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemInput,
} from "./types.js";

export const AZURE_SECRET_BYTES = 25 * 1024;
export const AZURE_RESPONSE_BYTES = 1024 * 1024;
export const AZURE_API_VERSION = "2025-07-01";
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const attributes = z.object({
  enabled: z.boolean().optional(),
  nbf: timestamp.optional(),
  exp: timestamp.optional(),
  created: timestamp.optional(),
  updated: timestamp.optional(),
  recoveryLevel: z
    .enum([
      "Purgeable",
      "Recoverable+Purgeable",
      "Recoverable",
      "Recoverable+ProtectedSubscription",
      "CustomizedRecoverable+Purgeable",
      "CustomizedRecoverable",
      "CustomizedRecoverable+ProtectedSubscription",
    ])
    .optional(),
});
const metadata = z.object({
  id: z.string().max(2048),
  contentType: z.string().max(255).optional(),
  tags: z
    .record(z.string().max(512), z.string().max(512))
    .refine((tags) => Object.keys(tags).length <= 15)
    .optional(),
  attributes: attributes.optional(),
  managed: z.boolean().optional(),
});
const bundle = metadata.extend({ value: z.string() });
const page = z.object({
  value: z.array(metadata).max(25),
  nextLink: z.string().max(8192).nullable().optional(),
});
export type AzureSecretBundle = z.infer<typeof bundle>;
export type AzureSecretReference = {
  name: string;
  version?: string;
  id: string;
};

function invalid(message: string): never {
  throw new SecretBackendError("response", message);
}
export function azureVaultBase(value: string): URL {
  const base = secretBackendUrl(value);
  if (base.pathname !== "/")
    throw new SecretBackendError(
      "configuration",
      "Use the vault origin without a path.",
    );
  return base;
}
export function azureSecretName(value: string): string {
  if (!/^[a-zA-Z0-9-]{1,127}$/.test(value))
    throw new SecretBackendError(
      "configuration",
      "Azure secret names need 1–127 letters, digits or hyphens.",
    );
  return value.toLowerCase();
}
/** Credentials and values never follow a cross-vault, encoded or non-secret reference. */
export function azureSecretReference(
  value: string,
  base: URL,
): AzureSecretReference {
  if (!value.includes(":")) {
    const name = azureSecretName(value);
    return { name, id: `${base.origin}/secrets/${name}` };
  }
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return invalid("Invalid Azure secret identifier.");
  }
  const rawPath = /^https?:\/\/[^/?#]+(\/[^?#]*)/.exec(value)?.[1];
  if (rawPath !== target.pathname || value.includes("\\"))
    return invalid("Azure identifiers must use canonical paths.");
  const match =
    /^\/secrets\/([a-zA-Z0-9-]{1,127})(?:\/([a-fA-F0-9]{32}))?$/.exec(
      target.pathname,
    );
  if (
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !match
  )
    return invalid("The Azure secret identifier must stay in this vault.");
  const name = azureSecretName(match[1] ?? "");
  const reference: AzureSecretReference = {
    name,
    id: `${base.origin}/secrets/${name}`,
  };
  if (match[2]) reference.version = match[2].toLowerCase();
  return reference;
}
export function azureSecretPath(reference: AzureSecretReference): string {
  return `/secrets/${reference.name}${reference.version ? `/${reference.version}` : ""}`;
}
export function azureSecretBundle(
  value: BoundaryValue,
  base: URL,
  expected: AzureSecretReference,
): AzureSecretBundle {
  const result = bundle.safeParse(value);
  if (!result.success)
    return invalid("Azure returned an invalid secret bundle.");
  const actual = azureSecretReference(result.data.id, base);
  if (
    !actual.version ||
    actual.id !== expected.id ||
    (expected.version && actual.version !== expected.version)
  )
    return invalid("Azure returned another secret or version.");
  if (
    new TextEncoder().encode(result.data.value).byteLength > AZURE_SECRET_BYTES
  )
    return invalid("Azure secret exceeds the supported value size.");
  return result.data;
}
export function azureSecretItem(
  value: AzureSecretBundle,
  base: URL,
): SecretBackendItem {
  const ref = azureSecretReference(value.id, base);
  return {
    id: ref.id,
    name: ref.name,
    kind: "secret",
    notes: "",
    secret: value.value,
  };
}
export function azureSecretPage(value: BoundaryValue, base: URL) {
  const result = page.safeParse(value);
  if (!result.success)
    return invalid("Azure returned an invalid secrets page.");
  const items = result.data.value.map((entry) => {
    const ref = azureSecretReference(entry.id, base);
    if (ref.version)
      return invalid("Azure list must contain logical secret identifiers.");
    return { id: ref.id, name: ref.name, kind: "secret" as const };
  });
  return { items, next: result.data.nextLink || undefined };
}
export function azureNextPage(value: string, base: URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("Azure returned an invalid pagination URL.");
  }
  if (
    /^https?:\/\/[^/?#]+(\/[^?#]*)/.exec(value)?.[1] !== url.pathname ||
    value.includes("\\") ||
    url.origin !== base.origin ||
    url.pathname !== "/secrets" ||
    url.username ||
    url.password ||
    url.hash
  )
    return invalid(
      "Azure pagination must stay in this vault's secrets collection.",
    );
  paginationParameters(url);
  return url;
}
function paginationParameters(url: URL): void {
  const allowed = new Set(["api-version", "maxresults", "$skiptoken"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
      invalid("Azure returned unsupported pagination parameters.");
  }
  const apiVersion = url.searchParams.get("api-version");
  // Azure's own nextLink samples use the stable 7.2 service version, while
  // current vaults advertise 2025-07-01. Both name the same collection.
  if (
    (apiVersion !== AZURE_API_VERSION && apiVersion !== "7.2") ||
    !url.searchParams.get("$skiptoken")
  )
    invalid("Azure returned a mismatched pagination contract.");
  const count = url.searchParams.get("maxresults");
  if (count !== null && !/^(?:[1-9]|1[0-9]|2[0-5])$/.test(count))
    invalid("Azure returned an invalid page size.");
}
function nativeFields(input: SecretBackendItemInput): void {
  if (
    input.kind !== "secret" ||
    input.notes ||
    input.username ||
    input.url ||
    Object.keys(input.fields ?? {}).length
  )
    throw new SecretBackendError(
      "unsupported",
      "Azure Key Vault stores native secret values; use the secret item type.",
    );
}
export function azureSecretWrite(
  input: SecretBackendItemInput,
  previous?: AzureSecretBundle,
) {
  nativeFields(input);
  azureSecretName(input.name);
  if (new TextEncoder().encode(input.secret).byteLength > AZURE_SECRET_BYTES)
    throw new SecretBackendError(
      "configuration",
      "Azure secret values must fit within 25 KiB UTF-8.",
    );
  if (previous?.managed)
    throw new SecretBackendError(
      "unsupported",
      "Certificate-managed Azure secrets must be changed through their certificate owner.",
    );
  const held = previous?.attributes;
  const result: AzureSecretWrite = { value: input.secret };
  if (previous?.contentType !== undefined)
    result.contentType = previous.contentType;
  if (previous?.tags !== undefined) result.tags = previous.tags;
  if (held) {
    const writable: AzureSecretWrite["attributes"] = {};
    if (held.enabled !== undefined) writable.enabled = held.enabled;
    if (held.nbf !== undefined) writable.nbf = held.nbf;
    if (held.exp !== undefined) writable.exp = held.exp;
    result.attributes = writable;
  }
  return result;
}
export function azureDeleteAllowed(value: AzureSecretBundle): void {
  if (
    value.managed ||
    !value.attributes?.recoveryLevel?.includes("Recoverable")
  )
    throw new SecretBackendError(
      "unsupported",
      "Deletion requires a recoverable, independently managed Azure secret. It deletes the whole secret and every version.",
    );
}

export type AzureSecretWrite = {
  value: string;
  contentType?: string;
  tags?: Record<string, string>;
  attributes?: { enabled?: boolean; nbf?: number; exp?: number };
};
const deleted = metadata.extend({
  recoveryId: z.string(),
  deletedDate: timestamp,
  scheduledPurgeDate: timestamp,
});
export function azureDeletedSecret(
  value: BoundaryValue,
  base: URL,
  expected: AzureSecretReference,
): void {
  const parsed = deleted.safeParse(value);
  if (!parsed.success)
    invalid("Azure returned an invalid deleted-secret response.");
  const actual = azureSecretReference(parsed.data.id, base);
  if (
    !actual.version ||
    actual.id !== expected.id ||
    parsed.data.recoveryId !== `${base.origin}/deletedsecrets/${expected.name}`
  )
    invalid("Azure returned another deleted secret.");
}
