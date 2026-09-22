/** @vitest-environment jsdom */
/**
 * Legacy configuration review (S19-B): what an older installation had
 * configured is *offered*, and nothing is enabled — not by a provider on
 * record, not by an endpoint, and never by a skipped setup tab.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { reviewLegacyConfiguration } from "./migration.js";
import { compositionStore } from "./store.js";
import { approved, bootPersonalLocal, durable, freshRealm } from "./__tests__/harness.js";

beforeEach(freshRealm);

describe("reviewLegacyConfiguration", () => {
  it("names the capabilities the old records suggest", () => {
    durable.set(
      "settings.v1",
      JSON.stringify({
        hostApi: "",
        identityApi: "https://id.example.test",
        daemonApi: "",
        signIn: {
          builtin: true,
          providers: [
            {
              providerId: "okta",
              issuer: "https://okta.example.test",
              clientId: "abc",
              label: "Okta",
            },
          ],
        },
      }),
    );
    durable.set(
      "setup.v1",
      JSON.stringify({ completedAt: "2026-01-01T00:00:00Z", ways: ["builtin", "okta"] }),
    );
    durable.set("model-provider.v1", JSON.stringify({ kind: "hosted" }));
    durable.set(
      "connector-directory.v1",
      JSON.stringify({ endpoint: "https://nango.example.test" }),
    );

    const review = reviewLegacyConfiguration();

    const capabilities = new Set(review.suggestions.map((s) => s.capability));
    expect(capabilities).toEqual(
      new Set(["identity.federation", "support.remote-ai", "connectors.external"]),
    );
    expect(review.enabled).toEqual([]);
    for (const s of review.suggestions) {
      expect(s.evidence).not.toMatch(/example\.test|okta|abc/i);
    }
  });

  it("does not read a skipped tab or an empty record as anything", () => {
    durable.set(
      "setup.v1",
      JSON.stringify({
        completedAt: "2026-01-01T00:00:00Z",
        ways: ["builtin"],
        skipped: ["connectors", "ai", "identity"],
      }),
    );
    durable.set("model-provider.v1", JSON.stringify({ kind: "none" }));
    expect(reviewLegacyConfiguration()).toEqual({ suggestions: [], enabled: [] });
  });

  it("S19-B: a review changes nothing in the plan", async () => {
    durable.set("model-provider.v1", JSON.stringify({ kind: "local" }));
    await bootPersonalLocal();
    const before = compositionStore.getSnapshot();

    const review = compositionStore.legacyReview();

    expect(review.suggestions.map((s) => s.capability)).toEqual(["support.local-ai"]);
    expect(compositionStore.getSnapshot()).toBe(before);
    expect(approved(compositionStore)).toEqual(["settings.core", "vault.passwords"]);
  });
});
