import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { describe, expect, it } from "vitest";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";

describe("Cursor Origin descriptor", () => {
  it("offers only the Ed25519 app installation flow", () => {
    const plan = connectPlan("origin");
    if (!plan) throw new Error("Origin plan missing");
    const descriptor = nativeProviderDescriptor(plan, {
      callbackUrl: "https://selfhost.example/auth/native-connector.html",
      apiKey: { available: false },
      oauth: { available: true },
      mcp: { available: false, actor: "user" },
    });
    expect(descriptor.methods).toHaveLength(1);
    const method = descriptor.methods[0];
    expect(method).toMatchObject({ id: "oauth", available: true });
    expect(method?.fields.map((field) => field.id)).toEqual([
      "client_id",
      "redirect_uri",
      "private_key",
    ]);
    expect(
      method?.fields.find((field) => field.id === "private_key"),
    ).toMatchObject({ secret: true });
    expect(JSON.stringify(method)).not.toContain("client_secret");
    expect(JSON.stringify(method)).not.toContain("PKCE");
    expect(JSON.stringify(method)).not.toContain("authorization_code");
    expect(method?.scopeGroups[0]?.choices.map((scope) => scope.name)).toEqual([
      "repository:contents:read",
      "repository:contents:write",
    ]);
  });
});
