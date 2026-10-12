import { describe, expect, it } from "vitest";
import { connectPlans } from "./connect-plan.js";
import { nativeApiVerificationRequest } from "./native-api-auth.js";
import { nativeApiCredentials, nativeApiTarget } from "./native-api-target.js";

describe("compiled native API-key request protocols", () => {
  const plans = connectPlans().filter(
    (plan) =>
      !plan.refused &&
      plan.methods.some(
        (method) =>
          method.kind === "api-key" &&
          method.preset?.auth &&
          method.preset.verify,
      ),
  );
  it.each(plans.map((plan) => [plan.id, plan] as const))(
    "admits %s only through its provider contract",
    (id, plan) => {
      const method = plan.methods.find((entry) => entry.kind === "api-key");
      if (method?.kind !== "api-key" || !method.preset)
        throw new Error("Preset required");
      const profile = method.preset.credentialVariants[0] ?? method.preset;
      const parameters: Record<string, string> = {};
      for (const field of profile.templateParams.filter(
        (entry) => !entry.secret,
      ))
        parameters[field.name] =
          field.choices?.[0]?.value ?? (field.required ? "tenant" : "");
      const target = nativeApiTarget(id, parameters);
      const values = Object.fromEntries(
        target.classification.privateCredentials.map((name) => [
          name,
          `private-${name}`,
        ]),
      );
      const credentials = nativeApiCredentials(target, values);
      const request = nativeApiVerificationRequest(target, credentials);
      expect(new URL(request.url).protocol).toBe("https:");
      expect(request.method).toBe(profile.verify?.method);
      expect(request.headers.get("cookie")).toBeNull();
      expect(target.classification.publicParameters).not.toContain("api_key");
      expect(target.classification.privateCredentials).toContain("api_key");
      for (const field of [
        ...profile.additionalCredentials,
        ...profile.templateParams.filter((field) => field.secret),
      ]) {
        expect(target.classification.privateCredentials).toContain(field.name);
        expect(target.classification.publicParameters).not.toContain(
          field.name,
        );
      }
    },
  );

  it("uses exact Basic pairs, custom headers, compound headers and optional header omission", () => {
    const mailgun = nativeApiTarget("mailgun", {});
    expect(
      nativeApiVerificationRequest(mailgun, {
        api_key: "private-key",
      }).headers.get("authorization"),
    ).toBe(`Basic ${btoa("api:private-key")}`);
    const datadog = nativeApiTarget("datadog", { site: "datadoghq.eu" });
    const request = nativeApiVerificationRequest(datadog, {
      api_key: "private-api",
      application_key: "private-app",
    });
    expect(String(request.url)).toBe(
      "https://api.datadoghq.eu/api/v2/validate_keys",
    );
    expect(request.headers.get("DD-API-KEY")).toBe("private-api");
    expect(request.headers.get("DD-APPLICATION-KEY")).toBe("private-app");
    const anthropic = nativeApiTarget("anthropic", {});
    const claude = nativeApiVerificationRequest(anthropic, {
      api_key: "private-key",
    });
    expect(claude.headers.get("anthropic-workspace-id")).toBeNull();
    expect(claude.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(
      nativeApiVerificationRequest(nativeApiTarget("pagerduty", {}), {
        api_key: "private-key",
      }).headers.get("authorization"),
    ).toBe("Token token=private-key");
  });

  it("places query/path keys only at their explicit provider sites and preserves GraphQL JSON", () => {
    const similar = nativeApiVerificationRequest(
      nativeApiTarget("similarweb", {}),
      { api_key: "key:with/slash" },
    );
    expect(new URL(similar.url).searchParams.get("api_key")).toBe(
      "key:with/slash",
    );
    const telegram = nativeApiVerificationRequest(
      nativeApiTarget("telegram", {}),
      { api_key: "123:private-token" },
    );
    expect(decodeURIComponent(new URL(telegram.url).pathname)).toBe(
      "/bot123:private-token/getMe",
    );
    const linear = nativeApiVerificationRequest(nativeApiTarget("linear", {}), {
      api_key: "private-key",
    });
    expect(JSON.parse(linear.body ?? "null")).toEqual({
      query: "{ viewer { id name email } }",
    });
  });

  it.each([
    "api.datadoghq.eu.evil.test",
    "datadoghq.com@evil.test",
    "http://evil.test",
  ])("rejects uncompiled site %s", (site) => {
    expect(() => nativeApiTarget("datadog", { site })).toThrow("supported");
  });
  it("rejects secret fields in parameters, unknown credential slots, header injection and wallet paths", () => {
    expect(() =>
      nativeApiTarget("datadog", { application_key: "private-key" }),
    ).toThrow("public");
    expect(() =>
      nativeApiCredentials(nativeApiTarget("notion", {}), {
        api_key: "private-key",
        token: "other",
      }),
    ).toThrow("private");
    expect(() =>
      nativeApiCredentials(nativeApiTarget("notion", {}), {
        api_key: "key\r\ninjected",
      }),
    ).toThrow("valid");
    expect(() => nativeApiTarget("marqeta", {})).toThrow("supported");
  });
});
