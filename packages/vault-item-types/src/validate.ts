/**
 * The one parser for a `VaultItemType` manifest (ADR 0087 §5).
 *
 * Everything here is refusal. A definition that reaches a registry has been
 * proven to name only catalogue field types, to carry no value on a concealed
 * field, to keep concealed fields out of every surface that renders without a
 * reveal gesture, and to name a handler only when the platform published it.
 * `crates/vault-item-types` implements the same table; the two are held
 * together by the shared fixture corpus.
 *
 * Unknown keys are refused rather than ignored, at every level. The lesson is
 * ADR 0065 §4's: an author must not be able to smuggle in a field this parser
 * silently drops today and some later consumer honours.
 */

import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { FIELD_TYPES, isFieldTypeId } from "./catalogue.js";
import {
  CXF_CREDENTIAL_IDS,
  type CxfCredentialId,
  DEFINITION_API_VERSION,
  DEFINITION_KIND,
  type FieldDefinition,
  HANDLER_IDS,
  type ItemTypeDefinition,
  MAX_DEFINITION_BYTES,
  MAX_FIELDS,
  MAX_LABEL_CHARS,
  MAX_OPTIONS,
  MAX_SECTIONS,
  PLATFORM_PUBLISHER,
  type SectionDefinition,
  type TrailerMapping,
} from "./schema.js";

export type DefinitionErrorCode =
  | "too-large"
  | "syntax"
  | "unknown-field"
  | "api-version"
  | "kind"
  | "id"
  | "version"
  | "publisher"
  | "text"
  | "extension"
  | "sections"
  | "field-id"
  | "field-type"
  | "duplicate-field"
  | "options"
  | "multiple"
  | "concealed-default"
  | "native-secret"
  | "trailer"
  | "cxf"
  | "concealed-preview"
  | "handler";

export type DefinitionError = {
  readonly code: DefinitionErrorCode;
  /** Dotted path into the manifest, e.g. `spec.sections[0].fields[2].type`. */
  readonly path: string;
  readonly message: string;
};

export type ParsedDefinition =
  | { readonly ok: true; readonly definition: ItemTypeDefinition }
  | { readonly ok: false; readonly errors: readonly DefinitionError[] };

/**
 * Whether the caller is loading the platform's own embedded corpus or an
 * install from anywhere else. Only the former may name a ceremony handler.
 */
export type DefinitionTrust = "platform" | "community";

const TYPE_ID = /^[a-z][a-z0-9-]{1,47}$/;
const FIELD_ID = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
const SECTION_ID = /^[a-z][a-z0-9-]{0,47}$/;
const TRAILER_KEY = /^[a-z][a-z0-9_-]{0,31}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const EXTENSION = /^\.[a-z0-9]{1,12}$/;
const CATEGORY = /^[a-z][a-z0-9-]{0,31}$/;

const TOP_LEVEL_KEYS = ["apiVersion", "kind", "metadata", "spec"];
const METADATA_KEYS = ["id", "version", "publisher"];
const SPEC_KEYS = [
  "title",
  "plural",
  "extension",
  "summary",
  "categories",
  "sections",
  "native",
  "cxf",
  "subtitle",
  "search",
  "handler",
];
const SECTION_KEYS = ["id", "title", "fields"];
const FIELD_KEYS = [
  "id",
  "type",
  "label",
  "help",
  "required",
  "placeholder",
  "options",
  "multiple",
  "default",
];
const NATIVE_KEYS = ["secret", "trailer"];
const TRAILER_KEYS = ["key", "field"];
const CXF_KEYS = ["credential"];

class Refusals {
  readonly errors: DefinitionError[] = [];

  add(code: DefinitionErrorCode, path: string, message: string): void {
    this.errors.push({ code, path, message });
  }

  get failed(): boolean {
    return this.errors.length > 0;
  }
}

function jsonArray(value: JsonValue | undefined): readonly JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

function checkKeys(
  refusals: Refusals,
  object: JsonObject,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      refusals.add(
        "unknown-field",
        `${path}.${key}`,
        `unknown field \`${key}\``,
      );
    }
  }
}

