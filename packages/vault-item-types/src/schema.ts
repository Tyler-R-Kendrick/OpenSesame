/**
 * The `VaultItemType` manifest (ADR 0087 §1).
 *
 * A definition is inert data: it names field types from the closed catalogue,
 * declares how the type projects onto the base native secret, and says which
 * of its fields are safe to render without a reveal gesture. It carries no
 * value, no URL, and no code. Everything a client needs to draw the ceremony
 * and read the item back is here.
 */

import type { FieldTypeId } from "./catalogue.js";

export const DEFINITION_API_VERSION = "opensesame.dev/v1alpha1";
export const DEFINITION_KIND = "VaultItemType";
/** The publisher only builtin definitions may claim (ADR 0087 §5). */
export const PLATFORM_PUBLISHER = "https://opensesame.dev";

export const MAX_DEFINITION_BYTES = 64 * 1024;
export const MAX_SECTIONS = 16;
export const MAX_FIELDS = 64;
export const MAX_OPTIONS = 32;
export const MAX_LABEL_CHARS = 120;

/**
 * Ceremonies the platform implements because they do something no data
 * description can: issue a certificate against the Host API, open a drop
 * claim session, classify passkey custody, bound a later delegation. Only a
 * platform-published definition may name one (ADR 0087 §6).
 */
export const HANDLER_IDS = [
  "login",
  "passkey",
  "secret",
  "certificate",
  "drop",
] as const;

export type HandlerId = (typeof HANDLER_IDS)[number];

/**
 * FIDO CXF credential discriminators a definition may map onto. `custom-fields`
 * is the floor: it is what CXF defines for what the standard did not
 * anticipate, so no community type is unexportable (ADR 0087 §4).
 */
export const CXF_CREDENTIAL_IDS = [
  "basic-auth",
  "passkey",
  "totp",
  "credit-card",
  "note",
  "ssh-key",
  "api-key",
  "wifi",
  "address",
  "person-name",
  "identity-document",
  "drivers-license",
  "passport",
  "file",
  "custom-fields",
] as const;

export type CxfCredentialId = (typeof CXF_CREDENTIAL_IDS)[number];

export type FieldDefinition = {
  readonly id: string;
  readonly type: FieldTypeId;
  readonly label: string;
  readonly help?: string;
  readonly required?: boolean;
  readonly placeholder?: string;
  /** `select` only; the complete closed option list. */
  readonly options?: readonly string[];
  /** Scalar shapes only; the field holds an ordered list of values. */
  readonly multiple?: boolean;
  /** Prefilled in a new item. Refused outright on a concealed field type. */
  readonly default?: string;
};

export type SectionDefinition = {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly FieldDefinition[];
};

export type TrailerMapping = {
  /** The `key:` written into the native entry's trailer. */
  readonly key: string;
  /** The field whose value it carries. */
  readonly field: string;
};

/**
 * How the type projects onto `sealed_store::Entry`: one field becomes line
 * one, the rest become trailer keys. `secret: null` is a type with nothing on
 * line one (a note, an address), which projects to an empty first line.
 */
export type NativeProjection = {
  readonly secret: string | null;
  readonly trailer: readonly TrailerMapping[];
};

export type CxfMapping = {
  readonly credential: CxfCredentialId;
};

export type ItemTypeSpec = {
  readonly title: string;
  readonly plural: string;
  /** VFS filename extension, leading dot (ADR 0064/0073). */
  readonly extension: string;
  readonly summary: string;
  readonly categories: readonly string[];
  readonly sections: readonly SectionDefinition[];
  readonly native: NativeProjection;
  readonly cxf: CxfMapping;
  /** Fields shown in the item list. Never concealed ones (ADR 0087 §5). */
  readonly subtitle: readonly string[];
  /** Fields added to the search haystack. Never concealed ones. */
  readonly search: readonly string[];
  /** Platform-published definitions only. */
  readonly handler?: HandlerId;
};

export type ItemTypeMetadata = {
  readonly id: string;
  readonly version: string;
  readonly publisher: string;
};

export type ItemTypeDefinition = {
  readonly apiVersion: typeof DEFINITION_API_VERSION;
  readonly kind: typeof DEFINITION_KIND;
  readonly metadata: ItemTypeMetadata;
  readonly spec: ItemTypeSpec;
};

/**
 * A field value as stored in the vault body: text, a list of text for a
 * repeating field, or the named parts of a record-shaped one. Text throughout,
 * because the base native secret is text and every type projects onto it.
 */
export type FieldValue = string | string[] | Record<string, string>;

export type FieldValues = Readonly<Record<string, FieldValue>>;

/** Every field of a definition, flattened in section then declaration order. */
export function definitionFields(
  definition: ItemTypeDefinition,
): readonly FieldDefinition[] {
  return definition.spec.sections.flatMap((section) => section.fields);
}

export function findField(
  definition: ItemTypeDefinition,
  fieldId: string,
): FieldDefinition | undefined {
  return definitionFields(definition).find((field) => field.id === fieldId);
}

export function isPlatformPublished(definition: ItemTypeDefinition): boolean {
  return definition.metadata.publisher === PLATFORM_PUBLISHER;
}
