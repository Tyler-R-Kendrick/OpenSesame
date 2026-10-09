import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { describe, expect, it } from "vitest";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";

describe("compiled provider credential variants", () => {
  it.each([true, false])(
    "retains compiled variants without admitting a blocked browser route, runtime availability: %s",
    (available) => {
      const original = connectPlan("railway");
      if (!original) throw new Error("Expected compiled Railway provider");
      const plan = structuredClone(original);
      const method = plan.methods.find((entry) => entry.kind === "api-key");
      if (
        method?.kind !== "api-key" ||
        !method.preset?.credentialVariants.length
      )
        throw new Error("Expected official credential variants");
      method.preset.auth = null;
      method.preset.verify = null;
      const descriptor = nativeProviderDescriptor(plan, {
        callbackUrl: "https://app.example/auth/native-connector.html",
        apiKey: { available },
        oauth: { available: false },
        mcp: { available: false, actor: "user" },
      });
      const api = descriptor.methods.find((entry) => entry.id === "api-key");
      expect(api?.available).toBe(false);
      expect(api?.unavailableReason).toContain("Railway only allows");
      expect(
        api?.fields
          .find((field) => field.id === "credential_variant")
          ?.choices?.map((choice) => choice.id),
      ).toEqual(["account", "workspace", "project"]);
      expect(
        api?.fields
          .filter((field) => field.id === "api_key")
          .every((field) => field.secret),
      ).toBe(true);
    },
  );
});

it("distinguishes unsupported public OAuth from confidential-client requirements", () => {
  const plan = connectPlan("workos");
  if (!plan) throw new Error("Expected compiled WorkOS provider");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: "https://app.example/auth/native-connector.html",
    apiKey: { available: false },
    oauth: { available: false },
    mcp: { available: true, actor: "user" },
  });
  const oauth = descriptor.methods.find((method) => method.id === "oauth");
  expect(oauth?.available).toBe(false);
  expect(oauth?.unavailableReason).toContain("public OAuth");
  expect(oauth?.unavailableReason).not.toContain("client secret");
});

it("prefers an admitted MCP alternative while retaining precise refused API and OAuth reasons", () => {
  const plan = connectPlan("resend");
  if (!plan) throw new Error("Missing Resend contract");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: "https://app.example/auth/native-connector.html",
    apiKey: { available: true },
    oauth: { available: true },
    mcp: { available: true, actor: "user" },
  });
  expect(
    descriptor.methods
      .filter((method) => method.available)
      .map((method) => method.id),
  ).toEqual(["mcp"]);
  for (const method of descriptor.methods.filter(
    (method) => method.id !== "mcp",
  ))
    expect(method.unavailableReason).toContain("Resend");
});
it("keeps officially browser-supported Notion API configuration available", () => {
  const plan = connectPlan("notion");
  if (!plan) throw new Error("Missing Notion contract");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: "https://app.example/auth/native-connector.html",
    apiKey: { available: true },
    oauth: { available: false },
    mcp: { available: false, actor: "user" },
  });
  expect(
    descriptor.methods.find((method) => method.id === "api-key")?.available,
  ).toBe(true);
});
