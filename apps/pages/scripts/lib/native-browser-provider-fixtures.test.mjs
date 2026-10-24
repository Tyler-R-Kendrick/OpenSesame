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
