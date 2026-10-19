import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { bindNativeBrowserPolicyOrigin } from "@opensesame/app-core/lib/native-browser-policy.js";
import { describe, expect, it } from "vitest";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";

describe("compiled provider credential variants", () => {
  it.each([true, false])(
    "retains compiled variants and CORS advice without promoting unavailable runtime: %s",
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
      expect(api?.available).toBe(available);
      expect(api?.instructions).toContain("browser access");
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

it("exposes configured WorkOS fields without promoting a missing runtime", () => {
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
  expect(oauth?.unavailableReason).toContain("External connectors");
  expect(oauth?.fields.some((field) => field.id === "token_auth_method")).toBe(
    true,
  );
  expect(oauth?.unavailableReason).not.toContain("client secret");
});

it.each([
  { origin: "https://tyler-r-kendrick.github.io", admitted: false },
  { origin: "https://app.example", admitted: true },
])(
  "applies MCP admission at $origin while keeping API advice and OAuth refusal distinct",
  ({ origin, admitted }) => {
    const releaseOrigin = bindNativeBrowserPolicyOrigin(() => origin);
    try {
      const plan = connectPlan("resend");
      if (!plan) throw new Error("Missing Resend contract");
      const descriptor = nativeProviderDescriptor(plan, {
        callbackUrl: `${origin}/auth/native-connector.html`,
        apiKey: { available: true },
        oauth: { available: true },
        mcp: { available: true, actor: "user" },
      });
      expect(
        descriptor.methods
          .filter((method) => method.available)
          .map((method) => method.id),
      ).toEqual(admitted ? ["mcp", "api-key"] : ["api-key"]);
      expect(
        descriptor.methods.find((method) => method.id === "mcp")?.available,
      ).toBe(admitted);
      if (!admitted)
        expect(
          descriptor.methods.find((method) => method.id === "mcp")
            ?.unavailableReason,
        ).toBe("Resend MCP is unavailable from this site's origin.");
      for (const method of descriptor.methods.filter(
        (method) => method.id === "oauth",
      ))
        expect(method.unavailableReason).toContain("Resend");
    } finally {
      releaseOrigin();
    }
  },
);
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
