import type {
  BoundaryValue,
  JsonObject,
  JsonValue,
} from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { readOnePasswordSdkItem } from "./onepassword-sdk-codec.js";
import { SecretBackendError } from "./types.js";

const vault = "fixture-vault";
const itemId = "fixture-item";
const date = "2026-10-15T04:05:06.123456789Z";
function field(
  id: string,
  fieldType: string,
  title = id,
  value = "fixture-value",
) {
  return { id, title, fieldType, value };
}
function website(url: string) {
  return { url, label: "sign-in", autofillBehavior: "ExactDomain" };
}
function overview(id = itemId, title = "Fixture login", category = "Login") {
  return {
    id,
    title,
    category,
    vaultId: vault,
    websites: [website("https://fixture.invalid")],
    tags: ["untouched-tag"],
    createdAt: date,
    updatedAt: date,
    state: "active",
  };
}
function fullItem() {
  const { state: _state, ...base } = overview();
  return {
    ...base,
    notes: "fixture-notes",
    version: 17,
    fields: [
      field("username", "Text", "Localized user", "fixture-user"),
      field("password", "Concealed", "Localized password", "fixture-password"),
      {
        ...field("otp", "Totp"),
        sectionId: "extras",
        details: { type: "Otp", content: { code: "123456" } },
      },
      { ...field("custom", "Text", "Custom"), sectionId: "extras" },
    ],
    sections: [{ id: "extras", title: "Untouched section", future: true }],
    files: [
      {
        attributes: { id: "file", name: "file.txt", size: 42 },
        sectionId: "extras",
        fieldId: "file-field",
      },
    ],
    document: { id: "document", name: "document.txt", size: 24 },
    websites: [
      website("https://first.invalid"),
      website("https://second.invalid"),
    ],
    future: { bytes: [1, 2, 3], nested: { keep: true } },
  };
}
function decode(value: BoundaryValue, expectedVault = vault) {
  return readOnePasswordSdkItem(value, expectedVault, itemId);
}
function read(changes: JsonObject = {}) {
  return decode({ ...fullItem(), ...changes });
}
function reject(
  changes: JsonObject,
  code: SecretBackendError["code"] = "response",
) {
  expectCode(() => read(changes), code);
}
function expectCode(operation: () => void, code: SecretBackendError["code"]) {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretBackendError);
    if (error instanceof SecretBackendError) {
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("fixture-password");
    }
    return;
  }
  throw new Error("Expected a sanitized secret-backend failure.");
}
function deepFreeze(value: JsonValue): void {
  if (value !== null && Object(value) === value) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}

