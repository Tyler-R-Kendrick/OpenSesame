/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  nativeApiFixture,
  nativeBrowserPlans,
} from "./native-browser-provider-fixtures.mjs";

const agentmail = nativeBrowserPlans().find((plan) => plan.id === "agentmail");

describe("AgentMail documented readonly browser fixture", () => {
  it("supports the actual generated API-key preset without inventing an account field", () => {
    const fixture = nativeApiFixture(agentmail);
    expect(fixture).not.toBeNull();
    expect(fixture.providerId).toBe("agentmail");
    expect(fixture.name).toBe("AgentMail");
    expect(fixture.preset.auth).toEqual({
      kind: "header",
      header: "Authorization",
      scheme: "Bearer",
      valueTemplate: null,
    });
    expect(fixture.preset.verify).toMatchObject({
      method: "GET",
      url: "https://api.agentmail.to/v0/inboxes",
      body: null,
      accountField: null,
      requiredFields: [],
      success: [],
    });
    expect(fixture.parameters).toEqual({});
    expect(fixture.credentials).toEqual({
      api_key: "browser-protocol-only-agentmail",
    });
    expect(fixture.reply).toEqual({
      count: 1,
      inboxes: [
        {
          inbox_id: "owned-inbox",
          email: "owned@example.test",
          display_name: "Protocol authority AgentMail inbox",
        },
      ],
    });
  });

  it("does not share mutable upstream replies between independent runs", () => {
    const first = nativeApiFixture(agentmail);
    first.reply.count = 0;
    first.reply.inboxes.length = 0;
    expect(nativeApiFixture(agentmail).reply).toMatchObject({
      count: 1,
      inboxes: [{ inbox_id: "owned-inbox", email: "owned@example.test" }],
    });
  });

  it.each(["method", "auth", "verify"])(
    "still refuses missing API-key %s metadata",
    (field) => {
      const plan = structuredClone(agentmail);
      const method = plan.methods.find((item) => item.kind === "api-key");
      if (field === "method")
        plan.methods = plan.methods.filter((item) => item !== method);
      else method.preset[field] = null;
      expect(nativeApiFixture(plan)).toBeNull();
    },
  );

  it("still refuses an undocumented empty verification response", () => {
    const unknown = { ...agentmail, id: "undocumented-empty-probe" };
    expect(nativeApiFixture(unknown)).toBeNull();
  });
});
describe("Nested native verification reply containers", () => {
  const linear = nativeBrowserPlans().find((plan) => plan.id === "linear");

  it("uses Linear's existing compiled API-key verification baseline", () => {
    const fixture = nativeApiFixture(linear);
    expect(fixture.preset.verify).toMatchObject({
      method: "POST",
      url: "https://api.linear.app/graphql",
      requiredFields: ["data.viewer.id"],
      accountField: "data.viewer.name",
    });
    expect(fixture.reply).toEqual({
      data: {
        viewer: {
          id: "contract-linear-id",
          name: "Protocol authority linear account",
        },
      },
    });
  });

  it.each([
    ["data.name", { data: { name: "Verified account" } }],
    ["data.profile.name", { data: { profile: { name: "Verified account" } } }],
    ["data.0.name", { data: [{ name: "Verified account" }] }],
  ])(
    "keeps required containers and success predicates for %s",
    (field, reply) => {
      const plan = structuredClone(linear);
      const method = plan.methods.find((item) => item.kind === "api-key");
      method.preset.verify = {
        ...method.preset.verify,
        requiredFields: ["data"],
        accountField: field,
        success: [{ field, equals: "Verified account" }],
      };
      const before = JSON.stringify(plan);
      const fixture = nativeApiFixture(plan);
      expect(fixture.reply).toEqual(reply);
      fixture.reply.data = null;
      expect(nativeApiFixture(plan).reply).toEqual(reply);
      expect(JSON.stringify(plan)).toBe(before);
    },
  );
});
