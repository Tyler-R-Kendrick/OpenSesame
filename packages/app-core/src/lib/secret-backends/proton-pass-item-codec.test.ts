import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { describe, expect, it } from "vitest";
import {
  createProtonItem,
  decodeProtonItem,
  updateProtonItem,
} from "./proton-pass-item-codec.js";
import {
  PROTON_ITEM_MAX_BYTES,
  PROTON_ITEM_MAX_FIELDS,
  lastProtonMessage,
  readProtonFields,
} from "./proton-pass-wire.js";
import type { SecretBackendItemInput } from "./types.js";

function message(field: number, bytes: Uint8Array): Uint8Array {
  return new BinaryWriter().tag(field, 2).bytes(bytes).finish();
}
function words(field: number, text: string): Uint8Array {
  return new BinaryWriter().tag(field, 2).string(text).finish();
}
function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}
function unknown(label: string): Uint8Array {
  return new BinaryWriter()
    .tag(100, 0)
    .uint64(0xffff_ffff_ffff_ffffn)
    .tag(101, 1)
    .fixed64(0x1234_5678_9abc_def0n)
    .tag(102, 2)
    .string(label)
    .tag(103, 5)
    .fixed32(0xfedc_ba98)
    .finish();
}
const metadata = concat(
  words(1, "Café 🔐"),
  words(2, "note\n第二行"),
  words(3, "public-uuid"),
  message(4, Uint8Array.of(12, 13, 14)),
  unknown("metadata"),
);
const passkey = concat(
  words(1, "public-key-id"),
  message(2, Uint8Array.of(7)),
  unknown("passkey"),
);
const autofill = concat(words(1, "https://one.test"), unknown("autofill"));
const login = concat(
  words(1, "email@example.test"),
  words(2, "password"),
  words(3, "https://one.test"),
  words(3, "https://two.test"),
  words(4, "otpauth://totp/public"),
  message(5, passkey),
  words(6, "username"),
  message(7, autofill),
  unknown("login"),
);
const platform = message(
  1,
  message(1, concat(words(1, "test.app"), unknown("android"))),
);
const extra = concat(
  words(1, "retained"),
  message(3, concat(words(1, "value"), unknown("extra-text"))),
  unknown("extra"),
);
function fixture(kind: "note" | "login"): Uint8Array {
  const model = kind === "note" ? unknown("note") : login;
  return concat(
    message(1, metadata),
    message(
      2,
      concat(message(kind === "note" ? 2 : 3, model), unknown("content")),
    ),
    message(3, platform),
    message(4, extra),
    unknown("root"),
  );
}
function nested(bytes: Uint8Array, field: number): Uint8Array {
  const result = lastProtonMessage(readProtonFields(bytes), field);
  if (result === null) throw new Error("Missing test fixture field");
  return result;
}
function raw(bytes: Uint8Array, field: number): Uint8Array[] {
  return readProtonFields(bytes)
    .filter((entry) => entry.fieldNo === field)
    .map((entry) => entry.raw);
}
const noteInput: SecretBackendItemInput = {
  name: "Changed",
  notes: "new note",
  secret: "",
  kind: "note",
};
const loginInput: SecretBackendItemInput = {
  name: "Changed",
  notes: "new note",
  secret: "new password",
  kind: "login",
  username: "new username",
  url: "https://changed.test",
};

