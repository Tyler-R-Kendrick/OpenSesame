import type { JsonObject } from "@opensesame/os-domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AUDIT_METADATA_ALLOWLIST,
  AUDIT_VALUE_MAX_LENGTH,
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

const anyMetadata = fc.dictionary(anyKey, anyValue) as fc.Arbitrary<JsonObject>;

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
          if (typeof value === "string") {
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
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            (Array.isArray(value) &&
              value.every((entry) => typeof entry === "string"));
          expect(ok).toBe(true);
        }
      }),
    );
  });
});
