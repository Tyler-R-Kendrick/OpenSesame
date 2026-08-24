import {
  type JsonObject,
  isBoolean,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AUDIT_METADATA_ALLOWLIST,
  AUDIT_VALUE_MAX_LENGTH,
  isDeniedAuditMetadataKey,
  redactAuditMetadata,
} from "../redact.js";

/**
 * Redaction is the last thing standing between a caller-supplied metadata bag
 * and a durable audit row. Its example tests cover the keys we thought of;
 * these cover the ones we did not. Every property below is stated over
 * arbitrary objects, including keys and values no fixture would contain.
 */

const DENY_SUBSTRINGS = [
  "value",
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "code_verifier",
  "refresh",
  "bearer",
];

/** Keys drawn from the allowlist, deny patterns, and arbitrary noise alike. */
const anyKey = fc.oneof(
  fc.constantFrom(...AUDIT_METADATA_ALLOWLIST),
  fc.constantFrom(...DENY_SUBSTRINGS),
  fc.constantFrom(
    ...DENY_SUBSTRINGS.map((deny) => `request${deny.toUpperCase()}`),
  ),
  fc.string(),
);

const anyValue = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string()),
  fc.array(fc.oneof(fc.string(), fc.integer())),
  fc.dictionary(fc.string(), fc.string()),
);

const anyMetadata = fc.dictionary(
  anyKey,
  anyValue,
) satisfies fc.Arbitrary<JsonObject>;

describe("redactAuditMetadata properties", () => {
  it("never emits a key outside the allowlist", () => {
    fc.assert(
      fc.property(anyMetadata, (metadata) => {
        for (const key of Object.keys(redactAuditMetadata(metadata))) {
          expect(AUDIT_METADATA_ALLOWLIST.has(key)).toBe(true);
        }
      }),
    );
  });

  it("never emits a key matching a deny pattern", () => {
    fc.assert(
      fc.property(anyMetadata, (metadata) => {
        for (const key of Object.keys(redactAuditMetadata(metadata))) {
          for (const deny of DENY_SUBSTRINGS) {
            expect(key.toLowerCase()).not.toContain(deny);
          }
        }
      }),
    );
  });

  it("bounds every emitted string, including inside arrays", () => {
    // An unbounded value is an audit store that grows for as long as a caller
    // keeps sending. The ellipsis adds one character to a truncated value.
    const ceiling = AUDIT_VALUE_MAX_LENGTH + 1;
    fc.assert(
      fc.property(anyMetadata, (metadata) => {
        for (const value of Object.values(redactAuditMetadata(metadata))) {
          if (isString(value)) {
            expect(value.length).toBeLessThanOrEqual(ceiling);
          } else if (Array.isArray(value)) {
            for (const entry of value) {
              expect(String(entry).length).toBeLessThanOrEqual(ceiling);
            }
          }
        }
      }),
    );
  });

  it("is idempotent", () => {
    // Redacted output is sometimes re-redacted on its way through a pipeline;
    // a second pass must not truncate or drop anything further.
    fc.assert(
      fc.property(anyMetadata, (metadata) => {
        const once = redactAuditMetadata(metadata);
        expect(redactAuditMetadata(once)).toEqual(once);
      }),
    );
  });

  it("ignores denied keys entirely rather than letting them influence output", () => {
    fc.assert(
      fc.property(
        anyMetadata,
        fc.constantFrom(...DENY_SUBSTRINGS),
        fc.string(),
        (metadata, deniedKey, injected) => {
          const clean = redactAuditMetadata(metadata);
          const polluted = redactAuditMetadata({
            ...metadata,
            [deniedKey]: injected,
          });
          // Adding a secret-shaped key changes nothing that gets stored.
          expect(polluted).toEqual(clean);
        },
      ),
    );
  });

  it("emits only JSON-safe scalars, arrays of strings, or null", () => {
    fc.assert(
      fc.property(anyMetadata, (metadata) => {
        for (const value of Object.values(redactAuditMetadata(metadata))) {
          const ok =
            value === null ||
            isString(value) ||
            isNumber(value) ||
            isBoolean(value) ||
            (Array.isArray(value) && value.every(isString));
          expect(ok).toBe(true);
        }
      }),
    );
  });
});

