import { describe, expect, it } from "vitest";
import { nativeApiCleanup } from "./native-api-cleanup.js";
import { configureNativeApiConnector } from "./native-api-connectors.js";
import {
  installNativeApiTests,
  nativeAnswers,
  nativeApiDraft,
} from "./native-api.test-support.js";
import type { NativeRecovery } from "./native-connector-schema.js";
import { loadNativeConnectorRecord } from "./native-connector-store.js";

installNativeApiTests();
describe("exact provider-bound API key cleanup", () => {
  it.each(["provider", "fingerprint", "actor", "target"] as const)(
    "refuses mismatched %s cleanup rather than claiming completion",
    async (field) => {
      const provider = nativeAnswers({ body: { name: "Team" } });
      const view = await configureNativeApiConnector(
        nativeApiDraft(),
        provider.transport,
      );
      const record = loadNativeConnectorRecord(view.connectionId);
      const grant = record?.privateState.grants.app;
      if (!record || !grant?.targetId)
        throw new Error("Expected verified bound key");
      const obligation: NativeRecovery = {
        id: "revoke:app",
        kind: "revoke",
        providerId: "notion",
        actor: "app",
        fingerprint: record.configuration.fingerprint,
        targetId: grant.targetId,
        grant: { ...grant },
      };
      if (field === "provider") obligation.providerId = "openai";
      if (field === "fingerprint") obligation.fingerprint = "b".repeat(64);
      if (field === "actor") obligation.actor = "other";
      if (field === "target") obligation.targetId = "https://another.example";
      await expect(
        nativeApiCleanup.cleanup(obligation, {
          connectionId: view.connectionId,
          configuration: record.configuration,
          persistGrantRotation: async () => {
            throw new Error("API keys do not rotate");
          },
        }),
      ).rejects.toThrow("unsupported provider cleanup");
      expect(provider.fetch).toHaveBeenCalledTimes(1);
      expect(
        loadNativeConnectorRecord(view.connectionId)?.privateState.grants.app
          ?.accessToken,
      ).toBe("private-native-key");
    },
  );
});