function requireText(
  refusals: Refusals,
  value: JsonValue | undefined,
  path: string,
  max = MAX_LABEL_CHARS,
): string {
  if (!isString(value) || value.trim().length === 0) {
    refusals.add("text", path, `${path} must be a non-empty string`);
    return "";
  }
  // Code points, not UTF-16 units: `crates/vault-item-types` counts
  // `chars()`, and a definition must not be valid on one plane and refused on
  // the other because its label happened to contain an astral character.
  const points = [...value];
  if (points.length > max) {
    refusals.add("text", path, `${path} exceeds ${max} characters`);
    return points.slice(0, max).join("");
  }
  return value;
}

function optionalText(
  refusals: Refusals,
  value: JsonValue | undefined,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requireText(refusals, value, path);
}

function optionalFlag(
  refusals: Refusals,
  value: JsonValue | undefined,
  path: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (!isBoolean(value)) {
    refusals.add("text", path, `${path} must be true or false`);
    return undefined;
  }
  return value;
}

function stringList(
  refusals: Refusals,
  value: JsonValue | undefined,
  path: string,
  code: DefinitionErrorCode,
): readonly string[] {
  const raw = jsonArray(value);
  if (raw === null) {
    refusals.add(code, path, `${path} must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  raw.forEach((entry, index) => {
    if (!isString(entry)) {
      refusals.add(code, `${path}[${index}]`, "must be a string");
      return;
    }
    out.push(entry);
  });
  return out;
}

function parseField(
  refusals: Refusals,
  raw: JsonValue,
  path: string,
): FieldDefinition | null {
  if (!isJsonObject(raw)) {
    refusals.add("field-id", path, "field must be an object");
    return null;
  }
  checkKeys(refusals, raw, FIELD_KEYS, path);

  const id = requireText(refusals, raw.id, `${path}.id`);
  if (id !== "" && !FIELD_ID.test(id)) {
    refusals.add(
      "field-id",
      `${path}.id`,
      `field id \`${id}\` is not an identifier`,
    );
  }

  const typeName = requireText(refusals, raw.type, `${path}.type`);
  if (typeName !== "" && !isFieldTypeId(typeName)) {
    refusals.add(
      "field-type",
      `${path}.type`,
      `\`${typeName}\` is not a catalogue field type`,
    );
    return null;
  }
  if (!isFieldTypeId(typeName)) return null;
  const spec = FIELD_TYPES[typeName];

  const label = requireText(refusals, raw.label, `${path}.label`);
  const help = optionalText(refusals, raw.help, `${path}.help`);
  const placeholder = optionalText(
    refusals,
    raw.placeholder,
    `${path}.placeholder`,
  );
  const required = optionalFlag(refusals, raw.required, `${path}.required`);
  const multiple = optionalFlag(refusals, raw.multiple, `${path}.multiple`);

  if (multiple === true && spec.valueKind === "record") {
    refusals.add(
      "multiple",
      `${path}.multiple`,
      "record-shaped fields cannot repeat",
    );
  }

  let options: readonly string[] | undefined;
  if (raw.options !== undefined) {
    if (typeName !== "select") {
      refusals.add("options", `${path}.options`, "only `select` takes options");
    }
    const values = stringList(
      refusals,
      raw.options,
      `${path}.options`,
      "options",
    );
    if (values.length === 0 || values.length > MAX_OPTIONS) {
      refusals.add(
        "options",
        `${path}.options`,
        `between 1 and ${MAX_OPTIONS} options`,
      );
    }
    if (new Set(values).size !== values.length) {
      refusals.add("options", `${path}.options`, "options must be unique");
    }
    options = values;
  } else if (typeName === "select") {
    refusals.add("options", `${path}.options`, "`select` requires options");
  }

  // A definition is shared and synced. A default on a concealed field would
  // put a secret into the shared artefact, so the schema refuses it outright
  // rather than stripping it (ADR 0087 §5).
  let fallback: string | undefined;
  if (raw.default !== undefined) {
    if (spec.concealed) {
      refusals.add(
        "concealed-default",
        `${path}.default`,
        `\`${typeName}\` is concealed and cannot carry a default`,
      );
    } else {
      fallback = requireText(refusals, raw.default, `${path}.default`);
    }
  }

  return {
    id,
    type: typeName,
    label,
    ...(help !== undefined ? { help } : undefined),
    ...(placeholder !== undefined ? { placeholder } : undefined),
    ...(required !== undefined ? { required } : undefined),
    ...(multiple !== undefined ? { multiple } : undefined),
    ...(options !== undefined ? { options } : undefined),
    ...(fallback !== undefined ? { default: fallback } : undefined),
  };
}

