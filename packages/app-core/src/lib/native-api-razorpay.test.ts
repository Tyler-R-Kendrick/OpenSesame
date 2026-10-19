import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderPlanJson } from "../../scripts/emit-connect-presets.mjs";
import { connectPlan } from "./connect-plan.js";
import { nativeApiVerificationRequest } from "./native-api-auth.js";
import { projectNativeRazorpayPayments } from "./native-api-razorpay.js";
import { nativeApiTarget } from "./native-api-target.js";

const presets = JSON.parse(
  readFileSync(
    new URL(
      "../../../../spec/connectors/connect-presets.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const preset = presets.api_key.find(
  (row: { service: string }) => row.service === "razorpay",
);
const services = {
  services: JSON.parse(
    readFileSync(
      new URL(
        "../../../../spec/connectors/connect-services.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).services.filter((row: { service: string }) => row.service === "razorpay"),
};
function plan(row: typeof preset) {
  return renderPlanJson(
    services,
    { oauth: [], api_key: row ? [row] : [] },
    { providers: [] },
  )
    .map((text) => JSON.parse(text))
    .find((entry) => entry.id === "razorpay");
}
function editRequest(row: typeof preset, change: string) {
  if (change === "write") row.verify.method = "POST";
  if (change === "host")
    row.verify.url = row.verify.url.replace("api.razorpay.com", "other.test");
  if (change === "path")
    row.verify.url = "https://api.razorpay.com/v1/refunds?count=20&skip=0";
  if (change === "count")
    row.verify.url = row.verify.url.replace("count=20", "count=100");
  if (change === "expand") row.verify.url += "&expand[]=card";
  if (change === "body") row.verify.body = "{}";
  if (change === "headers")
    row.verify.headers = { "X-Razorpay-Account": "another-account" };
}
function editCredentials(row: typeof preset, change: string) {
  if (change === "scheme") {
    row.basic = undefined;
    row.header = "Authorization";
    row.scheme = "Bearer";
  }
  if (change === "username") row.basic.username = "{key_secret}";
  if (change === "password") row.basic.password = "";
  if (change === "optional") row.additional_credentials[0].required = false;
  if (change === "public") row.additional_credentials[0].secret = false;
  if (change === "extra")
    row.additional_credentials.push({
      ...row.additional_credentials[0],
      name: "other_secret",
    });
}
describe("Razorpay native readonly contract", () => {
  it("admits one fixed Basic request with a separate required secret and no MCP/write fallback", () => {
    expect(connectPlan("razorpay")?.refused).toBe(false);
    expect(
      plan(preset).methods.map((method: { kind: string }) => method.kind),
    ).toEqual(["api-key"]);
    const request = nativeApiVerificationRequest(
      nativeApiTarget("razorpay", {}),
      { api_key: "owned-key-id", key_secret: "owned-key-secret" },
    );
    expect(String(request.url)).toBe(
      "https://api.razorpay.com/v1/payments?count=20&skip=0",
    );
    expect(request.method).toBe("GET");
    expect(request.body).toBeUndefined();
    expect([...request.headers]).toEqual([
      ["authorization", `Basic ${btoa("owned-key-id:owned-key-secret")}`],
    ]);
  });
  it.each([
    "missing",
    "write",
    "host",
    "path",
    "count",
    "expand",
    "body",
    "headers",
    "scheme",
    "username",
    "password",
    "optional",
    "public",
    "extra",
    "variant",
    "tenant",
    "origin",
  ])("does not admit changed Razorpay authority: %s", (change) => {
    const row = structuredClone(preset);
    editRequest(row, change);
    editCredentials(row, change);
    if (change === "variant")
      row.credential_variants = [
        { id: "other", label: "Other", verify: row.verify },
      ];
    if (change === "tenant")
      row.template_params = [
        { name: "account", label: "Account", placeholder: "", secret: false },
      ];
    if (change === "origin") row.service_urls = ["https://other.test"];
    const result = plan(change === "missing" ? null : row);
    expect(result.refused).toBe(true);
    expect(result.methods).toEqual([]);
  });
  it("accepts an empty bounded collection, strips unknown private fields and preserves exact minor units", () => {
    expect(
      projectNativeRazorpayPayments({
        entity: "collection",
        count: 0,
        items: [],
      }).items,
    ).toEqual([]);
    expect(
      projectNativeRazorpayPayments({
        entity: "collection",
        count: 1,
        items: [
          {
            entity: "payment",
            id: "pay_safe",
            status: "refunded",
            currency: "INR",
            amount: Number.MAX_SAFE_INTEGER,
            email: "private@example.test",
            card: { number: "not-retained" },
          },
        ],
      }),
    ).toEqual({
      label: "Showing 1 payments from first page; amounts in minor units",
      items: [
        {
          id: "pay_safe",
          label: `pay_safe — refunded (INR ${Number.MAX_SAFE_INTEGER} minor units)`,
        },
      ],
    });
  });
});
