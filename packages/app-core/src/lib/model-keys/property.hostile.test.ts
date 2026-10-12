/**
 * Properties, not examples: no input — however malformed — ends in anything
 * but a result or a typed refusal, and what passes stays inside the contract
 * the parsers state. (That no key holds more than the key it came from is
 * `property.conservation.test.ts`.)
 */
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseModelAccessDetails } from "./details.js";
import { ModelKeyRefusal } from "./errors.js";
import { inspectCall } from "./protocols.js";
import { parseExchangeRequest } from "./request.js";
import { canonicalResource } from "./resource.js";

describe("whatever arrives, the answer is a result or a refusal", () => {
  // fast-check types what it generates as `unknown`; every value it yields is
  // hostile input at the boundary the parsers guard, so it is typed as that.
  const anything: fc.Arbitrary<BoundaryValue> = fc
    .anything({
      maxDepth: 3,
      withBigInt: true,
      withBoxedValues: true,
      withNullPrototype: true,
      withSparseArray: true,
    })
    .map((value) => overlapCast(value));

  it("for any exchange request", () => {
    fc.assert(
      fc.property(anything, (input) => {
        try {
          parseExchangeRequest(input);
        } catch (error) {
          expect(error).toBeInstanceOf(ModelKeyRefusal);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("for exchange parameters built from the names that are defined", () => {
    const value = fc.oneof(
      fc.string(),
      fc.constantFrom(
        "model.invoke",
        "model.list",
        "urn:ietf:params:oauth:grant-type:token-exchange",
        "urn:ietf:params:oauth:token-type:access_token",
        `osk_${"A".repeat(43)}`,
        '[{"type":"model_access"}]',
      ),
    );
    const names = [
      "grant_type",
      "subject_token",
      "subject_token_type",
      "requested_token_type",
      "resource",
      "audience",
      "scope",
      "authorization_details",
      "dpop_jkt",
    ];
    fc.assert(
      fc.property(
        fc.record(
          Object.fromEntries(
            names.map((name) => [name, fc.option(value, { nil: undefined })]),
          ),
        ),
        (params) => {
          try {
            parseExchangeRequest(
              Object.fromEntries(
                Object.entries(params).filter(([, v]) => v !== undefined),
              ),
            );
          } catch (error) {
            expect(error).toBeInstanceOf(ModelKeyRefusal);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("for any authorization details", () => {
    fc.assert(
      fc.property(fc.array(anything, { maxLength: 3 }), (details) => {
        try {
          const parsed = parseModelAccessDetails(details);
          for (const model of parsed.models ?? [])
            expect(model).toMatch(
              /^(?:\*|[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*(?:\/\*)?)$/,
            );
          for (const value of Object.values(parsed.budget ?? {}))
            expect(
              Number.isSafeInteger(value) &&
                value >= 0 &&
                value <= 1_000_000_000,
            ).toBe(true);
          if (parsed.lifetimeSeconds !== null)
            expect(parsed.lifetimeSeconds).toBeGreaterThan(0);
        } catch (error) {
          expect(error).toBeInstanceOf(ModelKeyRefusal);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("for any call, and anything that passes stays inside the protocol", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "openai_chat",
          "anthropic_messages",
          "gemini_generate_content",
        ),
        fc.constantFrom("invoke", "list"),
        fc.string(),
        fc.string(),
        anything,
        (protocol, operation, method, path, body) => {
          try {
            const inspected = inspectCall({
              protocol,
              baseUrl: "https://api.example.com/v1",
              operation,
              method,
              path,
              body,
            });
            expect(
              inspected.url.startsWith("https://api.example.com/v1/"),
            ).toBe(true);
            expect(["GET", "POST"]).toContain(inspected.method);
            const route = inspected.url.slice(
              "https://api.example.com/v1".length,
            );
            expect(route).toMatch(
              /^\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/,
            );
            expect(route.split("/")).not.toContain("..");
            expect(route.split("/")).not.toContain(".");
            if (inspected.action === "model.invoke") {
              expect(Number.isSafeInteger(inspected.outputTokens)).toBe(true);
              expect(inspected.model).toMatch(
                /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/,
              );
              expect(inspected.body).not.toBeNull();
            }
          } catch (error) {
            expect(error).toBeInstanceOf(ModelKeyRefusal);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("for any resource, and a resource that passes is exactly what was written", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          anything,
          fc.string(),
          fc.webUrl(),
          fc.constantFrom(
            "https://api.openai.com/v1",
            "https://API.openai.com/v1",
          ),
        ),
        (value) => {
          try {
            const canonical = canonicalResource(value);
            expect(canonical).toBe(value);
            expect(canonical).toMatch(
              /^https:\/\/[a-z0-9.-]+(?:\/[^?#\\%\s]*)?$/,
            );
            expect(canonical.endsWith("/")).toBe(false);
            expect(new URL(canonical).host).toBe(
              canonical.slice("https://".length).split("/")[0],
            );
          } catch (error) {
            expect(error).toBeInstanceOf(ModelKeyRefusal);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });
});