function parseSections(
  refusals: Refusals,
  value: JsonValue | undefined,
): readonly SectionDefinition[] {
  const raw = jsonArray(value);
  if (raw === null || raw.length === 0 || raw.length > MAX_SECTIONS) {
    refusals.add(
      "sections",
      "spec.sections",
      `between 1 and ${MAX_SECTIONS} sections`,
    );
    return [];
  }
  const sections: SectionDefinition[] = [];
  const seenSections = new Set<string>();
  let fieldCount = 0;
  raw.forEach((entry, index) => {
    const path = `spec.sections[${index}]`;
    if (!isJsonObject(entry)) {
      refusals.add("sections", path, "section must be an object");
      return;
    }
    checkKeys(refusals, entry, SECTION_KEYS, path);
    const id = requireText(refusals, entry.id, `${path}.id`);
    if (id !== "" && !SECTION_ID.test(id)) {
      refusals.add(
        "sections",
        `${path}.id`,
        `section id \`${id}\` is not a slug`,
      );
    }
    if (seenSections.has(id)) {
      refusals.add("sections", `${path}.id`, `duplicate section id \`${id}\``);
    }
    seenSections.add(id);
    const title = requireText(refusals, entry.title, `${path}.title`);

    const rawFields = jsonArray(entry.fields);
    if (rawFields === null || rawFields.length === 0) {
      refusals.add("sections", `${path}.fields`, "a section needs a field");
      return;
    }
    const fields: FieldDefinition[] = [];
    rawFields.forEach((rawField, fieldIndex) => {
      fieldCount += 1;
      const field = parseField(
        refusals,
        rawField,
        `${path}.fields[${fieldIndex}]`,
      );
      if (field !== null) fields.push(field);
    });
    sections.push({ id, title, fields });
  });
  if (fieldCount > MAX_FIELDS) {
    refusals.add(
      "sections",
      "spec.sections",
      `a definition may declare at most ${MAX_FIELDS} fields`,
    );
  }
  return sections;
}

function parseTrailer(
  refusals: Refusals,
  value: JsonValue | undefined,
  byId: ReadonlyMap<string, FieldDefinition>,
  secret: string | null,
): readonly TrailerMapping[] {
  const raw = jsonArray(value);
  if (raw === null || raw.length > MAX_FIELDS) {
    refusals.add(
      "trailer",
      "spec.native.trailer",
      `an array of at most ${MAX_FIELDS} mappings`,
    );
    return [];
  }
  const mappings: TrailerMapping[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const path = `spec.native.trailer[${index}]`;
    if (!isJsonObject(entry)) {
      refusals.add("trailer", path, "mapping must be an object");
      return;
    }
    checkKeys(refusals, entry, TRAILER_KEYS, path);
    const key = requireText(refusals, entry.key, `${path}.key`);
    if (key !== "" && !TRAILER_KEY.test(key)) {
      refusals.add(
        "trailer",
        `${path}.key`,
        `trailer key \`${key}\` is not a slug`,
      );
    }
    if (seen.has(key)) {
      refusals.add(
        "trailer",
        `${path}.key`,
        `duplicate trailer key \`${key}\``,
      );
    }
    seen.add(key);
    const field = requireText(refusals, entry.field, `${path}.field`);
    if (field !== "" && !byId.has(field)) {
      refusals.add("trailer", `${path}.field`, `no field \`${field}\``);
    }
    if (field !== "" && field === secret) {
      refusals.add(
        "trailer",
        `${path}.field`,
        "the secret field is line one and cannot repeat in the trailer",
      );
    }
    mappings.push({ key, field });
  });
  return mappings;
}

