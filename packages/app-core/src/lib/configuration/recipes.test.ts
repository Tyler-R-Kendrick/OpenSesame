import { describe, expect, it } from "vitest";
import { applyBoundRecipe, exportRecipe, importRecipe } from "./recipes.js";

describe("recipes", () => {
  it("strips secrets and owner records from exported semantics", () => {
    const recipe = exportRecipe({
      name: "payroll",
      resources: [
        {
          kind: "local_application",
          logicalId: "payroll",
          body: {
            redirectUris: ["https://payroll.example/cb"],
            clientSecret: "live-secret",
            ownerPrincipalId: "user-1",
            note: "secret: live-secret",
          },
        },
      ],
    });
    const body = recipe.resources[0]?.body ?? {};
    expect(body.clientSecret).toBeUndefined();
    expect(body.ownerPrincipalId).toBeUndefined();
    expect(body.note).toBeUndefined();
    expect(JSON.stringify(recipe)).not.toContain("live-secret");
    expect(body.redirectUris).toEqual(["https://payroll.example/cb"]);
    expect(recipe.omissions.length).toBeGreaterThan(0);
  });

  it("requires explicit organization binding and does not duplicate on inspect", () => {
    const recipe = exportRecipe({
      name: "payroll",
      resources: [
        {
          kind: "local_application",
          logicalId: "payroll",
          body: {
            redirectUris: ["https://payroll.example/cb"],
            scopes: ["openid"],
          },
        },
      ],
    });
    expect(importRecipe(recipe, {}).ok).toBe(false);
    expect(
      importRecipe(
        {
          ...recipe,
          resources: [
            {
              kind: "local_application",
              logicalId: "payroll",
              body: { clientSecret: "still-live" },
            },
          ],
        },
        { organization: "org-b" },
      ).ok,
    ).toBe(false);
    const first = importRecipe(recipe, { organization: "org-b" });
    const second = importRecipe(recipe, { organization: "org-b" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.bound.resources[0]?.logicalId).toBe(
        second.bound.resources[0]?.logicalId,
      );
    }
  });

  it("strips authority material nested inside arrays on export", () => {
    const recipe = exportRecipe({
      name: "payroll",
      resources: [
        {
          kind: "local_application",
          logicalId: "payroll",
          body: {
            items: [{ clientSecret: "nested-secret", label: "keep" }],
            nested: { list: [[{ accessToken: "deep-token" }]] },
          },
        },
      ],
    });
    const serialized = JSON.stringify(recipe);
    expect(serialized).not.toContain("nested-secret");
    expect(serialized).not.toContain("deep-token");
    expect(serialized).toContain("keep");
  });

  it("rejects authority material nested in arrays and broadened key names on import", () => {
    const clean = exportRecipe({
      name: "payroll",
      resources: [
        {
          kind: "local_application",
          logicalId: "payroll",
          body: {
            redirectUris: ["https://payroll.example/cb"],
            scopes: ["openid"],
          },
        },
      ],
    });
    for (const body of [
      { items: [{ clientSecret: "leaked" }] },
      { items: [[{ idToken: "leaked" }]] },
      { config: { apiKey: "leaked" } },
      { config: { private_key: "leaked" } },
      { credential: "leaked" },
      { sessionToken: "leaked" },
    ]) {
      expect(
        importRecipe(
          {
            ...clean,
            resources: [
              { kind: "local_application", logicalId: "payroll", body },
            ],
          },
          { organization: "org-b" },
        ).ok,
      ).toBe(false);
    }
  });

  it("returns ok:false for a malformed manifest instead of throwing", () => {
    const malformed = [
      JSON.parse('{"schema":"opensesame.recipe.v1"}'),
      { schema: "opensesame.recipe.v1", requiredInputs: [], resources: {} },
      {
        schema: "opensesame.recipe.v1",
        requiredInputs: [],
        resources: [{ kind: 7, logicalId: "a", body: {} }],
      },
      {
        schema: "opensesame.recipe.v1",
        requiredInputs: [],
        resources: [{ kind: "prefs", logicalId: "a", body: "nope" }],
      },
    ];
    for (const manifest of malformed) {
      expect(
        importRecipe(manifest as never, { organization: "org-b" }),
      ).toEqual({ ok: false, message: "Malformed recipe manifest." });
    }
  });

  it("surfaces adapter failures with partial-application detail", async () => {
    const recipe = exportRecipe({
      name: "payroll",
      resources: [
        {
          kind: "local_application",
          logicalId: "first",
          body: {
            redirectUris: ["https://first.example/cb"],
            scopes: ["openid"],
          },
        },
        {
          kind: "local_application",
          logicalId: "second",
          body: {
            redirectUris: ["https://second.example/cb"],
            scopes: ["openid"],
          },
        },
      ],
    });
    const bound = importRecipe(recipe, { organization: "org-b" });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const port = {
      applyLocalApplication: async (input: { logicalId: string }) => {
        if (input.logicalId === "second") {
          throw new Error("revision conflict");
        }
      },
    };
    const result = await applyBoundRecipe(
      bound.bound,
      { organization: "org-b" },
      port,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("revision conflict");
    expect(result.message).toContain("Partial application: first");
  });

  it("applies through configureLocalApplication and is idempotent by applicationId", async () => {
    const calls: string[] = [];
    const recipe = exportRecipe({
      name: "payroll",
      resources: [
        {
          kind: "local_application",
          logicalId: "payroll",
          body: {
            redirectUris: ["https://payroll.example/cb"],
            scopes: ["openid"],
          },
        },
      ],
    });
    const bound = importRecipe(recipe, { organization: "org-b" });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const port = {
      applyLocalApplication: async (input: {
        logicalId: string;
        organizationId: string;
        redirectUris: string[];
        scopes: string[];
      }) => {
        calls.push(`${input.organizationId}:${input.logicalId}`);
      },
    };
    const first = await applyBoundRecipe(
      bound.bound,
      { organization: "org-b" },
      port,
    );
    const second = await applyBoundRecipe(
      bound.bound,
      { organization: "org-b" },
      port,
    );
    expect(first.ok && second.ok).toBe(true);
    expect(calls).toEqual(["org-b:payroll", "org-b:payroll"]);
  });
});