/**
 * The expected allowlist, written out rather than derived from the Set under
 * test. An earlier version of this test iterated AUDIT_METADATA_ALLOWLIST
 * itself, which made it self-confirming: blanking an entry to "" simply meant
 * the loop tested "" and passed. Mutation testing caught that — 16 string
 * literals survived. Any change here should be a deliberate edit in both
 * places.
 */
const EXPECTED_ALLOWLIST = [
  "reason",
  "action",
  "kind",
  "issuer",
  "tenant",
  "via",
  "slug",
  "note",
  "sectorIdentifier",
  "admissionMode",
  "previousClientId",
  "resourceType",
  "resourceId",
  "projectId",
  "organizationId",
  "claimId",
  "agentId",
  "state",
  "fromState",
  "toState",
  "outcome",
  "idempotencyKey",
  "ttlSeconds",
  "quotaProfile",
  "path",
  "method",
  "statusCode",
  "won",
  "count",
  "type",
  "configId",
  "environment",
  "keyNames",
  "versionId",
  "targetId",
  "contentVersion",
  "actor",
  "authReqId",
  "approvalId",
  "requestDigest",
  "bindingMessageDigest",
  "decidedByKind",
  "connectionId",
  "delegationId",
  "offerId",
  "invocationId",
  "subject",
  "providerId",
  "materialization",
] as const;

describe("allowlist and deny layers", () => {
  it("holds exactly the expected keys", () => {
    expect([...AUDIT_METADATA_ALLOWLIST].sort()).toEqual(
      [...EXPECTED_ALLOWLIST].sort(),
    );
  });

  it("passes every expected key through", () => {
    for (const key of EXPECTED_ALLOWLIST) {
      expect(isDeniedAuditMetadataKey(key)).toBe(false);
      expect(redactAuditMetadata({ [key]: "kept" })).toEqual({ [key]: "kept" });
    }
  });

  it("keeps string arrays, which is how keyNames travels", () => {
    expect(redactAuditMetadata({ keyNames: ["API_KEY", "DB_URL"] })).toEqual({
      keyNames: ["API_KEY", "DB_URL"],
    });
    // A mixed array is not a name list, so it is dropped rather than coerced.
    expect(redactAuditMetadata({ keyNames: ["API_KEY", 7] })).toEqual({});
  });

  it("preserves an explicit null rather than dropping the key", () => {
    // A recorded null says "this was absent"; dropping the key says nothing
    // was recorded. Those read differently to a reviewer.
    expect(redactAuditMetadata({ note: null })).toEqual({ note: null });
    expect(Object.hasOwn(redactAuditMetadata({ note: null }), "note")).toBe(
      true,
    );
  });

  it("truncates only past the ceiling, not at it", () => {
    const atCeiling = "a".repeat(AUDIT_VALUE_MAX_LENGTH);
    const overCeiling = "a".repeat(AUDIT_VALUE_MAX_LENGTH + 1);
    expect(redactAuditMetadata({ note: atCeiling })).toEqual({
      note: atCeiling,
    });
    expect(redactAuditMetadata({ note: overCeiling }).note).toBe(
      `${"a".repeat(AUDIT_VALUE_MAX_LENGTH)}\u2026`,
    );
  });

  it("refuses secret-shaped keys, separator or not", () => {
    // This layer is redundant with the allowlist today, so it is asserted
    // directly: through redactAuditMetadata these keys are dropped either way,
    // and a weakened pattern would change nothing observable.
    for (const key of [
      "value",
      "accessToken",
      "client_secret",
      "PASSWORD",
      "authorization",
      "Cookie",
      "code_verifier",
      "user_code",
      "usercode",
      "userCode",
      "device_code",
      "devicecode",
      "deviceCode",
      "refresh_token",
      "bearer",
    ]) {
      expect(isDeniedAuditMetadataKey(key)).toBe(true);
      expect(redactAuditMetadata({ [key]: "leak" })).toEqual({});
    }
  });

  it("does not refuse ordinary allowlisted keys by accident", () => {
    for (const key of ["reason", "action", "slug", "projectId", "outcome"]) {
      expect(isDeniedAuditMetadataKey(key)).toBe(false);
    }
  });
});
