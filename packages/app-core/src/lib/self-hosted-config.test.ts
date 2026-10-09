import { describe, expect, it } from "vitest";
import metadata from "../../../../spec/connectors/self-hosted-config.json" with {
  type: "json",
};
import { connectPlan, connectPlans } from "./connect-plan.js";
import {
  SelfHostedConfigMetadataSchema,
  defaultSelections,
  selfHostedConfig,
} from "./self-hosted-config.js";

describe("self-hosted connector configuration", () => {
  it("offers Linear's workspace, four app scopes, two user scopes and two webhook resources", () => {
    const config = selfHostedConfig(connectPlan("linear"));
    expect(config?.fields).toEqual([
      {
        name: "workspace",
        label: "Linear workspace",
        placeholder: "Your Linear workspace name or ID",
        required: true,
      },
    ]);
    expect(defaultSelections(config?.appScopes ?? [])).toEqual([
      "read",
      "write",
      "issues:create",
      "comments:create",
    ]);
    expect(defaultSelections(config?.userScopes ?? [])).toEqual([
      "read",
      "write",
    ]);
    expect(defaultSelections(config?.webhookResourceTypes ?? [])).toEqual([
      "Issue",
      "Comment",
    ]);
    expect(config?.webhookResourceTypes.map((choice) => choice.name)).toEqual([
      "Issue",
      "Comment",
      "IssueLabel",
      "Project",
      "Cycle",
      "Reaction",
    ]);
  });

  it("takes OAuth choices from the single connector plan source for every provider", () => {
    for (const plan of connectPlans().filter((item) => !item.refused)) {
      const oauth = plan.methods.find(
        (method) => method.kind === "oauth" && method.preset,
      );
      const scopes =
        oauth?.kind === "oauth" ? (oauth.preset?.scopes ?? []) : [];
      expect(
        selfHostedConfig(plan)?.appScopes.map(({ name, description }) => ({
          name,
          description,
        })),
      ).toEqual(scopes.map(({ name, description }) => ({ name, description })));
      if (plan.id !== "linear")
        expect(selfHostedConfig(plan)?.appScopes).toEqual(scopes);
    }
  });

  it("does not add Linear's fields to unrelated providers or invent a plan", () => {
    expect(selfHostedConfig(connectPlan("github"))?.fields).toEqual([]);
    expect(selfHostedConfig(connectPlan("github"))?.userScopes).toEqual([]);
    expect(
      selfHostedConfig(connectPlan("github"))?.webhookResourceTypes,
    ).toEqual([]);
    expect(selfHostedConfig(connectPlan("unknown-provider"))).toBeUndefined();
    const refused = connectPlans().find((plan) => plan.refused);
    expect(refused).toBeDefined();
    if (refused) expect(selfHostedConfig(refused)).toBeUndefined();
  });

  it("returns isolated form choices so editing one connector cannot change another", () => {
    const first = selfHostedConfig(connectPlan("linear"));
    if (!first) throw new Error("Linear configuration missing");
    first.appScopes[0].default = false;
    first.fields[0].label = "Changed";
    first.webhookResourceTypes[0].name = "Changed";
    expect(
      defaultSelections(
        selfHostedConfig(connectPlan("linear"))?.appScopes ?? [],
      ),
    ).toContain("read");
    expect(selfHostedConfig(connectPlan("linear"))?.fields[0].label).toBe(
      "Linear workspace",
    );
    expect(
      selfHostedConfig(connectPlan("linear"))?.webhookResourceTypes[0].name,
    ).toBe("Issue");
    expect(connectPlan("linear")?.name).toBe("Linear");
  });

  it("rejects stale metadata, duplicate choices and defaults the provider does not support", () => {
    expect(SelfHostedConfigMetadataSchema.safeParse(metadata).success).toBe(
      true,
    );
    expect(
      SelfHostedConfigMetadataSchema.safeParse({ ...metadata, version: 2 })
        .success,
    ).toBe(false);
    expect(
      SelfHostedConfigMetadataSchema.safeParse({
        version: 1,
        providers: { unknown: metadata.providers.linear },
      }).success,
    ).toBe(false);
    for (const appScopeDefaults of [["vercel-token"], ["read", "read"]]) {
      expect(
        SelfHostedConfigMetadataSchema.safeParse({
          ...metadata,
          providers: {
            linear: { ...metadata.providers.linear, appScopeDefaults },
          },
        }).success,
      ).toBe(false);
    }
    expect(
      SelfHostedConfigMetadataSchema.safeParse({
        ...metadata,
        providers: {
          linear: {
            ...metadata.providers.linear,
            webhookResourceTypes: [
              metadata.providers.linear.webhookResourceTypes[0],
              metadata.providers.linear.webhookResourceTypes[0],
            ],
          },
        },
      }).success,
    ).toBe(false);
  });
});
