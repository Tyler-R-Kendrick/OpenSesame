import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderPlanJson } from "../../scripts/emit-connect-presets.mjs";
import { connectPlan } from "./connect-plan.js";
import { projectNativeAgentcardOrganization } from "./native-api-agentcard.js";
import { nativeApiVerificationRequest } from "./native-api-auth.js";
import { nativeApiResourceActions } from "./native-api-resources.js";
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
  (row: { service: string }) => row.service === "agentcard",
);
const service = JSON.parse(
  readFileSync(
    new URL(
      "../../../../spec/connectors/connect-services.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function plan(row: typeof preset) {
  return renderPlanJson(
    {
      services: service.services.filter(
        (s: { service: string }) => s.service === "agentcard",
      ),
    },
    { oauth: [], api_key: row ? [row] : [] },
    { providers: [] },
  )
    .map((text) => JSON.parse(text))
    .find((p) => p.id === "agentcard");
}
const organization = {
  object: "api_v2",
  organization_id: "owned-organization",
  test_mode: true,
};
function changeContract(row: typeof preset, change: string) {
  if (change === "write") row.verify.method = "POST";
  if (change === "member-path") row.verify.url += "/cards";
  if (change === "vault-path")
    row.verify.url += "/vault_cards?user_id=owned-user";
  if (change === "host") row.verify.url = "https://other.test/api/v2";
  if (change === "query") row.verify.url += "?user_id=owned-user";
}
function changeCredentials(row: typeof preset, change: string) {
  if (change === "header") row.header = "X-Member-Token";
  if (change === "scheme") row.scheme = "api-key";
  if (change === "basic")
    row.basic = { username: "{key}", password: "private" };
  if (change === "body") row.verify.body = "{}";
  if (change === "version")
    row.verify.headers = { "X-API-Version": "invented" };
  if (change === "override") row.verify.header = "X-Key";
  if (change === "field") row.verify.account_field = "org_id";
  if (change === "public")
    row.template_params = [{ name: "user_id", secret: false }];
  if (change === "private")
    row.additional_credentials = [
      { name: "member_token", required: true, secret: true },
    ];
  if (change === "variant")
    row.credential_variants = [{ id: "member", label: "Member" }];
  if (change === "origin") row.service_urls.push("https://other.test");
}
describe("Agentcard platform organization contract", () => {
  it("uses only the platform Bearer and exact v2 organization endpoint", () => {
    expect(connectPlan("agentcard")).toMatchObject({ refused: false });
    expect(connectPlan("agentcard")?.methods.map((m) => m.kind)).toEqual([
      "api-key",
    ]);
    const target = nativeApiTarget("agentcard", {});
    expect(target.classification.publicParameters).toEqual([]);
    expect(target.classification.privateCredentials).toEqual(["api_key"]);
    const request = nativeApiVerificationRequest(target, {
      api_key: "agentcard-owned-platform~token",
    });
    expect(String(request.url)).toBe("https://api.agentcard.sh/api/v2");
    expect(request.method).toBe("GET");
    expect(request.body).toBeUndefined();
    expect([...request.headers]).toEqual([
      ["authorization", "Bearer agentcard-owned-platform~token"],
    ]);
    expect(nativeApiResourceActions("agentcard", "api-key")).toEqual([
      { id: "provider.organization.read", label: "Read platform organization" },
    ]);
  });
  it.each([
    "write",
    "member-path",
    "vault-path",
    "host",
    "query",
    "header",
    "scheme",
    "basic",
    "body",
    "version",
    "override",
    "field",
    "public",
    "private",
    "variant",
    "origin",
  ])("refuses changed authority %s", (change) => {
    const row = structuredClone(preset);
    changeContract(row, change);
    changeCredentials(row, change);
    expect(plan(row)).toMatchObject({ refused: true, methods: [] });
  });
  it("refuses the registered partner when its exact readonly contract is absent", () => {
    expect(plan(null)).toMatchObject({ refused: true, methods: [] });
  });
  it.each([true, false])(
    "consumes actual credential mode %s without assuming an environment from host",
    (test_mode) => {
      const mode = test_mode ? "test mode" : "production";
      expect(
        projectNativeAgentcardOrganization({
          ...organization,
          test_mode,
          mode: test_mode ? "sandbox" : "production",
        }),
      ).toEqual({
        label: `Agentcard platform organization (${mode})`,
        items: [
          { id: "owned-organization", label: `owned-organization — ${mode}` },
        ],
      });
    },
  );
  it("treats organization IDs as opaque and excludes all token/card/member/unknown fields", () => {
    expect(
      projectNativeAgentcardOrganization({
        ...organization,
        organization_id: "legacy-unprefixed",
        access_token: "private-token",
        credentials: { number: "private-pan", cvc: "private-cvc" },
        user_id: "private-member",
        cards: [{}],
        next_page: "https://other.test/private",
      }),
    ).toEqual({
      label: "Agentcard platform organization (test mode)",
      items: [
        { id: "legacy-unprefixed", label: "legacy-unprefixed — test mode" },
      ],
    });
  });
  it.each([
    null,
    [],
    {},
    { object: "api_v2", test_mode: true },
    { object: "api_v2", org_id: "wrong-wire-name", test_mode: true },
    { object: "card", organization_id: "owned", test_mode: true },
    { ...organization, test_mode: "true" },
    { ...organization, organization_id: "" },
    { ...organization, organization_id: " " },
    { ...organization, organization_id: "x".repeat(257) },
    { ...organization, organization_id: "line\nbreak" },
    { ...organization, mode: "production" },
    { ...organization, test_mode: false, mode: "sandbox" },
    { ...organization, error: { code: "unauthorized" } },
    { ...organization, errors: [] },
    { attached_cards: [], cards: [] },
  ])(
    "refuses missing, member-token, contradictory or malformed organization response %#",
    (invalid) => {
      expect(() => projectNativeAgentcardOrganization(invalid)).toThrow(
        "Provider did not return the expected response",
      );
    },
  );
});
