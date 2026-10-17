import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInfisicalBackend } from "./infisical.js";
import { secretBackendDraft } from "./presets.js";
import { SecretBackendError, type SecretBackendFetch } from "./types.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "rejects unusable credentials before retention or validation I/O, manual=%s",
  async (manual) => {
    for (const token of [
      "private-header-fixture\r\ntrailer",
      "private-header-fixture\u0000trailer",
      "private-header-fixture🔑",
    ]) {
      const fetcher = vi.fn<SecretBackendFetch>(async () =>
        Response.json({
          accessToken: token,
          expiresIn: 3600,
          accessTokenMaxTTL: 3600,
          tokenType: "Bearer",
        }),
      );
      const backend = createInfisicalBackend(fetcher);
      const result = await backend
        .authenticate({
          ...secretBackendDraft("infisical"),
          baseUrl: "https://infisical.example.test",
          projectId: "project",
          environment: "dev",
          secretPath: "/backup",
          clientId: manual ? "" : "machine",
          clientSecret: manual ? "" : "fixture-client-secret",
          token: manual ? token : "",
        })
        .catch((error: Error) => error);
      expect(result).toBeInstanceOf(SecretBackendError);
      expect(result).toMatchObject({
        code: manual ? "configuration" : "response",
      });
      expect(String(result)).not.toContain("private-");
      expect(JSON.stringify(result)).not.toContain("private-");
      expect(
        JSON.stringify(Object.getOwnPropertyDescriptors(result)),
      ).not.toContain("private-");
      expect(result).not.toHaveProperty("cause");
      expect(fetcher).toHaveBeenCalledTimes(Number(!manual));
      expect(vi.getTimerCount()).toBe(0);
      if (!manual)
        expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    }
  },
);
