import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderPlanJson } from "../../scripts/emit-connect-presets.mjs";
import { connectPlan } from "./connect-plan.js";
import { nativeApiVerificationRequest } from "./native-api-auth.js";
import { projectNativeLithicCards } from "./native-api-lithic.js";
import { nativeApiResourceActions } from "./native-api-resources.js";
import { nativeApiFingerprint, nativeApiTarget } from "./native-api-target.js";

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
  (row: { service: string }) => row.service === "lithic",
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
  ).services.filter((row: { service: string }) => row.service === "lithic"),
};
function plan(row: typeof preset) {
  return renderPlanJson(
    services,
    { oauth: [], api_key: row ? [row] : [] },
    { providers: [] },
  )
    .map((text) => JSON.parse(text))
    .find((entry) => entry.id === "lithic");
}
const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const card = { token, state: "OPEN", type: "VIRTUAL" };
const cards = { data: [card], has_more: false };
function editRequest(row: typeof preset, change: string) {
  const verify = row.credential_variants[1].verify;
  if (change === "write") verify.method = "POST";
  if (change === "host")
    verify.url = "https://other.test/v1/cards?page_size=20";
  if (change === "path")
    verify.url = "https://api.lithic.com/v1/cards/details?page_size=20";
  if (change === "count") verify.url = verify.url.replace("20", "100");
  if (change === "expand") verify.url += "&expand=pan";
  if (change === "body") verify.body = "{}";
  if (change === "version") verify.headers["api-version"] = "2024-01-15";
  if (change === "extra-header") verify.headers["X-Account"] = "other";
  if (change === "auth-override") verify.header = "X-Key";
}
function editCredentials(row: typeof preset, change: string) {
  if (change === "bearer") row.scheme = "Bearer";
  if (change === "basic") row.basic = { username: "{key}", password: "" };
  if (change === "query-auth") row.auth = { kind: "query", parameter: "key" };
  if (change === "public")
    row.template_params = [{ name: "host", secret: false }];
  if (change === "extra-secret")
    row.additional_credentials = [
      { name: "other", required: true, secret: true },
    ];
}
function editEnvironment(row: typeof preset, change: string) {
  const verify = row.credential_variants[1].verify;
  if (change === "origin") row.service_urls.push("https://other.test");
  if (change === "missing-variant") row.credential_variants.pop();
  if (change === "extra-variant")
    row.credential_variants.push(row.credential_variants[0]);
  if (change === "duplicate-variant") row.credential_variants[1].id = "sandbox";
  if (change === "swapped-host") row.credential_variants[0].verify = verify;
  if (change === "default-host") row.verify = verify;
}
describe("Lithic native readonly contract", () => {
  it("adds one Lithic action without duplicating the existing Datadog resource", () => {
    expect(nativeApiResourceActions("datadog", "api-key")).toEqual([
      { id: "provider.monitors.read", label: "List monitors" },
    ]);
    expect(nativeApiResourceActions("lithic", "api-key")).toEqual([
      { id: "provider.cards.read", label: "List cards" },
    ]);
  });
  it.each(["sandbox", "production"])(
    "admits only raw-key bounded %s inventory",
    async (environment) => {
      expect(connectPlan("lithic")?.refused).toBe(false);
      expect(
        plan(preset).methods.map((method: { kind: string }) => method.kind),
      ).toEqual(["api-key"]);
      const target = nativeApiTarget("lithic", {
        credential_variant: environment,
      });
      const request = nativeApiVerificationRequest(target, {
        api_key: "owned-key",
      });
      expect(String(request.url)).toBe(
        `https://${environment === "sandbox" ? "sandbox" : "api"}.lithic.com/v1/cards?page_size=20`,
      );
      expect(request.method).toBe("GET");
      expect(request.body).toBeUndefined();
      expect([...request.headers]).toEqual([
        ["api-version", "2026-07-01"],
        ["authorization", "owned-key"],
      ]);
      const other = nativeApiTarget("lithic", {
        credential_variant:
          environment === "sandbox" ? "production" : "sandbox",
      });
      expect(await nativeApiFingerprint(target)).not.toBe(
        await nativeApiFingerprint(other),
      );
    },
  );
  it.each([
    "write",
    "host",
    "path",
    "count",
    "expand",
    "body",
    "version",
    "extra-header",
    "auth-override",
    "bearer",
    "basic",
    "query-auth",
    "public",
    "extra-secret",
    "origin",
    "missing-variant",
    "extra-variant",
    "duplicate-variant",
    "swapped-host",
    "default-host",
  ])("refuses changed authority: %s", (change) => {
    const row = structuredClone(preset);
    editRequest(row, change);
    editCredentials(row, change);
    editEnvironment(row, change);
    const result = plan(row);
    expect(result.refused).toBe(true);
    expect(result.methods).toEqual([]);
  });
  it("does not invent an admission when the unlisted Lithic preset is missing", () => {
    expect(plan(null)).toBeUndefined();
  });
  it("defaults only to Sandbox and refuses invented environments", () => {
    expect(nativeApiTarget("lithic", {}).parameters).toEqual({
      credential_variant: "sandbox",
    });
    expect(() =>
      nativeApiTarget("lithic", { credential_variant: "other" }),
    ).toThrow();
    expect(() => nativeApiTarget("lithic", { api_key: "owned-key" })).toThrow();
  });
  it("projects only non-PCI identifiers, states and types", () => {
    expect(
      projectNativeLithicCards({
        ...cards,
        data: [
          {
            ...card,
            pan: "private-pan",
            cvv: "private-cvv",
            memo: "private-memo",
            account_token: "private-account",
            last_four: "1234",
            exp_year: "2027",
          },
        ],
      }),
    ).toEqual({
      label: "Showing 1 cards from first page",
      items: [{ id: token, label: `${token} — OPEN (VIRTUAL)` }],
    });
    expect(projectNativeLithicCards({ data: [], has_more: true })).toEqual({
      label: "Showing 0 cards from first page; more available",
      items: [],
    });
  });
  it.each([
    {},
    { ...cards, has_more: "false" },
    { ...cards, data: null },
    { ...cards, data: [{ ...card, token: "private-key" }] },
    { ...cards, data: [{ ...card, state: "OTHER" }] },
    { ...cards, data: [{ ...card, type: "OTHER" }] },
    { ...cards, data: [card, { ...card, token: token.toUpperCase() }] },
    { ...cards, data: Array.from({ length: 21 }, () => card) },
    { ...cards, error: { message: "private-key" } },
    { ...cards, errors: [] },
  ])("refuses malformed, duplicate and oversized inventory %#", (invalid) => {
    expect(() => projectNativeLithicCards(invalid)).toThrow(
      "Provider did not return the expected response",
    );
  });
});
