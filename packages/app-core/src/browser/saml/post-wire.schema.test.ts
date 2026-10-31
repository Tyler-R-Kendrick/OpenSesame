import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  SAML_POST_BYTES,
  SamlNonceSchema,
  SamlPostArmSchema,
  SamlPostChannelSchema,
  SamlPostCommandSchema,
  SamlPostRecordSchema,
  SamlPostReplySchema,
} from "./post-wire.js";

// The previous classic contract checks outputs and complete issue records.
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const point = z.string().regex(/^[A-Za-z0-9_-]{87}$/);
const client = z.string().min(1).max(128);
const request = z.string().regex(/^_[A-Za-z0-9_.-]{1,255}$/);
const arm = z
  .object({
    kind: z.literal("SAML_ARM"),
    nonce,
    requestId: request,
    expiresAt: z.number().int().positive(),
    idpOrigin: z.string().url().max(2048),
    publicKey: point,
  })
  .strict();
const record = z
  .object({
    nonce,
    requestId: request,
    expiresAt: z.number().int().positive(),
    acsUrl: z.string().url().max(2048),
    recordId: client,
    publicKey: point,
  })
  .strict();
const command = z.union([
  arm,
  z.object({ kind: z.literal("SAML_CANCEL"), nonce }).strict(),
  z.object({ kind: z.literal("SAML_METADATA") }).strict(),
  z
    .object({
      kind: z.enum(["SAML_CLAIM", "SAML_CONSUME"]),
      nonce,
      recordId: client,
    })
    .strict(),
]);
const reply = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(["missing", "denied", "capacity", "malformed"]),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      record: record.optional(),
      response: z
        .string()
        .max(SAML_POST_BYTES * 2)
        .optional(),
    })
    .strict(),
]);
const binding = { nonce, recordId: client };
const channel = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello"), ...binding, publicKey: point }).strict(),
  z.object({ kind: z.literal("ready"), ...binding, mac: nonce }).strict(),
  z
    .object({
      kind: z.literal("payload"),
      ...binding,
      publicKey: point,
      iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
      ciphertext: z
        .string()
        .min(22)
        .max(524288)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
  z.object({ kind: z.literal("received"), ...binding, mac: nonce }).strict(),
]);
const NONCE = "A".repeat(43);
const POINT = "B".repeat(87);
const RECORD = {
  nonce: NONCE,
  requestId: "_request",
  expiresAt: 1,
  acsUrl: "https://rp.example/auth/native-saml",
  recordId: "record",
  publicKey: POINT,
};
const ARM = {
  kind: "SAML_ARM",
  nonce: NONCE,
  requestId: RECORD.requestId,
  expiresAt: RECORD.expiresAt,
  idpOrigin: "https://idp.example",
  publicKey: POINT,
};
const PAYLOAD = {
  kind: "payload",
  nonce: NONCE,
  recordId: RECORD.recordId,
  publicKey: POINT,
  iv: "C".repeat(16),
  ciphertext: "D".repeat(22),
};
const commands = [
  ARM,
  { kind: "SAML_CANCEL", nonce: NONCE },
  { kind: "SAML_METADATA" },
  ...["SAML_CLAIM", "SAML_CONSUME"].map((kind) => ({
    kind,
    nonce: NONCE,
    recordId: RECORD.recordId,
  })),
];
const replies = [
  ...["missing", "denied", "capacity", "malformed"].map((reason) => ({
    ok: false,
    reason,
  })),
  { ok: true },
  { ok: true, record: RECORD },
  { ok: true, response: "" },
  { ok: true, record: RECORD, response: "sealed-response" },
  { ok: true, record: undefined, response: undefined },
];
const channels = [
  { kind: "hello", nonce: NONCE, recordId: "record", publicKey: POINT },
  { kind: "ready", nonce: NONCE, recordId: "record", mac: NONCE },
  PAYLOAD,
  { kind: "received", nonce: NONCE, recordId: "record", mac: NONCE },
];
const schemas = [
  ["nonce", SamlNonceSchema, nonce, [NONCE]],
  ["arm", SamlPostArmSchema, arm, [ARM]],
  ["record", SamlPostRecordSchema, record, [RECORD]],
  ["command", SamlPostCommandSchema, command, commands],
  ["reply", SamlPostReplySchema, reply, replies],
  ["channel", SamlPostChannelSchema, channel, channels],
] as const;
const urlAt = (length: number) => {
  const prefix = "https://idp.example/";
  return prefix + "a".repeat(length - prefix.length);
};
const corpus: BoundaryValue[] = [
  undefined,
  null,
  false,
  true,
  0,
  1,
  "",
  "untrusted",
  [],
  {},
  new Date(0),
  NONCE,
  ...commands,
  ...replies,
  ...channels,
  RECORD,
];
for (const value of [...commands, ...replies, ...channels, RECORD]) {
  corpus.push({ ...value, unknown: true });
  for (const key of Object.keys(value)) {
    const missing = { ...value };
    Reflect.deleteProperty(missing, key);
    corpus.push(missing);
  }
}
for (const value of [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  "1",
  null,
  1n,
]) {
  corpus.push({ ...ARM, expiresAt: value }, { ...RECORD, expiresAt: value });
}
for (const value of [
  "",
  "A".repeat(42),
  NONCE,
  "A".repeat(44),
  `${NONCE}=`,
  "é".repeat(43),
]) {
  corpus.push(value, { ...ARM, nonce: value }, { ...PAYLOAD, mac: value });
}
for (const value of ["", "B".repeat(86), POINT, "B".repeat(88), `${POINT}=`])
  corpus.push({ ...ARM, publicKey: value }, { ...PAYLOAD, publicKey: value });
