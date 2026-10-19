/** @vitest-environment node */
import { CONNECT_PLAN_JSON } from "@opensesame/app-core/lib/connect-presets.generated.js";
import { projectNativeRazorpayPayments } from "@opensesame/app-core/lib/native-api-razorpay.js";
import { describe, expect, it } from "vitest";
import { nativeApiFixture } from "./native-browser-provider-fixtures.mjs";

const razorpay = CONNECT_PLAN_JSON.map((text) => JSON.parse(text)).find(
  (plan) => plan.id === "razorpay",
);
describe("Razorpay documented readonly browser fixture", () => {
  it("feeds the actual generated GET/Basic two-secret fixture to the strict production projector", () => {
    expect(razorpay.refused).toBe(false);
    expect(razorpay.methods.map((method) => method.kind)).toEqual(["api-key"]);
    const fixture = nativeApiFixture(razorpay);
    expect(fixture.preset.auth).toEqual({
      kind: "basic",
      username: "{key}",
      password: "{key_secret}",
    });
    expect(fixture.preset.additionalCredentials).toEqual([
      {
        name: "key_secret",
        label: "Key Secret",
        placeholder: "",
        required: true,
        secret: true,
      },
    ]);
    expect(fixture.preset.verify).toMatchObject({
      method: "GET",
      url: "https://api.razorpay.com/v1/payments?count=20&skip=0",
      headers: {},
      requiredFields: ["entity", "count", "items"],
    });
    expect(fixture.credentials.key_secret).toBeTruthy();
    expect(projectNativeRazorpayPayments(fixture.reply)).toEqual(
      fixture.read.result,
    );
    expect(projectNativeRazorpayPayments(fixture.read.reply)).toEqual(
      fixture.read.result,
    );
  });
  it("keeps documented typed arrays independent between fixture runs", () => {
    const first = nativeApiFixture(razorpay);
    first.reply.items.length = 0;
    first.read.reply.items.length = 0;
    expect(nativeApiFixture(razorpay).reply.items).toHaveLength(1);
    expect(nativeApiFixture(razorpay).read.reply.items).toHaveLength(1);
  });
  it("rejects the generic string placeholders that would corrupt payment verification", () => {
    expect(() =>
      projectNativeRazorpayPayments({
        ...nativeApiFixture(razorpay).reply,
        count: "contract-count",
        items: "contract-items",
      }),
    ).toThrow("expected response");
  });
  it("never retains private customer or card details in the common resource result", () => {
    const fixture = nativeApiFixture(razorpay);
    Object.assign(fixture.reply.items[0], {
      email: "private@example.test",
      contact: "private-contact",
      card: { number: "private-card" },
      bank: "private-bank",
      upi: { vpa: "private-upi" },
      notes: { private: "private-notes" },
    });
    expect(projectNativeRazorpayPayments(fixture.reply)).toEqual(
      fixture.read.result,
    );
  });
});
