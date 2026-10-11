import { describe, expect, it } from "vitest";
import { ready } from "./harness.fixtures.test-support.js";
import { FULL_BUDGET, expectRefused, wireOf } from "./harness.test-support.js";

describe("a key that is not valid", () => {
  it("is refused the same way however it is wrong", async () => {
    const { h, signer, token } = await ready();
    const expected = {
      error: "invalid_token",
      error_description: "The key is not valid.",
    };
    for (const bad of [
      "",
      "osk_",
      `osk_${"A".repeat(42)}`,
      `osk_${"A".repeat(44)}`,
      `sk-${"A".repeat(48)}`,
      `osk_${"!".repeat(43)}`,
      `osk_${"A".repeat(43)}`,
    ]) {
      expect(await wireOf(h.call(bad, signer, { body: h.chat() }))).toEqual(
        expected,
      );
    }
    await h.broker.revoke({ token });
    expect(await wireOf(h.call(token, signer, { body: h.chat() }))).toEqual(
      expected,
    );
  });

  it("is refused once it has expired, to the millisecond, and a rolled-back clock does not revive it", async () => {
    const { h, signer, token, root } = await ready({ lifetimeSeconds: 60 });
    h.clock.now = root.expiresAt - 1;
    await expect(
      h.call(token, signer, { body: h.chat() }),
    ).resolves.toBeDefined();
    h.clock.now = root.expiresAt;
    await expectRefused(
      h.call(token, signer, { body: h.chat() }),
      "invalid_token",
      "key.inactive",
    );
    h.clock.now = root.expiresAt - 30_000;
    await expectRefused(
      h.call(token, signer, { body: h.chat() }),
      "invalid_token",
      "key.inactive",
    );
  });

  it("belongs to the client it was issued to, and no other", async () => {
    const { h, signer, token } = await ready();
    await expectRefused(
      h.call(token, signer, { body: h.chat(), clientId: "app-2" }),
      "invalid_token",
      "key.foreign_client",
    );
  });

  it("dies with its connection", async () => {
    const { h, signer, token } = await ready();
    h.connections.delete("conn-openai");
    await expectRefused(
      h.call(token, signer, { body: h.chat() }),
      "invalid_token",
      "connection.unavailable",
    );
    h.connections.set("conn-openai", { providerId: "openai", verified: false });
    await expectRefused(
      h.call(token, signer, { body: h.chat() }),
      "invalid_token",
      "connection.unavailable",
    );
  });

  it("dies when anything above it is revoked", async () => {
    const { h, signer, token, root } = await ready();
    const child = await h.exchange(
      token,
      { models: ["gpt-4o"], actions: ["model.invoke"], budget: FULL_BUDGET },
      { signer },
    );
    const grandchild = await h.exchange(
      child.access_token,
      {
        models: ["gpt-4o"],
        actions: ["model.invoke"],
        budget: { ...FULL_BUDGET, requests: 5 },
      },
      { signer },
    );
    await expect(
      h.call(grandchild.access_token, signer, { body: h.chat() }),
    ).resolves.toBeDefined();
    await h.broker.revoke({ id: root.id });
    for (const key of [token, child.access_token, grandchild.access_token]) {
      await expectRefused(
        h.call(key, signer, { body: h.chat() }),
        "invalid_token",
        "key.inactive",
      );
    }
  });
});
