import { FORBIDDEN_URL_PARAMS, isJsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  asyncRefusalOf,
  preAuthorizedGrantParameters,
  readString,
} from "./__fixtures__/harness.js";
import { Openid4vciError, type Openid4vciErrorCode } from "./errors.js";
import {
  CREDENTIAL_OFFER_SCHEME,
  type CredentialOfferInput,
  MemoryPreAuthorizedCodeStore,
  PRE_AUTHORIZED_CODE_GRANT_TYPE,
  assertOfferLinkIsClean,
  createCredentialOffer,
} from "./offer.js";

const ISSUER = "https://issuer.example.test";
const OFFER_URI = "https://issuer.example.test/offers/9f2c";

function newOffer(overrides: Partial<CredentialOfferInput> = {}) {
  return createCredentialOffer({
    credentialIssuer: ISSUER,
    credentialConfigurationIds: ["opensesame-holder-binding"],
    offerUri: OFFER_URI,
    ...overrides,
  });
}

async function expectRefusal<T>(
  run: () => T | Promise<T>,
  code: Openid4vciErrorCode,
): Promise<void> {
  const refusal = await asyncRefusalOf(async () => await run());
  expect(refusal.code).toBe(code);
}

describe("createCredentialOffer", () => {
  it("builds an offer object carrying the pre-authorized code", () => {
    const created = newOffer();
    expect(created.offer.credential_issuer).toBe(ISSUER);
    expect(created.offer.credential_configuration_ids).toEqual([
      "opensesame-holder-binding",
    ]);
    const grants = created.offer.grants;
    if (!isJsonObject(grants)) throw new Error("offer has no grants");
    expect(Object.keys(grants)).toEqual([PRE_AUTHORIZED_CODE_GRANT_TYPE]);
    expect(
      readString(
        preAuthorizedGrantParameters(created.offer),
        "pre-authorized_code",
      ),
    ).toBe(created.grant.code);
  });

  it("puts only a reference in the link — never the offer, never the code", () => {
    const created = newOffer();
    expect(created.offerLink.startsWith(CREDENTIAL_OFFER_SCHEME)).toBe(true);

    const query = created.offerLink.slice(created.offerLink.indexOf("?") + 1);
    const params = [...new URLSearchParams(query)];
    expect(params.map(([name]) => name)).toEqual(["credential_offer_uri"]);
    expect(params[0]?.[1]).toBe(OFFER_URI);

    // The by-value form is never emitted, so the code cannot ride the link.
    expect(created.offerLink).not.toContain("credential_offer=");
    expect(created.offerLink).not.toContain(created.grant.code);
    expect(created.offerLink).not.toContain(
      encodeURIComponent(created.grant.code),
    );
  });

  it("emits a link with no parameter name from the shared deny-list", () => {
    const created = newOffer();
    const query = created.offerLink.slice(created.offerLink.indexOf("?") + 1);
    for (const [name] of new URLSearchParams(query)) {
      expect(FORBIDDEN_URL_PARAMS).not.toContain(name.toLowerCase());
    }
  });

  it("mints an unguessable, distinct code per offer", () => {
    const codes = new Set(
      Array.from({ length: 32 }, () => newOffer().grant.code),
    );
    expect(codes.size).toBe(32);
    for (const code of codes) expect(code.length).toBeGreaterThanOrEqual(43);
  });

  it("carries tx_code metadata into the offer but never its value", () => {
    const created = newOffer({
      txCode: { inputMode: "numeric", length: 4, description: "Sent by SMS" },
      txCodeValue: "4821",
    });
    expect(preAuthorizedGrantParameters(created.offer).tx_code).toEqual({
      input_mode: "numeric",
      length: 4,
      description: "Sent by SMS",
    });
    expect(JSON.stringify(created.offer)).not.toContain("4821");
    expect(created.offerLink).not.toContain("4821");
    expect(created.grant.txCodeValue).toBe("4821");
  });

  it("refuses a tx_code advertised without a value, or the reverse", async () => {
    await expectRefusal(
      () => newOffer({ txCode: { length: 4 } }),
      "invalid_offer",
    );
    await expectRefusal(
      () => newOffer({ txCodeValue: "1234" }),
      "invalid_offer",
    );
  });

  it("refuses a cleartext offer URI and an empty configuration list", async () => {
    await expectRefusal(
      () => newOffer({ offerUri: "http://issuer.example.test/offers/1" }),
      "invalid_offer",
    );
    await expectRefusal(
      () => newOffer({ credentialConfigurationIds: [] }),
      "invalid_offer",
    );
  });
});

