import { overlapCast } from "@opensesame/os-domain";
import {
  type VaultHeader,
  createVault,
  rewrapVaultKey,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "../vault/protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "../vault/protection/migrate-legacy.js";
import {
  deriveRetiredVerifier,
  verifyRetiredPassword,
} from "./argon-verifier.js";
import {
  type RetiredCredentialContextV2,
  deriveRetiredCredentialContextV2,
  encodeRetiredCredentialContextV2,
} from "./context-v2.js";
import vectors from "./fixtures/records-v2-pages-vectors.json";
import protocols from "./protocol-vectors.json";
import {
  RETIRED_CREDENTIAL_MATCHING_V2 as MATCHING,
  MAX_RETIRED_RECORDS_V2_BYTES,
  type RecordsV2,
  encodeRetiredCredentialRecordsV2 as encode,
  parseRetiredCredentialRecordsV2 as parse,
} from "./records-v2.js";
const AT = "2026-10-08T00:00:00.000Z";
const PASSWORD = "records original owner 47283";
const retired = required(protocols.vectors[0]);
let header: VaultHeader;
let context: RetiredCredentialContextV2;
let wire: string;
let verifier: string;
let root: Uint8Array;
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function modern(
  h: VaultHeader,
  raw: Uint8Array,
  prior?: RetiredCredentialContextV2,
): Promise<VaultHeader> {
  const manifest = migrateLegacyHeaderToManifest({
    header: h,
    passkeyRpId: "owner.example.invalid",
    vaultId: prior?.vaultId,
    rootKeyId: prior?.rootKeyId,
    rootEpoch: prior?.rootEpoch,
  }).manifest;
  return { ...h, protection: await sealAuthenticatedManifest(raw, manifest) };
}
beforeAll(async () => {
  const made = await createVault(PASSWORD);
  root = made.rawVaultKey;
  header = await modern(made.header, root);
  await verifyManifestAuth(root, required(header.protection));
  context = await deriveRetiredCredentialContextV2(
    "personal",
    JSON.stringify(header),
  );
  wire = encodeRetiredCredentialContextV2(context);
  verifier = await deriveRetiredVerifier(
    retired.password,
    decode(retired.saltB64),
  );
  expect(verifier).toBe(retired.verifierB64);
}, 30000);
function records(): RecordsV2 {
  return {
    v: 2,
    context,
    matching: { ...MATCHING },
    traps: [
      {
        id: "old",
        createdAt: AT,
        expiresAt: "2027-01-06T00:00:00.000Z",
        response: "reject",
        salt: retired.saltB64,
        verifier,
      },
    ],
    events: [
      {
        type: "retired_credential_observed",
        trapId: "old",
        at: AT,
        response: "reject",
      },
    ],
  };
}
function refused<T>(value: T, expected = wire): void {
  expect(() => parse(JSON.stringify(value), expected)).toThrow(
    "records are unavailable",
  );
}
describe("inactive Pages RecordsV2 data boundary", () => {
  it("retains genuine fixed-cost verifier bytes without granting owner authority", async () => {
    const result = parse(JSON.stringify(records()), wire);
    expect(result).toEqual(records());
    expect(await unwrapRawVaultKeyFromPassword(header, PASSWORD)).toEqual(root);
    expect(
      await verifyRetiredPassword(
        retired.password,
        decode(required(result.traps[0]).salt),
        decode(required(result.traps[0]).verifier),
      ),
    ).toBe(true);
    expect(
      await verifyRetiredPassword(
        PASSWORD,
        decode(required(result.traps[0]).salt),
        decode(required(result.traps[0]).verifier),
      ),
    ).toBe(false);
    expect(parse(encode(JSON.stringify(result), wire), wire)).toEqual(result);
  }, 30000);
  it.each(vectors.vectors)(
    "reads the shared $name context and strict non-destructive event shapes",
    (vector) => {
      const value = parse(vector.recordJson, vector.expectedContextWire);
      expect(value.context.format).toBe("pages-auth-header-v1");
      expect(value.matching).toEqual(MATCHING);
      expect(required(value.traps[0]).verifier).toBe(retired.verifierB64);
      expect(value.events[1]).toMatchObject({
        type: "synthetic_decoy_interaction",
        action: "authority_denied",
      });
      expect(
        parse(
          encode(vector.recordJson, vector.expectedContextWire),
          vector.expectedContextWire,
        ),
      ).toEqual(value);
    },
  );
  it("refuses old records after a different owner restores the same tomb with the retired password as current", async () => {
    const other = await createVault(retired.password);
    const next = await modern(other.header, other.rawVaultKey);
    await verifyManifestAuth(other.rawVaultKey, required(next.protection));
    expect(await unwrapRawVaultKeyFromPassword(next, retired.password)).toEqual(
      other.rawVaultKey,
    );
    const replacement = await deriveRetiredCredentialContextV2(
      "personal",
      JSON.stringify(next),
    );
    expect(replacement.tomb).toBe(context.tomb);
    expect(replacement.vaultId).not.toBe(context.vaultId);
    expect(replacement.rootKeyId).not.toBe(context.rootKeyId);
    refused(records(), encodeRetiredCredentialContextV2(replacement));
  }, 30000);
  it("refuses stale generation after genuine rewrap even when the vault/root identity is preserved", async () => {
    const next = await modern(
      await rewrapVaultKey(
        header,
        PASSWORD,
        "replacement owner password 84723",
      ),
      root,
      context,
    );
    await verifyManifestAuth(root, required(next.protection));
    const changed = await deriveRetiredCredentialContextV2(
      "personal",
      JSON.stringify(next),
    );
    expect(changed.vaultId).toBe(context.vaultId);
    expect(changed.rootKeyId).toBe(context.rootKeyId);
    expect(changed.rootEpoch).toBe(context.rootEpoch);
    expect(changed.generationSha256).not.toBe(context.generationSha256);
    refused(records(), encodeRetiredCredentialContextV2(changed));
  }, 30000);
  it("compares every context member exactly and never stamps tomb-only V1 or another format", () => {
    for (const changed of [
      { tomb: "Personal" },
      { vaultId: `${context.vaultId}x` },
      { rootKeyId: `${context.rootKeyId}x` },
      { rootEpoch: context.rootEpoch + 1 },
      { generationSha256: "0".repeat(64) },
    ])
      refused(
        records(),
        encodeRetiredCredentialContextV2({ ...context, ...changed }),
      );
    refused({ v: 1, tomb: "personal", traps: records().traps, events: [] });
    for (const changed of [
      { format: "native-root-manifest-v1" },
      { format: undefined },
      { purpose: "workload-root" },
      { ownerPermit: true },
    ])
      refused({ ...records(), context: { ...context, ...changed } });
  });
  it("requires every exact matching literal and rejects tuning or normalization policy", () => {
    for (const changed of [
      { encoding: "utf16" },
      { normalization: "NFKC" },
      { algorithm: "argon2i" },
      { version: 16 },
      { memoryKiB: 8192 },
      { iterations: 1 },
      { parallelism: 2 },
      { hashLength: 16 },
      { saltPrefix: "new oracle" },
    ])
      refused({ ...records(), matching: { ...MATCHING, ...changed } });
    refused({ ...records(), matching: undefined });
  });
  it("bounds retention and rejects ambiguity and destructive response fields", () => {
    const value = records();
    value.traps = ["one", "two", "three"].map((id) => ({
      ...required(value.traps[0]),
      id,
    }));
    required(value.traps[1]).response = "synthetic_decoy";
    value.events = Array.from({ length: 32 }, () => required(value.events[0]));
    expect(parse(JSON.stringify(value), wire)).toEqual(value);
    refused({
      ...value,
      traps: [...value.traps, { ...value.traps[0], id: "four" }],
    });
    refused({ ...value, events: [...value.events, value.events[0]] });
    refused({ ...value, traps: [value.traps[0], value.traps[0]] });
    for (const response of [
      "visible_items",
      "freeze",
      "wipe",
      "attacker_confirmed",
    ])
      refused({ ...records(), traps: [{ ...records().traps[0], response }] });
    refused({
      ...records(),
      traps: [{ ...records().traps[0], password: PASSWORD }],
    });
    refused({
      ...records(),
      events: [
        {
          type: "synthetic_decoy_interaction",
          trapId: "old",
          at: AT,
          response: "reject",
          action: "vault_write",
        },
      ],
    });
  });
  it("bounds UTF-8 metadata and demands canonical verifier padding", () => {
    const value = records();
    required(value.traps[0]).id = "🚀".repeat(32);
    expect(parse(JSON.stringify(value), wire)).toEqual(value);
    for (const changed of [
      { id: "🚀".repeat(33) },
      { salt: "AAAAAAAAAAAAAAAAAAAAAB==" },
      { verifier: `${"A".repeat(42)}B=` },
      { createdAt: "not-a-date" },
    ])
      refused({ ...value, traps: [{ ...value.traps[0], ...changed }] });
  });
  it("rejects decoded duplicate keys and rounded integer aliases before document parsing", () => {
    const raw = JSON.stringify(records());
    for (const input of [
      raw.replace('"v":2', '"v":2,"v":2'),
      raw.replace('"rootEpoch":0', '"rootEpoch":0,"rootEpoch":0'),
      raw.replace('"version":19', '"version":19.0000000000000001'),
      raw.replace('"rootEpoch":0', '"rootEpoch":-0'),
    ]) {
      expect(input).not.toBe(raw);
      const parser = vi.spyOn(JSON, "parse");
      try {
        expect(() => parse(input, wire)).toThrow("records are unavailable");
        expect(
          parser.mock.calls.filter(([v]) => /^(?:\{|\[)/.test(v.trimStart())),
        ).toHaveLength(0);
      } finally {
        parser.mockRestore();
      }
    }
  });
  it("bounds raw bytes before allocation and refuses caller objects without traversing them", () => {
    const raw = JSON.stringify(records());
    const bytes = new TextEncoder().encode(raw).length;
    expect(
      parse(raw + " ".repeat(MAX_RETIRED_RECORDS_V2_BYTES - bytes), wire),
    ).toEqual(records());
    const encoder = vi.spyOn(TextEncoder.prototype, "encode");
    let touched = false;
    const object = {
      get context() {
        touched = true;
        throw new Error("getter");
      },
    };
    try {
      expect(() =>
        parse(" ".repeat(MAX_RETIRED_RECORDS_V2_BYTES + 1), wire),
      ).toThrow("records are unavailable");
      const hostile: string = overlapCast(object);
      expect(() => parse(hostile, wire)).toThrow("records are unavailable");
      expect(touched).toBe(false);
      expect(encoder).not.toHaveBeenCalled();
    } finally {
      encoder.mockRestore();
    }
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing genuine fixture value.");
  return value;
}
