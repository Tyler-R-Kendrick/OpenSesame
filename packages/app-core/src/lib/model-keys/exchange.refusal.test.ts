import { describe, expect, it } from "vitest";
import { detail, ready } from "./harness.fixtures.test-support.js";
import {
  ENDPOINT,
  expectRefused,
  type harness,
  type newSigner,
} from "./harness.test-support.js";
import { paramsFromSearch } from "./request.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from "./vocabulary.js";

const TINY = {
  requests: 1,
  input_tokens: 1,
  output_tokens: 1,
  max_output_tokens: 1,
};

/** What a key may still spend, as its owner sees it. */
function remainingOf(h: ReturnType<typeof harness>, id: string) {
  return h.broker.list().find((view) => view.id === id)?.remaining;
}

/** Roots of other clients until the ledger holds exactly `rows` keys. */
async function fillTo(
  h: ReturnType<typeof harness>,
  signer: Awaited<ReturnType<typeof newSigner>>,
  rows: number,
) {
  for (let i = h.broker.list().length; i < rows; i += 1)
    await h.root(signer, { clientId: `filler-${i}` });
}

describe("a refused exchange leaves its parent as it was", () => {
  it("does not spend the parent's budget when the ledger is full, however often it is retried", async () => {
    const { h, signer, root } = await ready();
    await fillTo(h, signer, 256);
    const before = remainingOf(h, root.id);
    expect(before).toEqual({
      requests: 100,
      input_tokens: 100_000,
      output_tokens: 50_000,
    });
    const snapshot = JSON.stringify(h.broker.list());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expectRefused(
        h.exchange(root.token, detail({ budget: TINY }), { signer }),
        "temporarily_unavailable",
        "ledger.full",
      );
      expect(remainingOf(h, root.id)).toEqual(before);
      expect(JSON.stringify(h.broker.list())).toBe(snapshot);
    }
  });

  it("still carves a child out of the parent once there is room", async () => {
    const { h, signer, root } = await ready();
    await fillTo(h, signer, 256);
    await expectRefused(
      h.exchange(root.token, detail({ budget: TINY }), { signer }),
      "temporarily_unavailable",
      "ledger.full",
    );
    await h.broker.revoke({ clientId: "filler-1" });
    const issued = await h.exchange(root.token, detail({ budget: TINY }), {
      signer,
    });
    expect(issued.access_token).toMatch(/^osk_/);
    expect(remainingOf(h, root.id)).toEqual({
      requests: 99,
      input_tokens: 99_999,
      output_tokens: 49_999,
    });
  });
});

describe("keys that have ended make room", () => {
  it("counts only live children toward the limit of 32, so expired ones never block a root", async () => {
    const { h, signer, root } = await ready();
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 32; i += 1)
        await h.exchange(
          root.token,
          detail({ budget: TINY, lifetime_seconds: 60 }),
          { signer },
        );
      await expectRefused(
        h.exchange(root.token, detail({ budget: TINY }), { signer }),
        "access_denied",
        "children.limit",
      );
      h.clock.now += 61_000;
    }
    await expect(
      h.exchange(root.token, detail({ budget: TINY }), { signer }),
    ).resolves.toBeDefined();
  });

  it("returns an expired child's allowance to its parent once, and forgets the row", async () => {
    const { h, signer, root } = await ready();
    for (let round = 0; round < 4; round += 1) {
      for (let i = 0; i < 20; i += 1)
        await h.exchange(
          root.token,
          detail({ budget: TINY, lifetime_seconds: 60 }),
          { signer },
        );
      h.clock.now += 61_000;
    }
    // every child is dead and gave back what it held, and nothing was created
    expect(remainingOf(h, root.id)).toEqual({
      requests: 100 - 20 + 20,
      input_tokens: 100_000,
      output_tokens: 50_000,
    });
    await h.exchange(root.token, detail({ budget: TINY }), { signer });
    expect(h.broker.list().length).toBeLessThanOrEqual(2);
    expect(remainingOf(h, root.id)).toEqual({
      requests: 99,
      input_tokens: 99_999,
      output_tokens: 49_999,
    });
  });

  it("counts what a dead child spent as spent, never as returned", async () => {
    const { h, signer, root } = await ready();
    const child = await h.exchange(
      root.token,
      detail({
        budget: {
          ...TINY,
          requests: 10,
          input_tokens: 100,
          output_tokens: 100,
        },
        lifetime_seconds: 60,
      }),
      { signer },
    );
    const authorized = await h.call(child.access_token, signer, {
      body: h.chat({ max_tokens: 1 }),
    });
    h.broker.settle(authorized.reservation, {
      sent: true,
      answer: { usage: { prompt_tokens: 3, completion_tokens: 1 } },
    });
    h.clock.now += 61_000;
    await h.exchange(root.token, detail({ budget: TINY }), { signer });
    await h.exchange(root.token, detail({ budget: TINY }), { signer });
    // the dead child spent 1 request and 3 + 1 tokens; the rest came back once
    expect(remainingOf(h, root.id)).toEqual({
      requests: 100 - 1 - 2,
      input_tokens: 100_000 - 3 - 2,
      output_tokens: 50_000 - 1 - 2,
    });
  });

  it("frees a full ledger of dead keys without a new root", async () => {
    const { h, signer, root } = await ready();
    await fillTo(h, signer, 255);
    await h.exchange(
      root.token,
      detail({ budget: TINY, lifetime_seconds: 60 }),
      {
        signer,
      },
    );
    expect(h.broker.list()).toHaveLength(256);
    await expectRefused(
      h.root(signer, { clientId: "one-too-many" }),
      "temporarily_unavailable",
      "ledger.full",
    );
    h.clock.now += 61_000;
    await expect(
      h.exchange(root.token, detail({ budget: TINY }), { signer }),
    ).resolves.toBeDefined();
  });
});

describe("a hostile parameter name is refused at the exchange", () => {
  const query = (token: string, ...extra: string[]) =>
    [
      `grant_type=${encodeURIComponent(TOKEN_EXCHANGE_GRANT)}`,
      `subject_token=${token}`,
      `subject_token_type=${encodeURIComponent(ACCESS_TOKEN_TYPE)}`,
      ...extra,
    ].join("&");
  const context = { clientId: "app-1", endpoint: ENDPOINT };

  it("refuses __proto__ as an unknown parameter, and says so in the audit reason", async () => {
    const { h, root } = await ready();
    await expectRefused(
      h.broker.exchange(
        paramsFromSearch(query(root.token, "__proto__=x")),
        context,
      ),
      "invalid_request",
      "param.unknown",
    );
    expect(h.events.at(-1)).toMatchObject({
      type: "exchange.refused",
      reason: "param.unknown",
    });
    expect(h.broker.list()).toHaveLength(1);
  });

  it("refuses a repeated __proto__ before it reaches the exchange", async () => {
    const { h, root } = await ready();
    await expectRefused(
      () =>
        h.broker.exchange(
          paramsFromSearch(query(root.token, "__proto__=x", "__proto__=y")),
          context,
        ),
      "invalid_request",
      "param.duplicate",
    );
  });
});
