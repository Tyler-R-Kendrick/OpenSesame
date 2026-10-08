import { describe, expect, it, vi } from "vitest";
import {
  manifestWithoutAuth,
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "../vault/protection/manifest-auth.js";
import { readPagesRetiredCredentialHeader } from "./context-v2-header.js";
import {
  MAX_RETIRED_CONTEXT_HEADER_BYTES,
  MAX_RETIRED_CONTEXT_WIRE_BYTES,
  deriveRetiredCredentialContextV2 as derive,
  encodeRetiredCredentialContextV2 as encode,
  parseRetiredCredentialContextV2 as parse,
} from "./context-v2.js";
import vectors from "./fixtures/context-v2-vectors.json";

const AT = "2026-10-08T00:00:00.000Z";
const PASSWORD = "refused additional plaintext field";
const firstVector = vectors.vectors[0];
if (!firstVector) throw new Error("Public context vector missing");
const header = readPagesRetiredCredentialHeader(firstVector.rawHeaderJson);
const context = () => derive("personal", JSON.stringify(header));
describe("Pages context raw-boundary and wire refusals", () => {
  it.each([
    "",
    "null",
    "{}",
    JSON.stringify({ v: 1, createdAt: AT }),
    JSON.stringify({ v: 1, createdAt: AT, vaultId: "claimed" }),
  ])("refuses missing/legacy/portable manifest metadata %j", async (input) => {
    await expect(derive("personal", input)).rejects.toThrow(
      "context is unavailable",
    );
  });
  it("refuses workload, malformed gates, unsupported fields and mismatched enrolled factor declarations", async () => {
    for (const input of [
      {
        ...header,
        protection: { ...header.protection, purpose: "workload-root" },
      },
      {
        ...header,
        protection: { ...header.protection, legacyGates: undefined },
      },
      {
        ...header,
        protection: {
          ...header.protection,
          legacyGates: {
            ...header.protection.legacyGates,
            totpEnrolled: true,
          },
        },
      },
      {
        ...header,
        protection: {
          ...header.protection,
          legacyGates: {
            ...header.protection.legacyGates,
            emailEnrolled: "true",
          },
        },
      },
      {
        ...header,
        protection: { ...header.protection, criticalExtensions: [] },
      },
      { ...header, plaintextSecret: PASSWORD },
    ])
      await expect(derive("personal", JSON.stringify(input))).rejects.toThrow(
        "context is unavailable",
      );
  });
  it("rejects oversized supported metadata instead of publishing a witness for partial data", async () => {
    const m = header.protection;
    const records = Array.from({ length: 3 }, (_, n) => ({
      kind: "age-recipient",
      protectorId: `age_${n}`,
      recipients: ["age1public"],
      capsuleAgeB64: btoa("x".repeat(24000)),
      proofStatus: "verified",
    }));
    await expect(
      derive(
        "personal",
        JSON.stringify({
          ...header,
          protection: { ...m, records: [...m.records, ...records] },
        }),
      ),
    ).rejects.toThrow("context is unavailable");
  });
  it("refuses raw duplicate decoded root, manifest, gate and wrap aliases before whole-document parsing", async () => {
    const raw = JSON.stringify(header);
    const vaultField = `${JSON.stringify("vaultId")}:${JSON.stringify(header.protection.vaultId)}`;
    const record = header.protection.records[0];
    if (!record || record.kind !== "recovery-key")
      throw new Error("Invalid public vector");
    const wrapField = `"wrap":${JSON.stringify(record.wrap)}`;
    const inputs = [
      raw.replace('"v":1', '"v":1,"v":1'),
      raw.replace(
        vaultField,
        `${vaultField},"\\u0076aultId":${JSON.stringify(header.protection.vaultId)}`,
      ),
      raw.replace(
        '"totpEnrolled":false',
        '"totpEnrolled":false,"totp\\u0045nrolled":false',
      ),
      raw.replace(
        wrapField,
        `${wrapField},"\\u0077rap":${JSON.stringify(record.wrap)}`,
      ),
    ];
    for (const input of inputs) {
      expect(input).not.toBe(raw);
      const parser = vi.spyOn(JSON, "parse");
      const digest = vi.spyOn(crypto.subtle, "digest");
      try {
        await expect(derive("personal", input)).rejects.toThrow(
          "context is unavailable",
        );
        expect(
          parser.mock.calls.filter(([value]) =>
            /^(?:\{|\[)/.test(value.trimStart()),
          ),
        ).toHaveLength(0);
        expect(digest).not.toHaveBeenCalled();
      } finally {
        parser.mockRestore();
        digest.mockRestore();
      }
    }
  });
  it("refuses raw integer aliases before whole-document parse or generation hashing", async () => {
    const raw = JSON.stringify(header);
    const inputs = [
      raw.replace('"rootEpoch":1', '"rootEpoch":1.0000000000000001'),
      raw.replace('"rootEpoch":1', '"rootEpoch":9007199254740991.1'),
      raw.replace('"rootEpoch":1', '"rootEpoch":9007199254740993'),
      raw.replace('"schemaVersion":1', '"schemaVersion":1.0'),
      raw.replace('"revision":7', '"revision":-0'),
      raw.replace('"v":1', '"v":1e0'),
      raw.replace(
        '"createdAt":',
        '"bodyRev":0.00000000000000000001,"createdAt":',
      ),
    ];
    for (const input of inputs) {
      expect(input).not.toBe(raw);
      const parser = vi.spyOn(JSON, "parse");
      const digest = vi.spyOn(crypto.subtle, "digest");
      try {
        await expect(derive("personal", input)).rejects.toThrow(
          "context is unavailable",
        );
        expect(
          parser.mock.calls.filter(([value]) =>
            /^(?:\{|\[)/.test(value.trimStart()),
          ),
        ).toHaveLength(0);
        expect(digest).not.toHaveBeenCalled();
      } finally {
        parser.mockRestore();
        digest.mockRestore();
      }
    }
  });
  it("bounds raw characters/UTF-8 before any token parse or digest and preserves the exact accepted boundary", async () => {
    const raw = JSON.stringify(header);
    const expected = await context();
    expect(
      await derive(
        "personal",
        raw.padEnd(MAX_RETIRED_CONTEXT_HEADER_BYTES, " "),
      ),
    ).toEqual(expected);
    for (const input of [
      raw.padEnd(MAX_RETIRED_CONTEXT_HEADER_BYTES + 1, " "),
      `"${"é".repeat(MAX_RETIRED_CONTEXT_HEADER_BYTES / 2)}"`,
      '"bad\ud800"',
      `${"[".repeat(9)}0${"]".repeat(9)}`,
    ]) {
      const parser = vi.spyOn(JSON, "parse");
      const digest = vi.spyOn(crypto.subtle, "digest");
      try {
        await expect(derive("personal", input)).rejects.toThrow(
          "context is unavailable",
        );
        expect(parser).not.toHaveBeenCalled();
        expect(digest).not.toHaveBeenCalled();
      } finally {
        parser.mockRestore();
        digest.mockRestore();
      }
    }
  });
  it("refuses an escaped malformed Unicode token before whole-document parse or digest", async () => {
    const parser = vi.spyOn(JSON, "parse");
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const input = JSON.stringify(header).replace(
        '"createdAt":',
        '"hint":"bad\\ud800","createdAt":',
      );
      await expect(derive("personal", input)).rejects.toThrow(
        "context is unavailable",
      );
      expect(
        parser.mock.calls.filter(([value]) =>
          /^(?:\{|\[)/.test(value.trimStart()),
        ),
      ).toHaveLength(0);
      expect(digest).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
      digest.mockRestore();
    }
  });
  it("refuses JavaScript caller objects before reading properties or invoking the parser", async () => {
    let getterRead = false;
    const input = {
      get protection(): never {
        getterRead = true;
        throw new Error("unbounded caller getter");
      },
    };
    const parser = vi.spyOn(JSON, "parse");
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      await expect(derive("personal", input)).rejects.toThrow(
        "context is unavailable",
      );
      expect(getterRead).toBe(false);
      expect(parser).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
      digest.mockRestore();
    }
  });
  it("refuses alternate wire spellings, duplicate/unknown fields and invalid scope data", async () => {
    const value = await context();
    const raw = encode(value);
    for (const candidate of [
      `${raw}\n`,
      raw.replace('"v":2', '"v":2,"v":2'),
      JSON.stringify({ ...value, extra: true }),
      raw.replace('"v":2', '"v":2.0'),
      " ".repeat(MAX_RETIRED_CONTEXT_WIRE_BYTES + 1),
    ])
      expect(() => parse(candidate)).toThrow("context is unavailable");
    for (const changed of [
      { v: 1 },
      { purpose: "workload-root" },
      { rootEpoch: -1 },
      { rootEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { generationSha256: "A".repeat(64) },
      { tomb: "../personal" },
      { vaultId: "é".repeat(129) },
      { rootKeyId: "bad\ud800" },
    ])
      expect(() => encode({ ...value, ...changed })).toThrow(
        "context is unavailable",
      );
  });
  it("preserves every own cloud-context key in the genuine MAC and generation preimage", async () => {
    const root = new Uint8Array(32).fill(17);
    const encryptionContext = { constructor: "own-constructor", z: "last" };
    Object.defineProperty(encryptionContext, "__proto__", {
      value: "own-proto",
      enumerable: true,
    });
    const protection = await sealAuthenticatedManifest(root, {
      ...manifestWithoutAuth(header.protection),
      records: [
        ...header.protection.records,
        {
          kind: "aws-kms",
          protectorId: "public-cloud-context-fixture",
          proofStatus: "untested",
          keyArn: "arn:aws:kms:us-east-1:000000000000:key/public-fixture",
          region: "us-east-1",
          connectionId: "public-fixture",
          connectionConfigVersion: "1",
          wrappedSecretB64: btoa("public fixture only"),
          localCapsule: {
            ivB64: btoa("i".repeat(12)),
            ctB64: btoa("c".repeat(48)),
          },
          encryptionContext,
        },
      ],
    });
    const raw = JSON.stringify({ ...header, protection });
    const parsed = readPagesRetiredCredentialHeader(raw);
    const cloud = parsed.protection.records.find((r) => r.kind === "aws-kms");
    if (!cloud || cloud.kind !== "aws-kms")
      throw new Error("Cloud fixture missing");
    expect(Object.hasOwn(cloud.encryptionContext, "__proto__")).toBe(true);
    expect(Object.keys(cloud.encryptionContext).sort()).toEqual([
      "__proto__",
      "constructor",
      "z",
    ]);
    await verifyManifestAuth(root, parsed.protection);
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      await derive("personal", raw);
      const input = digest.mock.calls[0]?.[1];
      if (!(input instanceof Uint8Array))
        throw new Error("Context preimage missing");
      expect(new TextDecoder().decode(input)).toContain(
        '"encryptionContext":{"__proto__":"own-proto","constructor":"own-constructor","z":"last"}',
      );
    } finally {
      digest.mockRestore();
      root.fill(0);
    }
  });
});