for (const value of [
  "_",
  "_a",
  `_${"a".repeat(255)}`,
  `_${"a".repeat(256)}`,
  "no_prefix",
  "_bad space",
])
  corpus.push({ ...ARM, requestId: value });
for (const value of [
  "",
  "x",
  "x".repeat(128),
  "x".repeat(129),
  "😀".repeat(128),
  "😀".repeat(129),
])
  corpus.push({ ...RECORD, recordId: value }, { ...PAYLOAD, recordId: value });
for (const value of [
  "",
  "/relative",
  "not-url",
  "http://localhost",
  "mailto:user@example.test",
  urlAt(2048),
  urlAt(2049),
])
  corpus.push({ ...ARM, idpOrigin: value }, { ...RECORD, acsUrl: value });
for (const value of [
  "C".repeat(15),
  "C".repeat(16),
  "C".repeat(17),
  "=".repeat(16),
])
  corpus.push({ ...PAYLOAD, iv: value });
for (const value of [
  "D".repeat(21),
  "D".repeat(22),
  "D".repeat(524288),
  "D".repeat(524289),
  `${"D".repeat(22)}=`,
])
  corpus.push({ ...PAYLOAD, ciphertext: value });
corpus.push(
  { ok: true, response: "r".repeat(SAML_POST_BYTES * 2) },
  { ok: true, response: "r".repeat(SAML_POST_BYTES * 2 + 1) },
  { ok: true, reason: "missing" },
  { ok: false, reason: "unknown" },
  { kind: "SAML_METADATA", nonce: NONCE },
  { ...PAYLOAD, kind: "ready" },
);
describe("SAML transport mini-schema admission parity", () => {
  it("enforces widths, integer safety and request bounds explicitly", () => {
    expect(SamlNonceSchema.safeParse(NONCE).success).toBe(true);
    expect(SamlNonceSchema.safeParse("A".repeat(42)).success).toBe(false);
    expect(SamlNonceSchema.safeParse("A".repeat(44)).success).toBe(false);
    for (const expiresAt of [1, Number.MAX_SAFE_INTEGER])
      expect(SamlPostArmSchema.safeParse({ ...ARM, expiresAt }).success).toBe(
        true,
      );
    for (const expiresAt of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(SamlPostArmSchema.safeParse({ ...ARM, expiresAt }).success).toBe(
        false,
      );
    expect(
      SamlPostArmSchema.safeParse({ ...ARM, requestId: `_${"a".repeat(255)}` })
        .success,
    ).toBe(true);
    expect(
      SamlPostArmSchema.safeParse({ ...ARM, requestId: `_${"a".repeat(256)}` })
        .success,
    ).toBe(false);
    expect(
      SamlPostArmSchema.safeParse({ ...ARM, publicKey: "B".repeat(86) })
        .success,
    ).toBe(false);
  });
  it("keeps exact URL and Unicode codepoint admission", () => {
    for (const idpOrigin of [
      urlAt(2048),
      "http://localhost",
      "mailto:user@example.test",
    ])
      expect(SamlPostArmSchema.safeParse({ ...ARM, idpOrigin }).success).toBe(
        true,
      );
    for (const idpOrigin of [urlAt(2049), "/relative", "not-url"])
      expect(SamlPostArmSchema.safeParse({ ...ARM, idpOrigin }).success).toBe(
        false,
      );
    for (const recordId of ["x", "x".repeat(128), "😀".repeat(128)])
      expect(
        SamlPostRecordSchema.safeParse({ ...RECORD, recordId }).success,
      ).toBe(true);
    for (const recordId of ["", "x".repeat(129), "😀".repeat(129)])
      expect(
        SamlPostRecordSchema.safeParse({ ...RECORD, recordId }).success,
      ).toBe(false);
  });
  it("bounds ciphertext/replies without admitting mixed variants", () => {
    for (const length of [22, 524288])
      expect(
        SamlPostChannelSchema.safeParse({
          ...PAYLOAD,
          ciphertext: "D".repeat(length),
        }).success,
      ).toBe(true);
    for (const length of [21, 524289])
      expect(
        SamlPostChannelSchema.safeParse({
          ...PAYLOAD,
          ciphertext: "D".repeat(length),
        }).success,
      ).toBe(false);
    expect(
      SamlPostReplySchema.safeParse({
        ok: true,
        response: "r".repeat(SAML_POST_BYTES * 2),
      }).success,
    ).toBe(true);
    expect(
      SamlPostReplySchema.safeParse({
        ok: true,
        response: "r".repeat(SAML_POST_BYTES * 2 + 1),
      }).success,
    ).toBe(false);
    expect(
      SamlPostReplySchema.safeParse({ ok: true, reason: "denied" }).success,
    ).toBe(false);
    expect(
      SamlPostCommandSchema.safeParse({ kind: "SAML_METADATA", nonce: NONCE })
        .success,
    ).toBe(false);
    expect(
      SamlPostChannelSchema.safeParse({ ...PAYLOAD, kind: "ready" }).success,
    ).toBe(false);
  });
  for (const [name, actual, reference, accepted] of schemas) {
    it(`accepts every ${name} variant and refuses unknown fields`, () => {
      for (const value of accepted) {
        expect(actual.safeParse(value).success).toBe(true);
        if (isJsonObject(value))
          expect(actual.safeParse({ ...value, unknown: true }).success).toBe(
            false,
          );
      }
    });
    it(`preserves classic ${name} results throughout the boundary corpus`, () => {
      for (const value of corpus) {
        const before = reference.safeParse(value);
        const after = actual.safeParse(value);
        expect(after.success, name).toBe(before.success);
        if (before.success && after.success)
          expect(after.data).toEqual(before.data);
        else if (!before.success && !after.success)
          expect(after.error.issues).toEqual(before.error.issues);
      }
    });
  }
  it("initializes the same English error text in an otherwise mini-only realm", async () => {
    const localeError = z.config().localeError;
    const expected = nonce.safeParse("").error?.issues;
    try {
      z.config({ localeError: undefined });
      vi.resetModules();
      const fresh = await import("./post-wire.js");
      expect(fresh.SamlNonceSchema.safeParse("").error?.issues).toEqual(
        expected,
      );
    } finally {
      z.config({ localeError });
    }
  });
  it("preserves an explicitly configured locale", async () => {
    const localeError = z.config().localeError;
    try {
      z.config({ localeError: () => "custom transport error" });
      vi.resetModules();
      const fresh = await import("./post-wire.js");
      expect(
        fresh.SamlNonceSchema.safeParse("").error?.issues[0]?.message,
      ).toBe("custom transport error");
    } finally {
      z.config({ localeError });
    }
  });
});