describe("Proton native item codec", () => {
  it.each(["note", "login"] as const)(
    "projects a genuine %s wire model",
    (kind) => {
      expect(decodeProtonItem(fixture(kind))).toEqual({
        name: "Café 🔐",
        notes: "note\n第二行",
        kind,
        secret: kind === "login" ? "password" : "",
        username: kind === "login" ? "username" : "",
        url: kind === "login" ? "https://one.test" : "",
      });
    },
  );

  it.each(["note", "login"] as const)(
    "edits %s without changing any untouched raw spans",
    (kind) => {
      const before = fixture(kind);
      const input = kind === "note" ? noteInput : loginInput;
      const after = updateProtonItem(before, input);
      expect(decodeProtonItem(after)).toEqual({
        ...input,
        username: input.username ?? "",
        url: input.url ?? "",
      });
      for (const field of [3, 4, 100, 101, 102, 103])
        expect(raw(after, field)).toEqual(raw(before, field));
      const oldMetadata = nested(before, 1);
      const newMetadata = nested(after, 1);
      for (const field of [3, 4, 100, 101, 102, 103])
        expect(raw(newMetadata, field)).toEqual(raw(oldMetadata, field));
      const oldContent = nested(before, 2);
      const newContent = nested(after, 2);
      for (const field of [100, 101, 102, 103])
        expect(raw(newContent, field)).toEqual(raw(oldContent, field));
      if (kind === "note")
        expect(raw(newContent, 2)).toEqual(raw(oldContent, 2));
      else {
        const oldLogin = nested(oldContent, 3);
        const newLogin = nested(newContent, 3);
        for (const field of [1, 4, 5, 7, 100, 101, 102, 103])
          expect(raw(newLogin, field)).toEqual(raw(oldLogin, field));
        expect(raw(newLogin, 3)[1]).toEqual(raw(oldLogin, 3)[1]);
      }
      expect(before).toEqual(fixture(kind));
    },
  );

  it("selects the last WHOLE metadata and repeated login rather than merging hidden fields", () => {
    const bytes = concat(
      message(1, concat(words(1, "hidden title"), words(2, "hidden note"))),
      message(1, words(1, "visible")),
      message(
        2,
        concat(message(3, login), message(3, words(6, "visible user"))),
      ),
    );
    expect(decodeProtonItem(bytes)).toEqual({
      name: "visible",
      notes: "",
      kind: "login",
      secret: "",
      username: "visible user",
      url: "",
    });
    const after = updateProtonItem(bytes, {
      name: "Changed",
      notes: "",
      secret: "",
      kind: "login",
    });
    expect(raw(after, 1)[0]).toEqual(raw(bytes, 1)[0]);
    expect(raw(nested(after, 2), 3)[0]).toEqual(raw(nested(bytes, 2), 3)[0]);
    expect(decodeProtonItem(after)).toEqual({
      name: "Changed",
      notes: "",
      kind: "login",
      secret: "",
      username: "visible user",
      url: "",
    });
  });

  it("explicit empty values mask earlier duplicate scalars and keep later URLs", () => {
    const bytes = concat(
      message(1, metadata),
      message(2, message(3, concat(login, words(2, "visible password")))),
    );
    const after = updateProtonItem(bytes, {
      ...loginInput,
      secret: "",
      username: "",
      url: "",
    });
    expect(decodeProtonItem(after)).toMatchObject({
      secret: "",
      username: "",
      url: "",
    });
    expect(raw(nested(nested(after, 2), 3), 2)[0]).toEqual(
      words(2, "password"),
    );
    expect(raw(nested(nested(after, 2), 3), 3)[1]).toEqual(
      words(3, "https://two.test"),
    );
  });

  it("omitted optional fields preserve bytes and email is never overwritten with username", () => {
    const after = updateProtonItem(fixture("login"), {
      name: "Changed",
      notes: "",
      secret: "new",
    });
    const model = nested(nested(after, 2), 3);
    for (const field of [1, 3, 6])
      expect(raw(model, field)).toEqual(raw(login, field));
  });

  it.each(["note", "login"] as const)(
    "creates %s with explicit real protobuf content and fresh UUID",
    (kind) => {
      const input = kind === "note" ? noteInput : loginInput;
      const first = createProtonItem(input);
      const second = createProtonItem(input);
      expect(decodeProtonItem(first)).toEqual({
        ...input,
        username: input.username ?? "",
        url: input.url ?? "",
      });
      const uuid = new TextDecoder().decode(nested(nested(first, 1), 3));
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(nested(nested(second, 1), 3)).not.toEqual(
        nested(nested(first, 1), 3),
      );
      if (kind === "note") expect(nested(nested(first, 2), 2)).toHaveLength(0);
    },
  );

  it.each([
    { ...noteInput, secret: "would be lost" },
    { ...noteInput, username: "would be lost" },
    { ...noteInput, url: "would be lost" },
    { ...noteInput, fields: { hidden: "would be lost" } },
    { ...noteInput, kind: "secret" as const },
    { ...noteInput, name: "  " },
  ])(
    "rejects unsupported input before creating or mutating content: %j",
    (input) => {
      expect(() => createProtonItem(input)).toThrow();
      expect(() => updateProtonItem(fixture("note"), input)).toThrow();
    },
  );

  it("refuses model conversion and final unsupported oneof instead of overwriting it", () => {
    expect(() => updateProtonItem(fixture("login"), noteInput)).toThrow();
    const unsupported = concat(
      message(1, metadata),
      message(2, concat(message(3, login), message(9, new Uint8Array()))),
    );
    expect(() => decodeProtonItem(unsupported)).toThrow();
    expect(() => updateProtonItem(unsupported, loginInput)).toThrow();
    const supported = concat(
      message(1, metadata),
      message(2, concat(message(9, new Uint8Array()), message(3, login))),
    );
    expect(decodeProtonItem(supported).kind).toBe("login");
  });

  it.each([
    new Uint8Array(),
    Uint8Array.of(10, 5, 1),
    concat(
      message(1, message(1, Uint8Array.of(0xc3, 0x28))),
      message(2, message(2, new Uint8Array())),
    ),
    concat(
      message(1, metadata),
      message(2, message(3, message(2, Uint8Array.of(0xff)))),
    ),
    concat(message(1, metadata), message(2, message(3, Uint8Array.of(16, 1)))),
    concat(message(1, metadata), message(2, message(2, Uint8Array.of(0)))),
  ])("rejects malformed edited-message wire and UTF-8: %j", (bytes) => {
    expect(() => decodeProtonItem(bytes)).toThrow();
    expect(() => updateProtonItem(bytes, noteInput)).toThrow();
  });

  it("enforces a shared nested field budget after appended edits", () => {
    const many = new BinaryWriter();
    for (let count = 0; count < PROTON_ITEM_MAX_FIELDS - 4; count += 1)
      many.tag(100, 0).uint32(0);
    const exact = concat(
      message(1, words(1, "title")),
      message(2, message(2, many.finish())),
    );
    expect(decodeProtonItem(exact).name).toBe("title");
    expect(() => updateProtonItem(exact, noteInput)).toThrow();
    const overflow = concat(exact, unknown("overflow"));
    expect(() => decodeProtonItem(overflow)).toThrow();
  });

  it("rejects oversized strings and combined wire size without changing input", () => {
    expect(() =>
      createProtonItem({
        ...noteInput,
        notes: "x".repeat(PROTON_ITEM_MAX_BYTES + 1),
      }),
    ).toThrow();
    expect(() =>
      createProtonItem({
        ...noteInput,
        notes: "x".repeat(PROTON_ITEM_MAX_BYTES),
      }),
    ).toThrow();
    const bytes = fixture("note");
    expect(() =>
      updateProtonItem(bytes, {
        ...noteInput,
        notes: "x".repeat(PROTON_ITEM_MAX_BYTES),
      }),
    ).toThrow();
    expect(bytes).toEqual(fixture("note"));
  });
});
