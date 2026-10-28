import { describe, expect, it } from "vitest";
import { connectPlans } from "./connect-plan.js";
import { nativeApiVerificationRequest } from "./native-api-auth.js";
import { nativeApiResourceActions } from "./native-api-resources.js";
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
          field.defaultValue ??
          field.choices?.[0]?.value ??
          (field.format === "uuid"
            ? "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff"
            : field.required
              ? "tenant"
              : "");
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

  it("builds a Higgsfield status request only from a UUID and both credentials", () => {
    const requestId = "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff";
    const target = nativeApiTarget("higgsfield", { request_id: requestId });
    const credentials = nativeApiCredentials(target, {
      api_key: "test-id",
      key_secret: "test-secret",
    });
    const request = nativeApiVerificationRequest(target, credentials);
    expect(request.method).toBe("GET");
    expect(String(request.url)).toBe(
      `https://api.higgsfield.ai/requests/${requestId}/status`,
    );
    expect(request.headers.get("authorization")).toBe(
      "Key test-id:test-secret",
    );
    for (const invalid of ["", ".", "..", "request-1", "../status"]) {
      expect(() =>
        nativeApiTarget("higgsfield", { request_id: invalid }),
      ).toThrow();
    }
    expect(() =>
      nativeApiCredentials(target, { api_key: "test-id" }),
    ).toThrow();
  });

  it("keeps the new provider endpoints and credential schemes exact", () => {
    const obsidian = nativeApiVerificationRequest(
      nativeApiTarget("obsidian", { host: "127.0.0.1", port: "27124" }),
      { api_key: "owned-key" },
    );
    expect(String(obsidian.url)).toBe("https://127.0.0.1:27124/vault/");
    expect(obsidian.headers.get("authorization")).toBe("Bearer owned-key");
    expect(() =>
      nativeApiVerificationRequest(
        nativeApiTarget("obsidian", { host: "remote.example", port: "27124" }),
        { api_key: "owned-key" },
      ),
    ).toThrow("Provider requests require the compiled HTTPS target");

    const higgsfield = nativeApiVerificationRequest(
      nativeApiTarget("higgsfield", {
        request_id: "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff",
      }),
      { api_key: "key-id", key_secret: "key-secret" },
    );
    expect(higgsfield.headers.get("authorization")).toBe(
      "Key key-id:key-secret",
    );
    expect(String(higgsfield.url)).toBe(
      "https://api.higgsfield.ai/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/status",
    );

    const fal = nativeApiVerificationRequest(
      nativeApiTarget("fal-ai", { request_id: "request-2" }),
      { api_key: "fal-key" },
    );
    expect(fal.headers.get("authorization")).toBe("Key fal-key");
    expect(String(fal.url)).toBe(
      "https://queue.fal.run/fal-ai/flux/requests/request-2/status",
    );
    const preset = connectPlans()
      .find((plan) => plan.id === "fal-ai")
      ?.methods.find((method) => method.kind === "api-key")?.preset;
    expect(preset?.instructions).toContain(
      "Only fal-ai/flux request IDs are supported",
    );
    expect(preset?.templateParams[0]?.label).toContain("fal-ai/flux");
  });

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
  it("rejects secret fields in parameters, unknown credential slots, header injection and unsupported provider contracts", () => {
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
    expect(() => nativeApiTarget("unsupported-native-payment", {})).toThrow(
      "supported",
    );
    expect(nativeApiResourceActions("marqeta", "api-key")).toEqual([
      { id: "provider.users.read", label: "List users" },
    ]);
  });
});
