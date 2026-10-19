/** @vitest-environment node */
import { CONNECT_PLAN_JSON } from "@opensesame/app-core/lib/connect-presets.generated.js";
import { projectNativeStripeIssuingCards } from "@opensesame/app-core/lib/native-api-stripe-issuing.js";
import { describe, expect, it } from "vitest";
import { nativeApiFixture } from "./native-browser-provider-fixtures.mjs";

const issuing = CONNECT_PLAN_JSON.map((text) => JSON.parse(text)).find(
  (plan) => plan.id === "stripe-issuing",
);
describe("Stripe Issuing documented readonly browser fixture", () => {
  it("feeds the actual generated GET/Bearer/version fixture to the strict production projector", () => {
    expect(issuing.refused).toBe(false);
    expect(issuing.methods.map((method) => method.kind)).toEqual(["api-key"]);
    const fixture = nativeApiFixture(issuing);
    expect(fixture.preset.auth).toEqual({
      kind: "header",
      header: "Authorization",
      scheme: "Bearer",
      valueTemplate: null,
    });
    expect(fixture.preset.verify).toMatchObject({
      method: "GET",
      url: "https://api.stripe.com/v1/issuing/cards?limit=20",
      headers: { "Stripe-Version": "2026-09-30.endive" },
      requiredFields: ["object", "data", "has_more", "url"],
    });
    expect(projectNativeStripeIssuingCards(fixture.reply)).toEqual(
      fixture.read.result,
    );
    expect(projectNativeStripeIssuingCards(fixture.read.reply)).toEqual(
      fixture.read.result,
    );
  });
  it("keeps typed card arrays independent between runs", () => {
    const first = nativeApiFixture(issuing);
    first.reply.data.length = 0;
    first.read.reply.data.length = 0;
    expect(nativeApiFixture(issuing).reply.data).toHaveLength(1);
    expect(nativeApiFixture(issuing).read.reply.data).toHaveLength(1);
  });
  it("rejects the generic string placeholders that would otherwise corrupt typed verification fields", () => {
    const fixture = nativeApiFixture(issuing);
    expect(() =>
      projectNativeStripeIssuingCards({
        ...fixture.reply,
        data: "contract-data",
        has_more: "contract-has_more",
      }),
    ).toThrow("expected response");
  });
  it("projects no optional card number, CVC or account metadata even when supplied", () => {
    const fixture = nativeApiFixture(issuing);
    fixture.reply.data[0].number = "private-pan-sentinel";
    fixture.reply.data[0].cvc = "private-cvc-sentinel";
    fixture.reply.data[0].cardholder = { email: "private-holder@example.test" };
    expect(projectNativeStripeIssuingCards(fixture.reply)).toEqual(
      fixture.read.result,
    );
  });
});
