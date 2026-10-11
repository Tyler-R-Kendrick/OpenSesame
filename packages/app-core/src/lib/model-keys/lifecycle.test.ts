import { describe, expect, it } from "vitest";
import { detail, ready } from "./harness.fixtures.test-support.js";
import {
  FULL_BUDGET,
  expectRefused,
  harness,
  newSigner,
} from "./harness.test-support.js";
import type { ModelKeyEvent } from "./types.js";

const TINY = {
  requests: 1,
  input_tokens: 1,
  output_tokens: 1,
  max_output_tokens: 1,
};

describe("revoking keys", () => {
  it("ends a key and everything issued from it, and says which", async () => {
    const { h, signer, root } = await ready();
    const child = await h.exchange(root.token, detail(), { signer });
    const grand = await h.exchange(
      child.access_token,
      detail({ budget: { ...FULL_BUDGET, requests: 5 } }),
      { signer },
    );
    const ids = await h.broker.revoke({ token: child.access_token });
    expect(ids).toHaveLength(2);
    await expectRefused(
      h.call(grand.access_token, signer, { body: h.chat() }),
      "invalid_token",
      "key.inactive",
    );
    await expect(
      h.call(root.token, signer, { body: h.chat() }),
    ).resolves.toBeDefined();
    expect(
      h.events.filter((event) => event.type === "key.revoked"),
    ).toHaveLength(2);
  });

  it("revokes by id, and by client without touching another client's keys", async () => {
    const { h, signer, root } = await ready();
    const other = await h.root(signer, { clientId: "app-2" });
    expect(await h.broker.revoke({ clientId: "app-1" })).toEqual([root.id]);
    await expectRefused(
      h.call(root.token, signer, { body: h.chat() }),
      "invalid_token",
      "key.inactive",
    );
    await expect(
      h.call(other.token, signer, { body: h.chat(), clientId: "app-2" }),
    ).resolves.toBeDefined();
    expect(await h.broker.revoke({ id: other.id })).toEqual([other.id]);
  });

  it("says nothing about a key that is not there (RFC 7009), and never twice", async () => {
    const { h, root } = await ready();
    expect(await h.broker.revoke({ token: `osk_${"A".repeat(43)}` })).toEqual(
      [],
    );
    expect(await h.broker.revoke({ token: "not a key" })).toEqual([]);
    expect(await h.broker.revoke({ id: "mk_missing" })).toEqual([]);
    expect(await h.broker.revoke({ clientId: "nobody" })).toEqual([]);
    expect(await h.broker.revoke({ token: root.token })).toEqual([root.id]);
    expect(await h.broker.revoke({ token: root.token })).toEqual([]);
    expect(
      h.events.filter((event) => event.type === "key.revoked"),
    ).toHaveLength(1);
  });

  it("is something only the page holding the broker can do", async () => {
    // a key presented by an app can end itself, but a revoke by token needs the whole key
    const { h, root } = await ready();
    expect(
      await h.broker.revoke({ token: `${root.token.slice(0, -1)}X` }),
    ).toEqual([]);
    expect(h.broker.list()[0]?.status).toBe("active");
  });
});

describe("what the owner sees", () => {
  it("lists what each key may still do, with no key and no digest in it", async () => {
    const { h, signer, root } = await ready();
    const child = await h.exchange(root.token, detail(), { signer });
    const listed = JSON.stringify(h.broker.list());
    expect(listed).not.toContain(root.token);
    expect(listed).not.toContain(child.access_token);
    expect(listed).not.toContain("digest");
    expect(h.broker.list().map((view) => view.status)).toEqual([
      "active",
      "active",
    ]);
  });

  it("tells expired from revoked", async () => {
    const { h, signer, root } = await ready();
    const short = await h.exchange(
      root.token,
      detail({ lifetime_seconds: 30 }),
      { signer },
    );
    const doomed = await h.exchange(
      root.token,
      detail({ budget: { ...FULL_BUDGET, requests: 5 } }),
      { signer },
    );
    await h.broker.revoke({ token: doomed.access_token });
    h.clock.now += 31_000;
    expect(h.broker.list().map((view) => view.status)).toEqual([
      "active",
      "expired",
      "revoked",
    ]);
    expect(short.expires_in).toBe(30);
  });

  it("forgets everything on a reset, which is what a lock is", async () => {
    const { h, signer, root } = await ready();
    const child = await h.exchange(root.token, detail(), { signer });
    h.broker.reset();
    expect(h.broker.list()).toEqual([]);
    for (const token of [root.token, child.access_token]) {
      await expectRefused(
        h.call(token, signer, { body: h.chat() }),
        "invalid_token",
        "key.inactive",
      );
      await expectRefused(
        h.exchange(token, detail(), { signer }),
        "invalid_grant",
        "subject.unknown",
      );
    }
  });
});