function parsePreview(
  refusals: Refusals,
  value: JsonValue | undefined,
  byId: ReadonlyMap<string, FieldDefinition>,
  path: string,
): readonly string[] {
  const ids = stringList(refusals, value, path, "concealed-preview");
  for (const id of ids) {
    const field = byId.get(id);
    if (field === undefined) {
      refusals.add("concealed-preview", path, `no field \`${id}\``);
      continue;
    }
    // The item list, the search haystack and the VFS filename all render with
    // no reveal gesture. Filtering silently would leave the author believing
    // it worked (ADR 0087 §5).
    if (FIELD_TYPES[field.type].concealed) {
      refusals.add(
        "concealed-preview",
        path,
        `\`${id}\` is concealed and cannot appear in ${path.split(".").pop() ?? path}`,
      );
    }
  }
  return ids;
}

export function parseDefinition(
  text: string,
  trust: DefinitionTrust,
): ParsedDefinition {
  const refusals = new Refusals();
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_DEFINITION_BYTES) {
    return {
      ok: false,
      errors: [
        {
          code: "too-large",
          path: "",
          message: `definition exceeds ${MAX_DEFINITION_BYTES} bytes`,
        },
      ],
    };
  }

  let decoded: BoundaryValue = null;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      errors: [
        {
          code: "syntax",
          path: "",
          message: cause instanceof Error ? cause.message : "invalid JSON",
        },
      ],
    };
  }
  if (!isJsonObject(decoded)) {
    return {
      ok: false,
      errors: [
        { code: "syntax", path: "", message: "definition must be an object" },
      ],
    };
  }
  const root: JsonObject = decoded;
  checkKeys(refusals, root, TOP_LEVEL_KEYS, "");

  if (root.apiVersion !== DEFINITION_API_VERSION) {
    refusals.add(
      "api-version",
      "apiVersion",
      `unsupported apiVersion; expected \`${DEFINITION_API_VERSION}\``,
    );
  }
  if (root.kind !== DEFINITION_KIND) {
    refusals.add(
      "kind",
      "kind",
      `unsupported kind; expected \`${DEFINITION_KIND}\``,
    );
  }

  const metadata = isJsonObject(root.metadata) ? root.metadata : null;
  if (metadata === null) {
    refusals.add("id", "metadata", "metadata must be an object");
    return { ok: false, errors: refusals.errors };
  }
  checkKeys(refusals, metadata, METADATA_KEYS, "metadata");
  const id = requireText(refusals, metadata.id, "metadata.id");
  if (id !== "" && !TYPE_ID.test(id)) {
    refusals.add(
      "id",
      "metadata.id",
      `type id \`${id}\` is not a lowercase slug`,
    );
  }
  const version = requireText(refusals, metadata.version, "metadata.version");
  if (version !== "" && !SEMVER.test(version)) {
    refusals.add(
      "version",
      "metadata.version",
      "version must be MAJOR.MINOR.PATCH",
    );
  }
  const publisher = requireText(
    refusals,
    metadata.publisher,
    "metadata.publisher",
  );
  if (publisher !== "" && !publisher.startsWith("https://")) {
    refusals.add(
      "publisher",
      "metadata.publisher",
      "publisher must be an https URL",
    );
  }

  const spec = isJsonObject(root.spec) ? root.spec : null;
  if (spec === null) {
    refusals.add("sections", "spec", "spec must be an object");
    return { ok: false, errors: refusals.errors };
  }
  checkKeys(refusals, spec, SPEC_KEYS, "spec");

  const title = requireText(refusals, spec.title, "spec.title");
  const plural = requireText(refusals, spec.plural, "spec.plural");
  const summary = requireText(refusals, spec.summary, "spec.summary", 400);
  const extension = requireText(refusals, spec.extension, "spec.extension");
  if (extension !== "" && !EXTENSION.test(extension)) {
    refusals.add(
      "extension",
      "spec.extension",
      "extension must be a leading dot and up to 12 lowercase characters",
    );
  }
  const categories = stringList(
    refusals,
    spec.categories,
    "spec.categories",
    "text",
  );
  for (const category of categories) {
    if (!CATEGORY.test(category)) {
      refusals.add("text", "spec.categories", `\`${category}\` is not a slug`);
    }
  }

  const sections = parseSections(refusals, spec.sections);
  const byId = new Map<string, FieldDefinition>();
  for (const section of sections) {
    for (const field of section.fields) {
      if (byId.has(field.id)) {
        refusals.add(
          "duplicate-field",
          `spec.sections.${section.id}.${field.id}`,
          `duplicate field id \`${field.id}\``,
        );
      }
      byId.set(field.id, field);
    }
  }

  const native = isJsonObject(spec.native) ? spec.native : null;
  let secret: string | null = null;
  let trailer: readonly TrailerMapping[] = [];
  if (native === null) {
    refusals.add(
      "native-secret",
      "spec.native",
      "native projection is required",
    );
  } else {
    checkKeys(refusals, native, NATIVE_KEYS, "spec.native");
    if (native.secret === null || native.secret === undefined) {
      secret = null;
    } else if (!isString(native.secret)) {
      refusals.add(
        "native-secret",
        "spec.native.secret",
        "must be a field id or null",
      );
    } else {
      secret = native.secret;
      const field = byId.get(secret);
      if (field === undefined) {
        refusals.add(
          "native-secret",
          "spec.native.secret",
          `no field \`${secret}\``,
        );
      } else if (FIELD_TYPES[field.type].valueKind === "record") {
        refusals.add(
          "native-secret",
          "spec.native.secret",
          "line one holds one value; a record-shaped field cannot be the secret",
        );
      } else if (field.multiple === true) {
        refusals.add(
          "native-secret",
          "spec.native.secret",
          "line one holds one value; a repeating field cannot be the secret",
        );
      }
    }
    trailer = parseTrailer(refusals, native.trailer, byId, secret);
  }

  const cxf = isJsonObject(spec.cxf) ? spec.cxf : null;
  let credential: CxfCredentialId = "custom-fields";
  if (cxf === null) {
    refusals.add("cxf", "spec.cxf", "a CXF mapping is required");
  } else {
    checkKeys(refusals, cxf, CXF_KEYS, "spec.cxf");
    const named = CXF_CREDENTIAL_IDS.find(
      (candidate) => candidate === cxf.credential,
    );
    if (named === undefined) {
      refusals.add(
        "cxf",
        "spec.cxf.credential",
        "must name a CXF credential type; `custom-fields` is the floor",
      );
    } else {
      credential = named;
    }
  }

  const subtitle = parsePreview(refusals, spec.subtitle, byId, "spec.subtitle");
  const search = parsePreview(refusals, spec.search, byId, "spec.search");

  let handler: (typeof HANDLER_IDS)[number] | undefined;
  if (spec.handler !== undefined) {
    const named = HANDLER_IDS.find((candidate) => candidate === spec.handler);
    if (trust !== "platform" || publisher !== PLATFORM_PUBLISHER) {
      refusals.add(
        "handler",
        "spec.handler",
        "only a platform-published definition may name a ceremony handler",
      );
    } else if (named === undefined) {
      refusals.add("handler", "spec.handler", "unknown ceremony handler");
    } else {
      handler = named;
    }
  }

  if (refusals.failed) return { ok: false, errors: refusals.errors };

  const definition: ItemTypeDefinition = {
    apiVersion: DEFINITION_API_VERSION,
    kind: DEFINITION_KIND,
    metadata: { id, version, publisher },
    spec: {
      title,
      plural,
      extension,
      summary,
      categories,
      sections,
      native: { secret, trailer },
      cxf: { credential },
      subtitle,
      search,
      ...(handler !== undefined ? { handler } : undefined),
    },
  };
  return { ok: true, definition };
}

/** Parse a definition already held as a JSON value (the embedded corpus). */
export function parseDefinitionValue(
  value: JsonValue,
  trust: DefinitionTrust,
): ParsedDefinition {
  return parseDefinition(JSON.stringify(value), trust);
}

/** One line per refusal, for a message a definition author can act on. */
export function describeErrors(errors: readonly DefinitionError[]): string {
  return errors
    .map((error) =>
      error.path === "" ? error.message : `${error.path}: ${error.message}`,
    )
    .join("\n");
}

/** Round-trip a parsed definition back to the canonical wire shape. */
export function definitionToJson(definition: ItemTypeDefinition): JsonObject {
  return overlapCast(JSON.parse(JSON.stringify(definition)));
}
