import { isAiModelProvider } from "@opensesame/app-core/lib/ai-model-provider.js";
import { modelApiHost } from "@opensesame/app-core/lib/ai-model-provider.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { nativeApiVerificationRequest } from "@opensesame/app-core/lib/native-api-auth.js";
import { nativeApiTarget } from "@opensesame/app-core/lib/native-api-target.js";
import { describe, expect, it } from "vitest";
import { verifyHost } from "./key-hosts.js";

describe("the host Test connection and Save send the key to", () => {
  it("is the preset's verify host, which is not always the model API host", () => {
    // Hugging Face verifies a token at huggingface.co and serves models at
    // router.huggingface.co: the key reaches the first, and the sheet says so.
    expect(modelApiHost("huggingface")).toBe("router.huggingface.co");
    expect(verifyHost("huggingface", {})).toBe("huggingface.co");
  });

  it("is the one host when verifying and serving share it", () => {
    expect(modelApiHost("openai")).toBe("api.openai.com");
    expect(verifyHost("openai", {})).toBe("api.openai.com");
    expect(verifyHost("xai", {})).toBe("api.x.ai");
  });

  it("fills a tenant host the way the connector runtime does", () => {
    expect(verifyHost("assemblyai", {})).toBe("api.assemblyai.com");
    expect(verifyHost("assemblyai", { api_host: "api.assemblyai.com" })).toBe(
      "api.assemblyai.com",
    );
    expect(
      verifyHost("assemblyai", { api_host: "api.eu.assemblyai.com" }),
    ).toBe("api.eu.assemblyai.com");
  });

  it("names no host the runtime would refuse to send to", () => {
    expect(
      verifyHost("assemblyai", { api_host: "evil.example.com" }),
    ).toBeNull();
    expect(verifyHost("assemblyai", { not_a_field: "x" })).toBeNull();
  });

  it("names none for a row with no browser road", () => {
    expect(verifyHost("azure-openai", {})).toBeNull();
    expect(verifyHost("no-such-provider", {})).toBeNull();
  });

  it("is, for every model provider a sheet can open on, the host the runtime requests", () => {
    const checked: string[] = [];
    for (const provider of getBundledProviders().filter(isAiModelProvider)) {
      const method = connectPlan(provider.id)?.methods.find(
        (entry) => entry.kind === "api-key",
      );
      if (method?.kind !== "api-key" || !method.preset?.verify) continue;
      const preset = method.preset;
      const parameters = Object.fromEntries(
        preset.templateParams
          .filter((field) => !field.secret && !field.choices)
          .map((field) => [
            field.name,
            field.format === "uuid"
              ? "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff"
              : "tenant",
          ]),
      );
      const target = nativeApiTarget(provider.id, parameters);
      const credentials = Object.fromEntries(
        target.classification.privateCredentials.map((name) => [
          name,
          "test-credential-0123456789",
        ]),
      );
      const request = nativeApiVerificationRequest(target, credentials);
      expect(verifyHost(provider.id, parameters), provider.id).toBe(
        new URL(request.url).host,
      );
      checked.push(provider.id);
    }
    expect(checked).toContain("huggingface");
    expect(checked.length).toBeGreaterThan(30);
  });
});