describe("time", () => {
  it("never lets a rolled-back clock revive a key", async () => {
    const { h, signer, root } = await ready({ lifetimeSeconds: 120 });
    h.clock.now = root.expiresAt + 1;
    await expectRefused(
      h.exchange(root.token, detail(), { signer }),
      "invalid_grant",
      "subject.inactive",
    );
    h.clock.now = root.expiresAt - 100_000;
    await expectRefused(
      h.exchange(root.token, detail(), { signer }),
      "invalid_grant",
      "subject.inactive",
    );
  });

  it("never gives a child longer than its parent has left", async () => {
    const { h, signer, root } = await ready({ lifetimeSeconds: 600 });
    h.clock.now += 500_000;
    const child = await h.exchange(
      root.token,
      detail({ lifetime_seconds: 3600 }),
      { signer },
    );
    expect(child.expires_in).toBe(100);
  });

  it("gives a child with no lifetime of its own the default, or what the parent has left", async () => {
    const { h, signer, root } = await ready();
    const { lifetime_seconds: _drop, ...bare } = {
      ...detail(),
      lifetime_seconds: 0,
    };
    const child = await h.exchange(root.token, bare, { signer });
    expect(child.expires_in).toBe(15 * 60);
  });
});

describe("limits that keep the ledger honest", () => {
  it("refuses a 33rd live child of one key", async () => {
    const { h, signer, root } = await ready({
      budget: {
        requests: 1000,
        input_tokens: 100_000,
        output_tokens: 50_000,
        max_output_tokens: 4096,
      },
    });
    for (let i = 0; i < 32; i += 1) {
      await h.exchange(root.token, detail({ budget: TINY }), { signer });
    }
    await expectRefused(
      h.exchange(root.token, detail({ budget: TINY }), { signer }),
      "access_denied",
      "children.limit",
    );
  });

  it("refuses a 257th key, and makes room as keys end", async () => {
    const h = harness();
    const signer = await newSigner();
    const roots = [];
    for (let i = 0; i < 256; i += 1)
      roots.push(await h.root(signer, { clientId: `app-${i}` }));
    await expectRefused(
      h.root(signer, { clientId: "app-extra" }),
      "temporarily_unavailable",
      "ledger.full",
    );
    await h.broker.revoke({ id: roots[0]?.id ?? "" });
    await expect(
      h.root(signer, { clientId: "app-extra" }),
    ).resolves.toBeDefined();
  });
});

describe("the audit trail", () => {
  it("records what happened and to whom, and never a key, a proof or a prompt", async () => {
    const { h, signer, root } = await ready();
    const child = await h.exchange(root.token, detail(), { signer });
    await h.call(child.access_token, signer, {
      body: h.chat({
        messages: [{ role: "user", content: "a secret prompt" }],
      }),
    });
    await h
      .call(child.access_token, signer, { body: h.chat({ model: "gpt-4" }) })
      .catch(() => undefined);
    await h
      .exchange(root.token, detail({ models: ["gpt-4"] }), { signer })
      .catch(() => undefined);
    await h.broker.revoke({ token: child.access_token });
    const kinds = new Set(h.events.map((event) => event.type));
    for (const kind of [
      "root.issued",
      "exchange.issued",
      "exchange.refused",
      "call.authorized",
      "call.refused",
      "key.revoked",
    ] satisfies ModelKeyEvent["type"][]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    const text = JSON.stringify(h.events);
    for (const secret of [
      root.token,
      child.access_token,
      "a secret prompt",
      "dpop",
      "eyJ",
    ]) {
      expect(text).not.toContain(secret);
    }
    const refusal = h.events.find((event) => event.type === "call.refused");
    expect(refusal).toMatchObject({
      reason: "escalation.model",
      providerId: "openai",
      clientId: "app-1",
    });
  });

  it("is not something a failing sink can change the outcome of", async () => {
    const { h, signer, root } = await ready();
    h.sink.fail = true;
    await expect(
      h.exchange(root.token, detail(), { signer }),
    ).resolves.toBeDefined();
    await expectRefused(
      h.exchange(root.token, detail({ models: ["gpt-4"] }), { signer }),
      "invalid_authorization_details",
      "escalation.models",
    );
    await expectRefused(
      h.call(root.token, signer, { body: h.chat({ model: "gpt-4" }) }),
      "insufficient_scope",
      "escalation.model",
    );
  });
});