describe("assertOfferLinkIsClean", () => {
  it.each(FORBIDDEN_URL_PARAMS)("refuses a link carrying ?%s=", (name) => {
    expect(() =>
      assertOfferLinkIsClean(`${CREDENTIAL_OFFER_SCHEME}?${name}=x`, []),
    ).toThrow(Openid4vciError);
  });

  it("refuses a secret hidden in the fragment", () => {
    expect(() =>
      assertOfferLinkIsClean(
        `${CREDENTIAL_OFFER_SCHEME}?credential_offer_uri=https%3A%2F%2Fa.test%2Fo#access_token=x`,
        [],
      ),
    ).toThrow(Openid4vciError);
  });

  it("refuses a secret under a name nobody thought to deny", () => {
    expect(() =>
      assertOfferLinkIsClean(
        `${CREDENTIAL_OFFER_SCHEME}?handoff=s3cret-value`,
        ["s3cret-value"],
      ),
    ).toThrow(Openid4vciError);
  });

  it("refuses a percent-encoded secret", () => {
    expect(() =>
      assertOfferLinkIsClean(
        `${CREDENTIAL_OFFER_SCHEME}?handoff=${encodeURIComponent("a/b+c")}`,
        ["a/b+c"],
      ),
    ).toThrow(Openid4vciError);
  });
});

describe("MemoryPreAuthorizedCodeStore", () => {
  it("redeems a code exactly once", async () => {
    const store = new MemoryPreAuthorizedCodeStore();
    const created = newOffer();
    await store.register(created.grant);

    const redeemed = await store.redeem(created.grant.code);
    expect(redeemed.credentialConfigurationIds).toEqual([
      "opensesame-holder-binding",
    ]);
    await expectRefusal(
      () => store.redeem(created.grant.code),
      "pre_authorized_code_rejected",
    );
  });

  it("refuses an expired code", async () => {
    const store = new MemoryPreAuthorizedCodeStore();
    const start = new Date("2026-01-01T00:00:00Z");
    const created = newOffer({ now: start, ttlSeconds: 60 });
    await store.register(created.grant);
    await expectRefusal(
      () =>
        store.redeem(
          created.grant.code,
          undefined,
          new Date(start.getTime() + 61_000),
        ),
      "pre_authorized_code_rejected",
    );
  });

  it("refuses an unknown code identically to an expired one — no oracle", async () => {
    const store = new MemoryPreAuthorizedCodeStore();
    const start = new Date("2026-01-01T00:00:00Z");
    const created = newOffer({ now: start, ttlSeconds: 60 });
    await store.register(created.grant);
    const later = new Date(start.getTime() + 61_000);

    const expired = await asyncRefusalOf(() =>
      store.redeem(created.grant.code, undefined, later),
    );
    const unknown = await asyncRefusalOf(() =>
      store.redeem("never-minted", undefined, later),
    );

    expect(expired.code).toBe(unknown.code);
    expect(expired.message).toBe(unknown.message);
    expect(expired.wireError).toBe(unknown.wireError);
  });

  it("burns the code on a wrong transaction code, so four digits cannot be guessed", async () => {
    const store = new MemoryPreAuthorizedCodeStore();
    const created = newOffer({ txCode: { length: 4 }, txCodeValue: "4821" });
    await store.register(created.grant);

    await expectRefusal(
      () => store.redeem(created.grant.code, "0000"),
      "pre_authorized_code_rejected",
    );
    await expectRefusal(
      () => store.redeem(created.grant.code, "4821"),
      "pre_authorized_code_rejected",
    );
  });

  it("refuses a transaction code that was never demanded", async () => {
    const store = new MemoryPreAuthorizedCodeStore();
    const created = newOffer();
    await store.register(created.grant);
    await expectRefusal(
      () => store.redeem(created.grant.code, "4821"),
      "pre_authorized_code_rejected",
    );
  });

  it("stays bounded, and refuses to register rather than evict a live grant", async () => {
    const store = new MemoryPreAuthorizedCodeStore(2);
    const first = newOffer();
    const second = newOffer();
    await store.register(first.grant);
    await store.register(second.grant);
    expect(store.size).toBe(2);

    await expectRefusal(
      () => store.register(newOffer().grant),
      "invalid_offer",
    );
    // Both outstanding grants survived the pressure.
    await expect(store.redeem(first.grant.code)).resolves.toBeDefined();
    await expect(store.redeem(second.grant.code)).resolves.toBeDefined();
  });
});
