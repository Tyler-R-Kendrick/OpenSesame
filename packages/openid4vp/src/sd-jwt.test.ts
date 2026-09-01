/**
 * Disclosure handling, attacked directly.
 *
 * These are the four rules from the module header, each with the forgery it
 * exists to stop. They are unit tests rather than end-to-end ones because the
 * interesting inputs — a disclosure that matches nothing, a digest listed
 * twice, a disclosure aimed at a plaintext claim — are ones an honest issuer
 * would never produce, so there is no way to reach them through the fixture
 * wallet.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  type JsonObject,
  type JsonValue,
  overlapCast,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { parseSdJwt, readDisclosures, resolveDisclosures } from "./sd-jwt.js";

function disclose(name: string | null, value: JsonValue): string {
  const salt = randomBytes(16).toString("base64url");
  const body = name === null ? [salt, value] : [salt, name, value];
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

function digest(disclosure: string): string {
  return createHash("sha256")
    .update(Buffer.from(disclosure, "utf8"))
    .digest("base64url");
}

describe("parseSdJwt", () => {
  it("distinguishes an SD-JWT from an SD-JWT+KB by the final element", () => {
    expect(parseSdJwt("h.p.s~a~b~").keyBindingJwt).toBeNull();
    expect(parseSdJwt("h.p.s~a~b~k.b.j").keyBindingJwt).toBe("k.b.j");
  });

  it("reconstructs exactly the region sd_hash covers", () => {
    const parsed = parseSdJwt("h.p.s~a~b~k.b.j");
    expect(parsed.keyBindingInput).toBe("h.p.s~a~b~");
    expect(parsed.disclosures).toEqual(["a", "b"]);
  });

  it("refuses an empty disclosure slot", () => {
    expect(() => parseSdJwt("h.p.s~~b~")).toThrow();
    expect(() => parseSdJwt("nolotildes")).toThrow();
  });
});

describe("readDisclosures", () => {
  it("refuses a disclosure claiming a reserved name", () => {
    expect(() =>
      readDisclosures([disclose("_sd", ["x"])], "sha-256"),
    ).toThrow();
    expect(() => readDisclosures([disclose("...", "x")], "sha-256")).toThrow();
  });

  it("refuses two identical disclosures", () => {
    const one = disclose("given_name", "Ada");
    expect(() => readDisclosures([one, one], "sha-256")).toThrow();
  });

  it("refuses a disclosure named __proto__", () => {
    // `out["__proto__"] = value` on an object literal runs the inherited setter
    // instead of defining a property: the claim never becomes an own property,
    // it replaces the prototype. Rule 4's collision check is then structurally
    // unreachable for this one name, because `Object.hasOwn(out, "__proto__")`
    // can never become true however much was assigned.
    expect(() =>
      readDisclosures([disclose("__proto__", { isAdmin: true })], "sha-256"),
    ).toThrow();
  });

  it("refuses an array with the wrong arity", () => {
    const bad = Buffer.from(
      JSON.stringify(["salt", "a", "b", "c"]),
      "utf8",
    ).toString("base64url");
    expect(() => readDisclosures([bad], "sha-256")).toThrow();
  });
});

describe("resolveDisclosures", () => {
  it("substitutes disclosed claims and drops undisclosed and decoy digests", () => {
    const given = disclose("given_name", "Ada");
    const withheld = disclose("family_name", "Lovelace");
    const payload: JsonObject = {
      iss: "https://issuer.example",
      _sd: [digest(given), digest(withheld), digest(disclose("decoy", 1))],
      _sd_alg: "sha-256",
    };
    const resolved = resolveDisclosures(
      payload,
      readDisclosures([given], "sha-256"),
    );
    expect(resolved).toEqual({
      iss: "https://issuer.example",
      given_name: "Ada",
    });
  });

  it("refuses a disclosure nothing in the payload references", () => {
    // The smuggling case: a claim the issuer never digested, riding along in
    // the hope the verifier reads disclosures rather than digests.
    const smuggled = disclose("clearance", "top_secret");
    const payload: JsonObject = { iss: "x", _sd: [] };
    expect(() =>
      resolveDisclosures(payload, readDisclosures([smuggled], "sha-256")),
    ).toThrow();
  });

  it("refuses a digest listed twice", () => {
    const given = disclose("given_name", "Ada");
    const payload: JsonObject = { _sd: [digest(given), digest(given)] };
    expect(() =>
      resolveDisclosures(payload, readDisclosures([given], "sha-256")),
    ).toThrow();
  });

  it("refuses a disclosure that would overwrite a plaintext claim", () => {
    const forged = disclose("iss", "https://attacker.example");
    const payload: JsonObject = {
      iss: "https://issuer.example",
      _sd: [digest(forged)],
    };
    expect(() =>
      resolveDisclosures(payload, readDisclosures([forged], "sha-256")),
    ).toThrow();
  });

  it("refuses an object disclosure used in an array slot and vice versa", () => {
    const objectDisclosure = disclose("nationality", "GB");
    const arrayPayload: JsonObject = {
      nationalities: [{ "...": digest(objectDisclosure) }],
    };
    expect(() =>
      resolveDisclosures(
        arrayPayload,
        readDisclosures([objectDisclosure], "sha-256"),
      ),
    ).toThrow();

    const arrayDisclosure = disclose(null, "GB");
    const objectPayload: JsonObject = { _sd: [digest(arrayDisclosure)] };
    expect(() =>
      resolveDisclosures(
        objectPayload,
        readDisclosures([arrayDisclosure], "sha-256"),
      ),
    ).toThrow();
  });

  it("resolves array elements and nested structures", () => {
    const element = disclose(null, "GB");
    const nested = disclose("street", "1 Main St");
    const payload: JsonObject = {
      nationalities: [{ "...": digest(element) }, "FR"],
      address: { _sd: [digest(nested)], city: "London" },
    };
    const resolved = resolveDisclosures(
      payload,
      readDisclosures([element, nested], "sha-256"),
    );
    expect(resolved).toEqual({
      nationalities: ["GB", "FR"],
      address: { city: "London", street: "1 Main St" },
    });
  });

  it("refuses a plaintext claim named __proto__ at any depth", () => {
    // Parsed rather than written as a literal: an object literal with that key
    // sets this test's own prototype, so `JSON.parse` is the only way to build
    // the own property an issuer would actually have signed — and is also how
    // the payload reaches the resolver in production.
    const shallow: JsonObject = overlapCast(
      JSON.parse('{"iss":"x","__proto__":{"isAdmin":true}}'),
    );
    expect(() => resolveDisclosures(shallow, [])).toThrow();

    const nested: JsonObject = overlapCast(
      JSON.parse('{"iss":"x","address":{"__proto__":{"isAdmin":true}}}'),
    );
    expect(() => resolveDisclosures(nested, [])).toThrow();
  });

  it("refuses a disclosure whose value smuggles __proto__", () => {
    const forged = disclose(
      "address",
      overlapCast(JSON.parse('{"__proto__":{"isAdmin":true}}')),
    );
    const payload: JsonObject = { _sd: [digest(forged)] };
    expect(() =>
      resolveDisclosures(payload, readDisclosures([forged], "sha-256")),
    ).toThrow();
  });

  it("returns a claim set whose every reachable property is listed", () => {
    // The observable the refusals above protect: before them, a resolved claim
    // set could answer `claims.isAdmin` with a value that appeared in no
    // `Object.keys` listing and in no `JSON.stringify` output.
    const given = disclose("given_name", "Ada");
    const payload: JsonObject = { iss: "x", _sd: [digest(given)] };
    const resolved = resolveDisclosures(
      payload,
      readDisclosures([given], "sha-256"),
    );
    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
  });

  it("refuses an array digest object carrying sibling members", () => {
    const element = disclose(null, "GB");
    const payload: JsonObject = {
      nationalities: [{ "...": digest(element), extra: "smuggled" }],
    };
    // The `...` object is not recognized, so the disclosure goes unused and
    // the whole presentation is refused rather than the extra silently kept.
    expect(() =>
      resolveDisclosures(payload, readDisclosures([element], "sha-256")),
    ).toThrow();
  });
});