describe("native 1Password read codec", () => {
  it("reads official Login field IDs without matching localized titles", () => {
    expect(read().normalized).toEqual({
      id: itemId,
      name: "Fixture login",
      kind: "login",
      notes: "fixture-notes",
      secret: "fixture-password",
      username: "fixture-user",
      url: "https://first.invalid",
      fields: { Custom: "fixture-value" },
    });
  });

  it("retains frozen full native JSON, dates, version and opaque metadata", () => {
    const input = fullItem();
    const snapshot = JSON.stringify(input);
    deepFreeze(input);
    const result = decode(input);
    expect(result.raw).toBe(input);
    expect(JSON.stringify(result.raw)).toBe(snapshot);
    expect(result.data.version).toBe(17);
    expect(result.data.createdAt).toBe(date);
    expect(result.fields.secret?.id).toBe("password");
    expect(result.raw.future).toEqual(input.future);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("reads top-level SecureNote notes and preserves concealed custom fields", () => {
    const result = read({
      category: "SecureNote",
      fields: [field("extra", "Concealed")],
    });
    expect(result.normalized).toMatchObject({
      kind: "note",
      notes: "fixture-notes",
      secret: "",
      username: "",
      url: "",
      fields: { extra: "fixture-value" },
    });
  });

  it("reads an existing ApiCredentials item's sole native concealed field", () => {
    const native = {
      ...field("native-credential", "Concealed", "Localized key"),
      sectionId: "extras",
      future: true,
    };
    const result = read({
      category: "ApiCredentials",
      fields: [native, field("hostname", "Text")],
    });
    expect(result.normalized).toMatchObject({
      kind: "secret",
      secret: "fixture-value",
      fields: { hostname: "fixture-value" },
    });
    expect(result.fields.secret?.id).toBe("native-credential");
  });

  it("prefers the explicit app-owned secret while preserving other secrets", () => {
    const result = read({
      category: "ApiCredentials",
      sections: [{ id: "opensesame", title: "OpenSesame" }],
      fields: [
        {
          ...field("opensesame_secret", "Concealed", "Secret", "owned"),
          sectionId: "opensesame",
        },
        field("backup", "Concealed"),
      ],
    });
    expect(result.normalized.secret).toBe("owned");
    expect(result.normalized.fields).toEqual({ backup: "fixture-value" });
  });

  it.each(["Login", "SecureNote", "ApiCredentials"])(
    "supports empty native %s templates",
    (category) => {
      expect(read({ category, fields: [] }).normalized.secret).toBe("");
    },
  );

  it("allows empty built-in section IDs but not custom-section masquerades", () => {
    const base = fullItem();
    const fields = base.fields.map((entry) => ({
      ...entry,
      sectionId: entry.id === "otp" || entry.id === "custom" ? "extras" : "",
    }));
    expect(read({ ...base, fields }).normalized.username).toBe("fixture-user");
    reject(
      {
        ...base,
        fields: [{ ...field("password", "Concealed"), sectionId: "extras" }],
      },
      "ambiguous",
    );
  });

  it("rejects ambiguous native API secrets instead of guessing an English title", () => {
    reject(
      {
        category: "ApiCredentials",
        fields: [
          field("a", "Concealed", "credential"),
          field("b", "Concealed", "password"),
        ],
      },
      "ambiguous",
    );
  });

  it.each(["username", "password", "opensesame_secret"])(
    "rejects incompatible reserved field %s",
    (id) => {
      reject(
        {
          category: id === "opensesame_secret" ? "ApiCredentials" : "Login",
          fields: [field(id, "Reference")],
        },
        "unsupported",
      );
    },
  );

  it("requires the reserved secret section ID and preserves a renamed section", () => {
    const base = {
      category: "ApiCredentials",
      fields: [field("opensesame_secret", "Concealed")],
    };
    expectCode(() => read(base), "ambiguous");
    reject(
      { ...base, fields: [{ ...base.fields[0], sectionId: "extras" }] },
      "ambiguous",
    );
    const renamed = read({
      ...base,
      sections: [{ id: "opensesame", title: "Operator renamed section" }],
      fields: [{ ...base.fields[0], sectionId: "opensesame" }],
    });
    expect(renamed.normalized.secret).toBe("fixture-value");
    expect(renamed.raw.sections).toEqual([
      { id: "opensesame", title: "Operator renamed section" },
    ]);
  });

  it.each(["Document", "LOGIN", "SECURE_NOTE", "FutureCategory"])(
    "does not coerce unsupported category %s into a secret",
    (category) => {
      expectCode(() => read({ category }), "unsupported");
    },
  );

  it("rejects duplicate native field IDs, section IDs and projected titles", () => {
    const base = fullItem();
    reject(
      { ...base, fields: [field("a", "Text"), field("a", "Text")] },
      "ambiguous",
    );
    reject(
      { ...base, sections: [...base.sections, ...base.sections] },
      "ambiguous",
    );
    reject(
      {
        ...base,
        fields: [field("a", "Text", "same"), field("b", "Concealed", "same")],
      },
      "ambiguous",
    );
  });

  it("validates section references even for preserved unsupported field types", () => {
    reject(
      {
        fields: [{ ...field("otp", "Totp"), sectionId: "missing" }],
      },
      "response",
    );
  });

  it("does not flatten unsupported typed fields or discard their raw details", () => {
    const base = fullItem();
    const fields = [
      field("plain", "Text", "same"),
      {
        ...field("typed", "Address", "same"),
        details: { nested: [true, false] },
      },
    ];
    const result = read({ ...base, fields });
    expect(result.normalized.fields).toEqual({ same: "fixture-value" });
    expect(result.raw.fields).toEqual(fields);
  });

  it("retains dangerous and Unicode custom titles as safe own data properties", () => {
    const fields = [
      field("a", "Text", "__proto__"),
      field("b", "Text", "constructor"),
      field("c", "Text", "秘密"),
    ];
    const projected = read({ fields }).normalized.fields;
    expect(Object.getOwnPropertyDescriptor(projected, "__proto__")?.value).toBe(
      "fixture-value",
    );
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "秘密")).toBe(false);
    expect(projected?.秘密).toBe("fixture-value");
  });

  it("rejects wrong vault or item IDs before exposing normalized values", () => {
    reject({ vaultId: "another-vault" }, "response");
    expectCode(() => read({ id: "another-item" }), "response");
    expectCode(() => decode(fullItem(), ""), "response");
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid version %s",
    (version) => {
      expectCode(() => read({ version }), "response");
    },
  );

  it.each([
    null,
    [],
    "fixture-password",
    new Date(),
    new Map(),
    { ...fullItem(), createdAt: 1 },
    { ...fullItem(), updatedAt: "2026-02-30T00:00:00Z" },
    { ...fullItem(), fields: {} },
    { ...fullItem(), files: [{ attributes: { size: -1 } }] },
  ])("rejects malformed native wire data %#", (value) => {
    expectCode(() => decode(value), "response");
  });

  it("never executes accessors or toJSON while validating native replies", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const getter = vi.fn(() => "fixture-password");
    const toJSON = vi.fn(() => fullItem());
    const input = Object.defineProperty(fullItem(), "title", { get: getter });
    const array = Object.defineProperty([1], "0", {
      get: getter,
      enumerable: true,
    });
    expectCode(() => decode(input), "response");
    expectCode(() => read({ future: array }), "response");
    const shared = "x".repeat(128 * 1024);
    const repeated = Array.from({ length: 40 }, () => shared);
    expectCode(() => read({ future: repeated }), "response");
    expectCode(() => decode({ ...fullItem(), future: { toJSON } }), "response");
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
  });

  it("rejects cyclic, nonfinite, sparse, symbol and excessive JSON", () => {
    const cycle: JsonValue[] = [];
    cycle.push(cycle);
    const sparse = [1];
    Reflect.deleteProperty(sparse, "0");
    Object.defineProperty(sparse, "ignored", { value: true, enumerable: true });
    for (const future of [
      cycle,
      Number.POSITIVE_INFINITY,
      sparse,
      "x".repeat(4 * 1024 * 1024 + 1),
      "😀".repeat(1_100_000),
      Array.from({ length: 20_001 }, () => 0),
    ])
      expectCode(() => read({ future }), "response");
    const symbol = Object.defineProperty(fullItem(), Symbol.toStringTag, {
      value: "native",
    });
    expectCode(() => decode(symbol), "response");
  });

  it("rejects hidden metadata and nonenumerable array indices", () => {
    const input = Object.defineProperty(fullItem(), "hidden", { value: true });
    const array = Object.defineProperty([1], "0", {
      value: 1,
      enumerable: false,
    });
    expectCode(() => decode(input), "response");
    expectCode(() => read({ future: array }), "response");
  });

  it("does not reinterpret optional full-item state as overview admission", () => {
    const result = read({ state: "archived" });
    expect(result.raw.state).toBe("archived");
  });
});
