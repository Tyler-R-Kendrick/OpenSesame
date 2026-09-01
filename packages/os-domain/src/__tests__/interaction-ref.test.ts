import { describe, expect, it } from "vitest";
import {
  bindingMessageDigest,
  interactionRef,
  mintInteractionRef,
  resolveInteractionRef,
} from "../crypto/interaction-ref.js";
import { FORBIDDEN_URL_PARAMS } from "../interaction-links.js";

const PEPPER = "test-pepper-not-a-real-deployment-secret";
const OTHER_PEPPER = "a-different-deployment";

describe("interaction references", () => {
  it("round-trips a minted reference", () => {
    const { id, ref } = mintInteractionRef(PEPPER);
    expect(ref.startsWith("i_")).toBe(true);
    expect(resolveInteractionRef(ref, PEPPER)).toBe(id);
  });

  it("mints an unguessable id every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(mintInteractionRef(PEPPER).id);
    expect(seen.size).toBe(500);
    // 18 random bytes, base64url: 24 characters after the `int_` tag.
    expect(mintInteractionRef(PEPPER).id).toMatch(/^int_[A-Za-z0-9_-]{24}$/);
  });

  it("refuses a reference minted under another pepper", () => {
    const { ref } = mintInteractionRef(OTHER_PEPPER);
    expect(resolveInteractionRef(ref, PEPPER)).toBeNull();
  });

  it("refuses a forged tag on a real id", () => {
    const { id, ref } = mintInteractionRef(PEPPER);
    const [body] = ref.slice(2).split(".");
    const forged = `i_${body}.${"A".repeat(32)}`;
    expect(resolveInteractionRef(forged, PEPPER)).toBeNull();
    // The genuine one still works, so the refusal was about the tag.
    expect(resolveInteractionRef(interactionRef(id, PEPPER), PEPPER)).toBe(id);
  });

  it("answers null rather than throwing for every malformed shape", () => {
    const hostile = [
      "",
      "i_",
      "i_.",
      "i_..",
      "not-a-ref",
      "i_!!!!.####",
      `i_${Buffer.from("int_x").toString("base64url")}`,
      `i_${Buffer.from("wrong_prefix").toString("base64url")}.${"a".repeat(32)}`,
      `i_${"A".repeat(5000)}.${"b".repeat(32)}`,
    ];
    for (const value of hostile) {
      expect(resolveInteractionRef(value, PEPPER)).toBeNull();
    }
  });

  it("gives one interaction exactly one spelling", () => {
    const { id, ref } = mintInteractionRef(PEPPER);
    // A padded base64 body decodes to the same id but is not the reference we
    // minted, so it must not resolve: two spellings would split caches and
    // audit trails for one interaction.
    const padded = `i_${Buffer.from(id, "utf8").toString("base64")}.${ref.split(".")[1]}`;
    if (padded !== ref) {
      expect(resolveInteractionRef(padded, PEPPER)).toBeNull();
    }
  });

  it("keeps the binding-message digest keyed and stable", () => {
    const a = bindingMessageDigest("Pay 143.72 USD to Example Vendor", PEPPER);
    const b = bindingMessageDigest("Pay 143.72 USD to Example Vendor", PEPPER);
    const c = bindingMessageDigest("Pay 143.73 USD to Example Vendor", PEPPER);
    const d = bindingMessageDigest(
      "Pay 143.72 USD to Example Vendor",
      OTHER_PEPPER,
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).not.toContain("Example Vendor");
  });
});

describe("the forbidden-parameter deny list", () => {
  it("names every credential family a link could carry", () => {
    for (const name of [
      "access_token",
      "refresh_token",
      "id_token",
      "device_code",
      "client_secret",
      "claim_token",
      "vp_token",
      "password",
      "cvv",
      "pan",
    ]) {
      expect(FORBIDDEN_URL_PARAMS).toContain(name);
    }
  });

  it("is lowercase and duplicate-free, so callers can match on it directly", () => {
    expect(new Set(FORBIDDEN_URL_PARAMS).size).toBe(
      FORBIDDEN_URL_PARAMS.length,
    );
    for (const name of FORBIDDEN_URL_PARAMS) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});
