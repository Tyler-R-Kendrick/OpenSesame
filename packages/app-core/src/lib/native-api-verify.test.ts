import { describe, expect, it } from "vitest";
import { connectPlans } from "./connect-plan.js";
import { nativeApiExposedCredentials } from "./native-api-auth.js";
import { nativeApiCredentials, nativeApiTarget } from "./native-api-target.js";
import { verifyNativeApiResponse } from "./native-api-verify.js";

describe("provider verification envelopes and credential reflection", () => {
  const providers = connectPlans().filter(
    (plan) =>
      !plan.refused &&
      plan.methods.some(
        (method) =>
          method.kind === "api-key" &&
          method.preset?.auth &&
          method.preset.verify,
      ),
  );
  it.each(providers.map((plan) => [plan.id] as const))(
    "refuses HTTP200 error envelopes for %s",
    (provider) => {
      const preset = connectPlans()
        .find((plan) => plan.id === provider)
        ?.methods.find((method) => method.kind === "api-key");
      if (preset?.kind !== "api-key" || !preset.preset)
        throw new Error("Expected compiled preset");
      const profile = preset.preset.credentialVariants[0] ?? preset.preset;
      const parameters = Object.fromEntries(
        profile.templateParams
          .filter((field) => !field.secret)
          .map((field) => [
            field.name,
            field.choices?.[0]?.value ?? (field.required ? "tenant" : ""),
          ]),
      );
      const target = nativeApiTarget(provider, parameters);
      const verify = target.profile.verify;
      if (!verify) throw new Error("Expected provider verification");
      const credentials = nativeApiCredentials(
        target,
        Object.fromEntries(
          target.classification.privateCredentials.map((name) => [
            name,
            `private-${name}`,
          ]),
        ),
      );
      for (const body of [
        { error: "private-api_key" },
        { errors: [{ message: "private-api_key" }] },
      ])
        expect(() =>
          verifyNativeApiResponse(
            target.providerName,
            verify,
            body,
            credentials,
          ),
        ).toThrow("authorization was refused");
    },
  );
  it("refuses a reflected Basic authorization value in the public account label", () => {
    const target = nativeApiTarget("mailgun", {});
    const credentials = { api_key: "private-secret-key" };
    const verify = target.profile.verify;
    if (!verify) throw new Error("Expected provider verification");
    expect(() =>
      verifyNativeApiResponse(
        target.providerName,
        verify,
        { items: [{ name: btoa("api:private-secret-key") }] },
        nativeApiExposedCredentials(target, credentials),
      ),
    ).toThrow("expected response");
  });
  it("refuses URL-encoded path credentials in the public provider label", () => {
    const target = nativeApiTarget("telegram", {});
    const credentials = { api_key: "123:private-token" };
    const verify = target.profile.verify;
    if (!verify) throw new Error("Expected provider verification");
    expect(() =>
      verifyNativeApiResponse(
        target.providerName,
        verify,
        { ok: true, result: { id: 1, username: "123%3Aprivate-token" } },
        nativeApiExposedCredentials(target, credentials),
      ),
    ).toThrow("expected response");
  });
});
