import {
  type JsonObject,
  type JsonValue,
  overlapCast,
  readJsonObject,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { FIELD_TYPES, FIELD_TYPE_IDS } from "./catalogue.js";
import { PLATFORM_PUBLISHER } from "./schema.js";
import { type DefinitionErrorCode, parseDefinition } from "./validate.js";

/**
 * The rejection table. Every rule ADR 0087 §5 states has a row here, and
 * `crates/vault-item-types` carries the same table so a definition valid on
 * one plane is valid on the other.
 */

const BASE_TEXT = JSON.stringify({
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: "example-type",
    version: "1.0.0",
    publisher: "https://example.test",
  },
  spec: {
    title: "Example",
    plural: "Examples",
    extension: ".ex",
    summary: "An example type used by the rejection table.",
    categories: ["other"],
    sections: [
      {
        id: "main",
        title: "Main",
        fields: [
          { id: "label", type: "string", label: "Label" },
          { id: "token", type: "concealed", label: "Token" },
        ],
      },
    ],
    native: { secret: "token", trailer: [{ key: "label", field: "label" }] },
    cxf: { credential: "custom-fields" },
    subtitle: ["label"],
    search: ["label"],
  },
});

function base(): JsonObject {
  return overlapCast(JSON.parse(BASE_TEXT));
}

function object(value: JsonValue | undefined, what: string): JsonObject {
  const found = readJsonObject(value);
  if (found === undefined) throw new Error(`${what} is not an object`);
  return found;
}

function spec(draft: JsonObject): JsonObject {
  return object(draft.spec, "spec");
}

function metadata(draft: JsonObject): JsonObject {
  return object(draft.metadata, "metadata");
}

/** The nth field of the first section, for the field-level rows below. */
function fieldAt(draft: JsonObject, index: number): JsonObject {
  const sections = spec(draft).sections;
  const first = object(
    Array.isArray(sections) ? sections[0] : undefined,
    "section",
  );
  const fields = first.fields;
  return object(Array.isArray(fields) ? fields[index] : undefined, "field");
}

type Parsed = ReturnType<typeof parseDefinition>;

/** Apply a mutation to a fresh draft and parse it as a community install. */
function parseWith(mutate: (draft: JsonObject) => void): Parsed {
  const draft = base();
  mutate(draft);
  return parseDefinition(JSON.stringify(draft), "community");
}

function codes(result: Parsed): DefinitionErrorCode[] {
  return result.ok ? [] : result.errors.map((error) => error.code);
}

