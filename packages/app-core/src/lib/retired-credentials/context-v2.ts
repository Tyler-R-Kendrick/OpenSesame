/** Inactive public metadata protocol. A context is never an owner/authentication proof. */
import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { z } from "zod";
import {
  MAX_RETIRED_CONTEXT_HEADER_BYTES,
  readPagesRetiredCredentialHeader,
} from "./context-v2-header.js";
export { MAX_RETIRED_CONTEXT_HEADER_BYTES } from "./context-v2-header.js";

export const MAX_RETIRED_CONTEXT_WIRE_BYTES = 2048;
export const RETIRED_CREDENTIAL_CONTEXT_FORMAT = "pages-auth-header-v1";
const DOMAIN = "opensesame/retired-credential/context-header/v2\0";
const utf8 = new TextEncoder();
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (s) =>
        !/[\uD800-\uDFFF]/u.test(s) &&
        utf8.encode(s).length <= max &&
        !hasControlCharacters(s),
    );
const id = text(256);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const contextSchema = z.strictObject({
  v: z.literal(2),
  format: z.literal(RETIRED_CREDENTIAL_CONTEXT_FORMAT),
  tomb: text(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  purpose: z.literal("human-vault-root"),
  vaultId: id,
  rootKeyId: id,
  rootEpoch: integer,
  generationSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RetiredCredentialContextV2 = Readonly<
  z.infer<typeof contextSchema>
>;

/** Sorted JSON keys; array order retained, no whitespace; inputs have passed strict schemas. */
function canonical(value: BoundaryValue): string {
  if (
    value === null ||
    isString(value) ||
    isBoolean(value) ||
    isNumber(value)
  ) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) unavailable();
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isJsonObject(value)) throw new Error("Unsupported context metadata");
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
function unavailable(): never {
  throw new Error("Retired credential context is unavailable.");
}
/** Metadata only. Caller must first authenticate MAC/body/full factors and retain original-operation guards. */
export async function deriveRetiredCredentialContextV2(
  tomb: string,
  publicHeaderJson: BoundaryValue,
): Promise<RetiredCredentialContextV2> {
  try {
    if (!isString(publicHeaderJson)) unavailable();
    const header = readPagesRetiredCredentialHeader(publicHeaderJson); // Snapshot before any await.
    const { bodyRev: _bodyRev, ...generation } = header;
    const bytes = utf8.encode(canonical(generation));
    if (bytes.length > MAX_RETIRED_CONTEXT_HEADER_BYTES) unavailable();
    const bound = contextSchema.omit({ generationSha256: true }).parse({
      v: 2,
      format: RETIRED_CREDENTIAL_CONTEXT_FORMAT,
      tomb,
      purpose: header.protection.purpose,
      vaultId: header.protection.vaultId,
      rootKeyId: header.protection.rootKeyId,
      rootEpoch: header.protection.rootEpoch,
    });
    const prefix = utf8.encode(
      `${DOMAIN}${RETIRED_CREDENTIAL_CONTEXT_FORMAT}\0`,
    );
    const input = new Uint8Array(prefix.length + bytes.length);
    input.set(prefix);
    input.set(bytes, prefix.length);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    return Object.freeze({
      ...bound,
      generationSha256: Array.from(digest, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    });
  } catch {
    return unavailable();
  }
}
export function encodeRetiredCredentialContextV2(
  context: BoundaryValue,
): string {
  try {
    const raw = canonical(contextSchema.parse(context));
    if (utf8.encode(raw).length > MAX_RETIRED_CONTEXT_WIRE_BYTES) unavailable();
    return raw;
  } catch {
    return unavailable();
  }
}
/** Canonical-only wire: duplicate keys, reordered keys and alternate escapes/number spellings are refused. */
export function parseRetiredCredentialContextV2(
  raw: string,
): RetiredCredentialContextV2 {
  try {
    if (!isString(raw)) unavailable();
    if (
      raw.length > MAX_RETIRED_CONTEXT_WIRE_BYTES ||
      utf8.encode(raw).length > MAX_RETIRED_CONTEXT_WIRE_BYTES
    )
      unavailable();
    const context = contextSchema.parse(JSON.parse(raw));
    if (raw !== encodeRetiredCredentialContextV2(context)) unavailable();
    return Object.freeze(context);
  } catch {
    return unavailable();
  }
}
