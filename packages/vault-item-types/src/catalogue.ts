/**
 * The closed field-type catalogue (ADR 0087 §2).
 *
 * A definition names a field type; it never describes one. That indirection —
 * Keeper's `$ref`, restated — is what keeps a definition inert: a manifest
 * that can only name behaviours cannot introduce one. Adding an entry here is
 * a platform change reviewed like any other; adding an *item type* is not.
 *
 * Every value in the vault is text, because the base native secret
 * (`sealed_store::Entry`) is text and every type projects onto it (§3). A
 * record-shaped field is a fixed set of named text parts, not an open object.
 */

export type FieldValueKind = "scalar" | "record";

export type FieldPart = {
  readonly id: string;
  readonly label: string;
  /** A concealed part makes the whole field concealed for the preview rule. */
  readonly concealed: boolean;
};

export type FieldTypeSpec = {
  readonly id: FieldTypeId;
  readonly valueKind: FieldValueKind;
  /**
   * True when the value must never render without a reveal gesture. Drives
   * §5's refusal of concealed fields in `subtitle`, `search`, and defaults.
   */
  readonly concealed: boolean;
  /** Renders as a text area rather than a single line. */
  readonly multiline: boolean;
  /** Present only on record shapes; the complete, ordered part list. */
  readonly parts: readonly FieldPart[];
};

export type FieldTypeId =
  | "string"
  | "multiline"
  | "email"
  | "url"
  | "number"
  | "boolean"
  | "date"
  | "month-year"
  | "country"
  | "select"
  | "phone"
  | "concealed"
  | "password"
  | "pin"
  | "key-material"
  | "totp"
  | "address"
  | "person-name"
  | "host-port"
  | "security-question"
  | "payment-card"
  | "key-pair";

function scalar(
  id: FieldTypeId,
  concealed = false,
  multiline = false,
): FieldTypeSpec {
  return { id, valueKind: "scalar", concealed, multiline, parts: [] };
}

function record(id: FieldTypeId, parts: readonly FieldPart[]): FieldTypeSpec {
  return {
    id,
    valueKind: "record",
    concealed: parts.some((part) => part.concealed),
    multiline: false,
    parts,
  };
}

function part(id: string, label: string, concealed = false): FieldPart {
  return { id, label, concealed };
}

export const FIELD_TYPES = {
  string: scalar("string"),
  multiline: scalar("multiline", false, true),
  email: scalar("email"),
  url: scalar("url"),
  number: scalar("number"),
  boolean: scalar("boolean"),
  date: scalar("date"),
  "month-year": scalar("month-year"),
  country: scalar("country"),
  select: scalar("select"),
  phone: scalar("phone"),
  concealed: scalar("concealed", true),
  password: scalar("password", true),
  pin: scalar("pin", true),
  "key-material": scalar("key-material", true, true),
  totp: scalar("totp", true),
  address: record("address", [
    part("street1", "Street"),
    part("street2", "Street 2"),
    part("city", "City"),
    part("state", "State or province"),
    part("postalCode", "Postal code"),
    part("country", "Country"),
  ]),
  "person-name": record("person-name", [
    part("first", "First"),
    part("middle", "Middle"),
    part("last", "Last"),
  ]),
  "host-port": record("host-port", [
    part("host", "Host"),
    part("port", "Port"),
  ]),
  "security-question": record("security-question", [
    part("question", "Question"),
    part("answer", "Answer", true),
  ]),
  "payment-card": record("payment-card", [
    part("number", "Number", true),
    part("expiry", "Expires"),
    part("code", "Security code", true),
  ]),
  "key-pair": record("key-pair", [
    part("publicKey", "Public key"),
    part("privateKey", "Private key", true),
  ]),
} satisfies Readonly<Record<FieldTypeId, FieldTypeSpec>>;

/** Written out rather than derived so the union and the table cannot drift
    apart silently; a test holds this list against `FIELD_TYPES`. */
export const FIELD_TYPE_IDS: readonly FieldTypeId[] = [
  "string",
  "multiline",
  "email",
  "url",
  "number",
  "boolean",
  "date",
  "month-year",
  "country",
  "select",
  "phone",
  "concealed",
  "password",
  "pin",
  "key-material",
  "totp",
  "address",
  "person-name",
  "host-port",
  "security-question",
  "payment-card",
  "key-pair",
];

export function isFieldTypeId(value: string): value is FieldTypeId {
  return FIELD_TYPE_IDS.some((candidate) => candidate === value);
}

export function fieldTypeSpec(id: FieldTypeId): FieldTypeSpec {
  return FIELD_TYPES[id];
}

/** True when a value of this field type must never render un-revealed. */
export function isConcealedFieldType(id: FieldTypeId): boolean {
  return FIELD_TYPES[id].concealed;
}
