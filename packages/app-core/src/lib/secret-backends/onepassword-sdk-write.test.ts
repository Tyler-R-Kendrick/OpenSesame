import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { createOnePasswordSdkItem } from "./onepassword-sdk-write.js";
import { SecretBackendError, type SecretBackendItemInput } from "./types.js";

const vault = "fixture-vault";
function input(): SecretBackendItemInput {
  return {
    name: "Fixture login",
    notes: "Fixture notes",
    secret: "fixture-secret",
    kind: "login",
  };
}
function create(changes: Partial<SecretBackendItemInput> = {}) {
  return createOnePasswordSdkItem({ ...input(), ...changes }, vault);
}
function rawCreate(value: BoundaryValue) {
  const draft: SecretBackendItemInput = overlapCast(value);
  return createOnePasswordSdkItem(draft, vault);
}
function expectCode(operation: () => void, code: SecretBackendError["code"]) {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretBackendError);
    if (error instanceof SecretBackendError) {
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("fixture-secret");
    }
    return;
  }
  throw new Error("Expected a sanitized native write failure.");
}

describe("native 1Password ItemCreateParams", () => {
  it("uses the official native Login category, field IDs and website model", () => {
    expect(
      create({ username: "fixture-user", url: "https://fixture.invalid" }),
    ).toEqual({
      category: "Login",
      vaultId: vault,
      title: "Fixture login",
      notes: "Fixture notes",
      fields: [
        {
          id: "username",
          title: "username",
          fieldType: "Text",
          value: "fixture-user",
        },
        {
          id: "password",
          title: "password",
          fieldType: "Concealed",
          value: "fixture-secret",
        },
      ],
      sections: [],
      tags: [],
      websites: [
        {
          url: "https://fixture.invalid",
          label: "website",
          autofillBehavior: "AnywhereOnWebsite",
        },
      ],
    });
  });

  it("defaults to a SecureNote with top-level notes, not a Connect notes field", () => {
    const note = create({ kind: undefined, secret: "" });
    expect(note).toEqual({
      category: "SecureNote",
      vaultId: vault,
      title: "Fixture login",
      notes: "Fixture notes",
      fields: [],
      sections: [],
      tags: [],
      websites: [],
    });
    expect(note).not.toHaveProperty("vault");
    expect(note).not.toHaveProperty("urls");
    expect(note).not.toHaveProperty("notesPlain");
  });

  it("creates ApiCredentials with an explicit owned concealed field and section", () => {
    expect(create({ kind: "secret" })).toMatchObject({
      category: "ApiCredentials",
      fields: [
        {
          id: "opensesame_secret",
          title: "Secret",
          fieldType: "Concealed",
          value: "fixture-secret",
          sectionId: "opensesame",
        },
      ],
      sections: [{ id: "opensesame", title: "OpenSesame" }],
    });
  });

  it("allocates deterministic custom IDs separately from built-ins and secret sections", () => {
    const fields = Object.fromEntries([
      ["password", "custom"],
      ["__proto__", "safe"],
      ["秘密", "value"],
    ]);
    const first = create({ kind: "secret", fields });
    expect(first).toEqual(create({ kind: "secret", fields }));
    expect(first.fields).toEqual([
      {
        id: "opensesame_secret",
        title: "Secret",
        fieldType: "Concealed",
        value: "fixture-secret",
        sectionId: "opensesame",
      },
      {
        id: "opensesame_field_1",
        title: "password",
        fieldType: "Text",
        value: "custom",
        sectionId: "opensesame_custom_1",
      },
      {
        id: "opensesame_field_2",
        title: "__proto__",
        fieldType: "Text",
        value: "safe",
        sectionId: "opensesame_custom_1",
      },
      {
        id: "opensesame_field_3",
        title: "秘密",
        fieldType: "Text",
        value: "value",
        sectionId: "opensesame_custom_1",
      },
    ]);
    expect(first.sections).toEqual([
      { id: "opensesame", title: "OpenSesame" },
      { id: "opensesame_custom_1", title: "OpenSesame" },
    ]);
    expect(Object.hasOwn(Object.prototype, "秘密")).toBe(false);
  });

  it("does not mutate frozen editor values or use the editor's item ID", () => {
    const fields = Object.freeze({ Custom: "fixture-value" });
    const draft = Object.freeze({
      ...input(),
      fields,
      id: "untrusted-editor-id",
    });
    const snapshot = JSON.stringify(draft);
    const result = createOnePasswordSdkItem(draft, vault);
    expect(JSON.stringify(draft)).toBe(snapshot);
    expect(result).not.toHaveProperty("id");
  });

  it.each([
    ["login", 1022],
    ["secret", 1023],
    ["note", 1024],
  ] as const)(
    "keeps native %s field counts compatible with the published reader",
    (kind, available) => {
      const fields = (count: number) =>
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `field-${index}`,
            "value",
          ]),
        );
      const base = { kind, secret: kind === "note" ? "" : "fixture-secret" };
      expect(
        create({ ...base, fields: fields(available) }).fields,
      ).toHaveLength(1024);
      expectCode(
        () => create({ ...base, fields: fields(available + 1) }),
        "configuration",
      );
    },
  );

  it.each(["note", "secret"] as const)(
    "rejects nonexposable username and website for %s",
    (kind) => {
      for (const changes of [
        { username: "fixture-user" },
        { url: "https://fixture.invalid" },
      ])
        expectCode(
          () =>
            create({
              ...changes,
              kind,
              secret: kind === "note" ? "" : "fixture-secret",
            }),
          "unsupported",
        );
    },
  );

  it("rejects a note's hidden secret instead of discarding it", () => {
    expectCode(() => create({ kind: "note" }), "unsupported");
  });

  it("allows empty optional fields and preserves notes on all supported categories", () => {
    for (const kind of ["note", "login", "secret"] as const)
      expect(
        create({ kind, secret: "", username: "", url: "", fields: undefined })
          .notes,
      ).toBe("Fixture notes");
  });

  it.each(["", " ", "\n"])("rejects an empty item title %#", (name) => {
    expectCode(() => create({ name }), "configuration");
  });

  it.each(["", "x".repeat(1025)])(
    "rejects an invalid configured vault %#",
    (vaultId) => {
      expectCode(
        () => createOnePasswordSdkItem(input(), vaultId),
        "configuration",
      );
    },
  );

  it.each([
    null,
    [],
    new Date(),
    { ...input(), kind: "Login" },
    { ...input(), fields: { Custom: 42 } },
    { ...input(), fields: [] },
    { ...input(), vaultId: "foreign" },
  ])("rejects malformed editor input %# without raw Zod errors", (value) => {
    expectCode(() => rawCreate(value), "configuration");
  });

  it("does not execute input getters, class methods or custom-field accessors", () => {
    const getter = vi.fn(() => "fixture-secret");
    const draft = Object.defineProperty(input(), "secret", { get: getter });
    const fields = Object.defineProperty({}, "Custom", {
      get: getter,
      enumerable: true,
    });
    expectCode(() => rawCreate(draft), "configuration");
    expectCode(() => rawCreate({ ...input(), fields }), "configuration");
    expectCode(
      () => rawCreate({ ...input(), fields: { toJSON: getter } }),
      "configuration",
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects hidden, inherited and symbol-keyed custom metadata", () => {
    const hidden = Object.defineProperty(input(), "hidden", {
      value: "fixture-secret",
    });
    const inherited = Object.create({ hidden: "fixture-secret" });
    const symbol = Object.defineProperty(input(), Symbol.toStringTag, {
      value: "input",
    });
    expectCode(() => rawCreate(hidden), "configuration");
    expectCode(
      () => rawCreate({ ...input(), fields: inherited }),
      "configuration",
    );
    expectCode(() => rawCreate(symbol), "configuration");
  });

  it("honors exact 1 MiB output bytes, including multibyte data and framing", () => {
    expectCode(() => create({ notes: "😀".repeat(270_000) }), "configuration");
    expectCode(
      () => create({ notes: "x".repeat(1024 * 1024 - 80) }),
      "configuration",
    );
    expect(create({ notes: "x".repeat(1024 * 1024 - 1024) }).category).toBe(
      "Login",
    );
  });

  it("bounds repeated editor text before invoking the command's JSON serializer", () => {
    const shared = "x".repeat(128 * 1024);
    const fields = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field-${index}`, shared]),
    );
    const stringify = vi.spyOn(JSON, "stringify");
    expectCode(() => create({ fields }), "configuration");
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
  });
});