describe("parseDefinition", () => {
  it("accepts a minimal community definition", () => {
    const result = parseWith(() => undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.metadata.id).toBe("example-type");
    expect(result.definition.spec.native.secret).toBe("token");
  });

  it("refuses a document larger than the cap", () => {
    const draft = base();
    spec(draft).summary = "x".repeat(80 * 1024);
    const result = parseDefinition(JSON.stringify(draft), "community");
    expect(codes(result)).toContain("too-large");
  });

  it("refuses malformed JSON", () => {
    expect(codes(parseDefinition("{", "community"))).toEqual(["syntax"]);
  });

  it("refuses an unknown top-level field", () => {
    const result = parseWith((draft) => {
      draft.componentUrl = "https://example.test/x.wasm";
    });
    expect(codes(result)).toContain("unknown-field");
  });

  it("refuses an unknown field-level key", () => {
    const result = parseWith((draft) => {
      fieldAt(draft, 0).pattern = "^.*$";
    });
    expect(codes(result)).toContain("unknown-field");
  });

  it("refuses a foreign apiVersion or kind", () => {
    const version = parseWith((draft) => {
      draft.apiVersion = "v2";
    });
    expect(codes(version)).toContain("api-version");
    const kind = parseWith((draft) => {
      draft.kind = "ConnectorDefinition";
    });
    expect(codes(kind)).toContain("kind");
  });

  it("refuses a type id that is not a slug", () => {
    const result = parseWith((draft) => {
      metadata(draft).id = "Bank Account";
    });
    expect(codes(result)).toContain("id");
  });

  it("refuses a publisher that is not https", () => {
    const result = parseWith((draft) => {
      metadata(draft).publisher = "http://example.test";
    });
    expect(codes(result)).toContain("publisher");
  });

  it("refuses a field type outside the catalogue", () => {
    const result = parseWith((draft) => {
      fieldAt(draft, 0).type = "rich-text";
    });
    expect(codes(result)).toContain("field-type");
  });

  it("refuses duplicate field ids across sections", () => {
    const result = parseWith((draft) => {
      spec(draft).sections = [
        {
          id: "one",
          title: "One",
          fields: [{ id: "label", type: "string", label: "A" }],
        },
        {
          id: "two",
          title: "Two",
          fields: [{ id: "label", type: "string", label: "B" }],
        },
      ];
      spec(draft).native = { secret: null, trailer: [] };
    });
    expect(codes(result)).toContain("duplicate-field");
  });

  it("refuses a default on a concealed field", () => {
    const result = parseWith((draft) => {
      fieldAt(draft, 1).default = "hunter2";
    });
    expect(codes(result)).toContain("concealed-default");
  });

  it("allows a default on a field that is not concealed", () => {
    const result = parseWith((draft) => {
      fieldAt(draft, 0).default = "Untitled";
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a concealed field in the subtitle", () => {
    const result = parseWith((draft) => {
      spec(draft).subtitle = ["token"];
    });
    expect(codes(result)).toContain("concealed-preview");
  });

  it("refuses a concealed field in the search haystack", () => {
    const result = parseWith((draft) => {
      spec(draft).search = ["token"];
    });
    expect(codes(result)).toContain("concealed-preview");
  });

  it("refuses a preview naming a field that does not exist", () => {
    const result = parseWith((draft) => {
      spec(draft).subtitle = ["nope"];
    });
    expect(codes(result)).toContain("concealed-preview");
  });

  it("refuses a native secret that is not a declared field", () => {
    const result = parseWith((draft) => {
      spec(draft).native = { secret: "missing", trailer: [] };
    });
    expect(codes(result)).toContain("native-secret");
  });

  it("refuses a record-shaped field as the native secret", () => {
    const result = parseWith((draft) => {
      spec(draft).sections = [
        {
          id: "main",
          title: "Main",
          fields: [{ id: "who", type: "person-name", label: "Name" }],
        },
      ];
      spec(draft).native = { secret: "who", trailer: [] };
      spec(draft).subtitle = [];
      spec(draft).search = [];
    });
    expect(codes(result)).toContain("native-secret");
  });

  it("refuses a repeating field as the native secret", () => {
    const result = parseWith((draft) => {
      spec(draft).sections = [
        {
          id: "main",
          title: "Main",
          fields: [
            { id: "keys", type: "concealed", label: "Key", multiple: true },
          ],
        },
      ];
      spec(draft).native = { secret: "keys", trailer: [] };
      spec(draft).subtitle = [];
      spec(draft).search = [];
    });
    expect(codes(result)).toContain("native-secret");
  });

  it("refuses the secret field repeated in the trailer", () => {
    const result = parseWith((draft) => {
      spec(draft).native = {
        secret: "token",
        trailer: [{ key: "token", field: "token" }],
      };
    });
    expect(codes(result)).toContain("trailer");
  });

  it("refuses duplicate trailer keys", () => {
    const result = parseWith((draft) => {
      spec(draft).native = {
        secret: "token",
        trailer: [
          { key: "label", field: "label" },
          { key: "label", field: "label" },
        ],
      };
    });
    expect(codes(result)).toContain("trailer");
  });

  it("refuses a select with no options and options on anything else", () => {
    expect(
      codes(
        parseWith((draft) => {
          fieldAt(draft, 0).type = "select";
        }),
      ),
    ).toContain("options");
    expect(
      codes(
        parseWith((draft) => {
          fieldAt(draft, 0).options = ["a", "b"];
        }),
      ),
    ).toContain("options");
  });

  it("refuses a repeating record-shaped field", () => {
    const result = parseWith((draft) => {
      spec(draft).sections = [
        {
          id: "main",
          title: "Main",
          fields: [
            { id: "who", type: "person-name", label: "Name", multiple: true },
            { id: "label", type: "string", label: "Label" },
          ],
        },
      ];
    });
    expect(codes(result)).toContain("multiple");
  });

  it("refuses a CXF mapping outside the credential list", () => {
    const result = parseWith((draft) => {
      spec(draft).cxf = { credential: "bank-account" };
    });
    expect(codes(result)).toContain("cxf");
  });

  it("refuses a community definition that names a ceremony handler", () => {
    const result = parseWith((draft) => {
      spec(draft).handler = "certificate";
    });
    expect(codes(result)).toContain("handler");
  });

  it("refuses a platform handler claimed by a community publisher", () => {
    const draft = base();
    spec(draft).handler = "certificate";
    const result = parseDefinition(JSON.stringify(draft), "platform");
    expect(codes(result)).toContain("handler");
  });

  it("accepts a handler on a platform-published definition", () => {
    const draft = base();
    metadata(draft).publisher = PLATFORM_PUBLISHER;
    spec(draft).handler = "certificate";
    const result = parseDefinition(JSON.stringify(draft), "platform");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.spec.handler).toBe("certificate");
  });

  it("refuses an unknown handler even from the platform", () => {
    const draft = base();
    metadata(draft).publisher = PLATFORM_PUBLISHER;
    spec(draft).handler = "exfiltrate";
    expect(codes(parseDefinition(JSON.stringify(draft), "platform"))).toContain(
      "handler",
    );
  });

  it("refuses a section id longer than the cap", () => {
    const result = parseWith((draft) => {
      const sections = spec(draft).sections;
      const first = object(
        Array.isArray(sections) ? sections[0] : undefined,
        "section",
      );
      first.id = "s".repeat(64);
    });
    expect(codes(result)).toContain("sections");
  });

  it("refuses an extension that is not a short leading-dot slug", () => {
    const noDot = parseWith((draft) => {
      spec(draft).extension = "bank";
    });
    expect(codes(noDot)).toContain("extension");
    const traversal = parseWith((draft) => {
      spec(draft).extension = "./etc/passwd";
    });
    expect(codes(traversal)).toContain("extension");
  });

  it("has no schema field that could carry a URL a loader would fetch", () => {
    const result = parseWith(() => undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialised = JSON.stringify(result.definition);
    for (const smell of [
      "component",
      "oci",
      "src",
      "href",
      "endpoint",
      "script",
    ]) {
      expect(serialised).not.toContain(`"${smell}"`);
    }
  });
});

describe("the field-type catalogue", () => {
  it("lists exactly the entries in the table", () => {
    expect([...FIELD_TYPE_IDS].sort()).toEqual(Object.keys(FIELD_TYPES).sort());
  });

  it("marks a record field concealed when any part is", () => {
    expect(FIELD_TYPES["key-pair"].concealed).toBe(true);
    expect(FIELD_TYPES["security-question"].concealed).toBe(true);
    expect(FIELD_TYPES["person-name"].concealed).toBe(false);
  });

  it("gives every record shape at least one part and every scalar none", () => {
    for (const id of FIELD_TYPE_IDS) {
      const entry = FIELD_TYPES[id];
      if (entry.valueKind === "record")
        expect(entry.parts.length).toBeGreaterThan(0);
      else expect(entry.parts).toEqual([]);
    }
  });
});
