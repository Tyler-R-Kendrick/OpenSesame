import { describe, expect, it } from "vitest";
import { assertMalformedDenied, assertNoSecretFields } from "./oracles.js";
import { type JsonObject, overlapCast, type BoundaryValue } from "@opensesame/os-domain";

const identity = (v: BoundaryValue): BoundaryValue => v;

describe("assertNoSecretFields", () => {
  it("passes when the redactor masks secret-looking keys", () => {
    const redact = (v: BoundaryValue): BoundaryValue => {
      const input = overlapCast(v);
      const out: JsonObject = {};
      for (const [k, val] of Object.entries(input)) {
        out[k] = k.includes("token") ? "[REDACTED]" : val;
      }
      return out;
    };
    expect(() =>
      assertNoSecretFields({ access_token: "x", action: "login" }, redact),
    ).not.toThrow();
  });

  it("throws when a secret-looking key survives with a non-empty string", () => {
    expect(() =>
      assertNoSecretFields({ client_secret: "hunter2" }, identity),
    ).toThrow(/secret field client_secret survived redaction/);
  });

  it("matches secret needles case-insensitively", () => {
    expect(() => assertNoSecretFields({ PASSWORD: "x" }, identity)).toThrow(
      /PASSWORD/,
    );
  });

  it("ignores empty strings and non-string values on secret-looking keys", () => {
    expect(() =>
      assertNoSecretFields({ token: "", password: 42, cookie: null }, identity),
    ).not.toThrow();
  });

  it("walks nested objects to find surviving secrets", () => {
    const nested = { outer: { inner: { refresh_token: "r" } } };
    expect(() => assertNoSecretFields(nested, identity)).toThrow(
      /refresh_token/,
    );
  });

  it("ignores keys that do not look secret", () => {
    expect(() =>
      assertNoSecretFields({ action: "token", reason: "secret" }, identity),
    ).not.toThrow();
  });

  it("handles non-object redaction results", () => {
    expect(() => assertNoSecretFields("payload", () => null)).not.toThrow();
    expect(() =>
      assertNoSecretFields({ token: "t" }, () => "masked"),
    ).not.toThrow();
  });
});

describe("assertMalformedDenied", () => {
  it("throws with the given reason when the operation succeeded", () => {
    expect(() =>
      assertMalformedDenied(true, "malformed input accepted"),
    ).toThrow("malformed input accepted");
  });

  it("passes when the operation was denied", () => {
    expect(() => assertMalformedDenied(false, "unreachable")).not.toThrow();
  });
});
