import type {
  BoundaryValue,
  JsonObject,
  JsonValue,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { readOnePasswordSdkItem } from "./onepassword-sdk-codec.js";
import { patchOnePasswordSdkItem } from "./onepassword-sdk-write.js";
import { SecretBackendError, type SecretBackendItemInput } from "./types.js";

const vault = "fixture-vault";
const id = "fixture-item";
function field(fieldId: string, type: string, title = fieldId): JsonObject {
  return {
    id: fieldId,
    title,
    fieldType: type,
    value: "old-value",
    future: { keep: true },
  };
}
function fullItem() {
  return {
    id,
    vaultId: vault,
    category: "Login",
    title: "Original",
    notes: "Original notes",
    version: 17,
    createdAt: "2026-10-15T04:05:06.123456789Z",
    updatedAt: "2026-10-15T04:06:07Z",
    tags: ["keep-tag"],
    sections: [{ id: "extras", title: "Operator section", future: true }],
    fields: [
      field("username", "Text", "Localized user"),
      field("password", "Concealed", "Localized password"),
      {
        ...field("deployment", "Concealed", "Deployment"),
        sectionId: "extras",
        details: { preserve: [1, 2, 3] },
      },
      {
        ...field("otp", "Totp", "One-time password"),
        sectionId: "extras",
        details: { type: "Otp", content: { code: "123456" } },
      },
    ],
    websites: [
      {
        url: "https://first.invalid",
        label: "Operator label",
        autofillBehavior: "Never",
        future: true,
      },
      {
        url: "https://second.invalid",
        label: "Other",
        autofillBehavior: "ExactDomain",
      },
    ],
    files: [
      {
        attributes: { id: "file", name: "file.txt", size: 42 },
        sectionId: "extras",
        fieldId: "file-field",
        future: true,
      },
    ],
    document: { id: "doc", name: "doc.txt", size: 24 },
    future: { nativeArray: [true, false], nested: { preserve: "opaque" } },
  };
}
function input(): SecretBackendItemInput {
  return { name: "Edited", notes: "Edited notes", secret: "updated-secret" };
}
function patch(
  raw: BoundaryValue = fullItem(),
  changes: Partial<SecretBackendItemInput> = {},
) {
  return patchOnePasswordSdkItem(raw, { ...input(), ...changes }, vault, id);
}
function expectCode(operation: () => void, code: SecretBackendError["code"]) {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretBackendError);
    if (error instanceof SecretBackendError) {
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("updated-secret");
    }
    return;
  }
  throw new Error("Expected a sanitized native patch failure.");
}
function freeze(value: JsonValue): void {
  if (value !== null && Object(value) === value) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

describe("native 1Password full-item patch", () => {
  it("modifies only editor-owned values in a complete frozen native item", () => {
    const raw = fullItem();
    const before = JSON.stringify(raw);
    freeze(raw);
    const result = patch(raw, {
      username: "new-user",
      url: "https://new.invalid",
      fields: { Deployment: "new-deployment" },
    });
    expect(result).toEqual({
      ...raw,
      title: "Edited",
      notes: "Edited notes",
      fields: [
        { ...raw.fields[0], value: "new-user" },
        { ...raw.fields[1], value: "updated-secret" },
        { ...raw.fields[2], value: "new-deployment" },
        raw.fields[3],
      ],
      websites: [
        { ...raw.websites[0], url: "https://new.invalid" },
        raw.websites[1],
      ],
    });
    expect(JSON.stringify(raw)).toBe(before);
    expect(result.version).toBe(17);
    expect(result.files).toEqual(raw.files);
    expect(result.createdAt).toBe(raw.createdAt);
  });

  it("preserves omitted username, URL and custom fields without category changes", () => {
    const raw = fullItem();
    const result = patch(raw);
    expect(result.fields).toEqual([
      raw.fields[0],
      { ...raw.fields[1], value: "updated-secret" },
      ...raw.fields.slice(2),
    ]);
    expect(result.websites).toEqual(raw.websites);
    expect(result.sections).toEqual(raw.sections);
    expect(result.category).toBe("Login");
  });

  it("clears only the projected field and first website, retaining extra websites", () => {
    const raw = fullItem();
    const result = patch(raw, { username: "", secret: "", url: "" });
    expect(result.fields).toEqual([
      { ...raw.fields[0], value: "" },
      { ...raw.fields[1], value: "" },
      ...raw.fields.slice(2),
    ]);
    expect(result.websites).toEqual(raw.websites.slice(1));
  });

  it("adds missing Login built-ins and a native website without replacing metadata", () => {
    const result = patch(
      { ...fullItem(), fields: [], websites: [] },
      { username: "new-user", url: "https://new.invalid" },
    );
    expect(result.fields).toEqual([
      {
        id: "username",
        title: "username",
        fieldType: "Text",
        value: "new-user",
      },
      {
        id: "password",
        title: "password",
        fieldType: "Concealed",
        value: "updated-secret",
      },
    ]);
    expect(result.websites).toEqual([
      {
        url: "https://new.invalid",
        label: "website",
        autofillBehavior: "AnywhereOnWebsite",
      },
    ]);
    expect(
      patch({ ...fullItem(), fields: [] }, { secret: "", username: "" }).fields,
    ).toEqual([]);
  });

  it("retains native secret field ID, section, type, title and unknown details", () => {
    const native = {
      ...field("native-key", "Concealed", "Operator secret"),
      sectionId: "extras",
      details: { preserve: true },
    };
    const result = patch({
      ...fullItem(),
      category: "ApiCredentials",
      fields: [native],
    });
    expect(result.fields).toEqual([{ ...native, value: "updated-secret" }]);
    expect(result.sections).toEqual(fullItem().sections);
  });

  it("preserves a renamed owned section and all its opaque properties", () => {
    const secret = {
      ...field("opensesame_secret", "Concealed"),
      sectionId: "opensesame",
    };
    const sections = [
      {
        id: "opensesame",
        title: "Operator renamed this",
        future: { keep: true },
      },
    ];
    const result = patch({
      ...fullItem(),
      category: "ApiCredentials",
      fields: [secret],
      sections,
    });
    expect(result.sections).toEqual(sections);
    expect(result.fields).toEqual([{ ...secret, value: "updated-secret" }]);
  });

  it("adds a reserved secret only when its reserved section ID is unclaimed", () => {
    const raw = { ...fullItem(), category: "ApiCredentials", fields: [] };
    const result = patch(raw);
    expect(result.fields).toEqual([
      {
        id: "opensesame_secret",
        title: "Secret",
        fieldType: "Concealed",
        value: "updated-secret",
        sectionId: "opensesame",
      },
    ]);
    expect(result.sections).toEqual([
      ...raw.sections,
      { id: "opensesame", title: "OpenSesame" },
    ]);
    expect(patch(raw, { secret: "" }).fields).toEqual([]);
    for (const title of ["OpenSesame", "Unrelated section"])
      expectCode(
        () => patch({ ...raw, sections: [{ id: "opensesame", title }] }),
        "ambiguous",
      );
  });

  it("allocates new custom field and section IDs against the complete native sets", () => {
    const raw = fullItem();
    raw.fields.push(
      field("opensesame_field_1", "Text", "Existing one"),
      field("opensesame_field_3", "Text", "Existing three"),
    );
    const sections = [
      ...raw.sections,
      { id: "opensesame_custom_1", title: "Unrelated", future: true },
    ];
    const result = patch(
      { ...raw, sections },
      { fields: { New: "new", Other: "other" } },
    );
    expect(result.fields).toEqual([
      ...raw.fields.slice(0, 1),
      { ...raw.fields[1], value: "updated-secret" },
      ...raw.fields.slice(2),
      {
        id: "opensesame_field_2",
        title: "New",
        fieldType: "Text",
        value: "new",
        sectionId: "opensesame_custom_2",
      },
      {
        id: "opensesame_field_4",
        title: "Other",
        fieldType: "Text",
        value: "other",
        sectionId: "opensesame_custom_2",
      },
    ]);
    expect(result.sections).toEqual([
      ...sections,
      { id: "opensesame_custom_2", title: "OpenSesame" },
    ]);
  });

  it("upserts custom values without deleting omitted fields or flattening types", () => {
    const raw = fullItem();
    raw.fields.push(field("plain", "Text", "Plain"));
    const result = patch(raw, { fields: { Deployment: "" } });
    expect(result.fields).toEqual([
      raw.fields[0],
      { ...raw.fields[1], value: "updated-secret" },
      { ...raw.fields[2], value: "" },
      ...raw.fields.slice(3),
    ]);
    expectCode(
      () => patch(raw, { fields: { "One-time password": "replacement" } }),
      "ambiguous",
    );
  });

  it("keeps safe custom title keys distinct from native IDs and built-ins", () => {
    const values = Object.fromEntries([
      ["__proto__", "safe"],
      ["constructor", "safe-constructor"],
      ["password", "custom-password"],
      ["秘密", "unicode-value"],
    ]);
    const result = patch(fullItem(), { fields: values });
    const projected = readOnePasswordSdkItem(result, vault, id).normalized
      .fields;
    expect(Object.getOwnPropertyDescriptor(projected, "__proto__")?.value).toBe(
      "safe",
    );
    expect(
      Object.getOwnPropertyDescriptor(projected, "constructor")?.value,
    ).toBe("safe-constructor");
    expect(projected?.password).toBe("custom-password");
    expect(projected?.秘密).toBe("unicode-value");
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "safe")).toBe(false);
  });

  it("preserves hidden native note data while rejecting nonexposable edits", () => {
    const raw = { ...fullItem(), category: "SecureNote" };
    const result = patch(raw, {
      kind: "note",
      secret: "",
      username: "",
      url: "",
    });
    expect(result.fields).toEqual(raw.fields);
    expect(result.websites).toEqual(raw.websites);
    expectCode(() => patch(raw), "unsupported");
    expectCode(
      () => patch(raw, { secret: "", username: "hidden" }),
      "unsupported",
    );
    expectCode(() => patch(raw, { secret: "", url: "hidden" }), "unsupported");
    const api = { ...raw, category: "ApiCredentials", fields: [] };
    expectCode(() => patch(api, { username: "hidden" }), "unsupported");
    expectCode(() => patch(api, { url: "hidden" }), "unsupported");
  });

  it("rejects category changes, summary bases, wrong scope and ambiguous field maps", () => {
    const draft = { ...input(), id: "foreign-editor-id" };
    expect(patchOnePasswordSdkItem(fullItem(), draft, vault, id).id).toBe(id);
    expectCode(() => patch(fullItem(), { kind: "secret" }), "unsupported");
    expectCode(() => patch({ id, name: "summary", kind: "login" }), "response");
    expectCode(() => patch({ ...fullItem(), vaultId: "foreign" }), "response");
    expectCode(() => patch({ ...fullItem(), id: "foreign" }), "response");
    expectCode(
      () =>
        patch({
          ...fullItem(),
          fields: [field("a", "Text", "same"), field("b", "Text", "same")],
        }),
      "ambiguous",
    );
  });

  it("refuses an oversized complete native item without dropping its metadata", () => {
    const raw = {
      ...fullItem(),
      future: { retained: "x".repeat(1024 * 1024) },
    };
    const before = JSON.stringify(raw);
    expectCode(() => patch(raw), "configuration");
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("refuses field-count expansion beyond the native reader limit", () => {
    const fields = Array.from({ length: 1024 }, (_, index) =>
      field(`field-${index}`, "Text"),
    );
    expectCode(
      () => patch({ ...fullItem(), fields }, { fields: { New: "value" } }),
      "configuration",
    );
  });
});
