import { describe, expect, it } from "vitest";
import { narrow } from "./harness.fixtures.test-support.js";
import {
  ENDPOINT,
  FULL_BUDGET,
  OPENAI,
  expectRefused,
  harness,
  newSigner,
} from "./harness.test-support.js";
import { ACCESS_TOKEN_TYPE, KEY_PATTERN } from "./vocabulary.js";

describe("issuing a root key", () => {
  it("returns a key shaped like no provider's, and keeps only its digest", async () => {
    const h = harness();
    const signer = await newSigner();
    const issued = await h.root(signer);
    expect(issued.token).toMatch(KEY_PATTERN);
    expect(issued.token.startsWith("osk_")).toBe(true);
    expect(JSON.stringify(h.broker.list())).not.toContain(issued.token);
    expect(JSON.stringify(h.events)).not.toContain(issued.token);
    expect(h.broker.list()).toHaveLength(1);
    expect(h.broker.list()[0]).toMatchObject({
      depth: 0,
      status: "active",
      bound: true,
      clientId: "app-1",
    });
  });

  it("refuses a draft the catalog, the connection or the policy cannot support", async () => {
    const h = harness();
    const signer = await newSigner();
    await expectRefused(
      h.root(signer, { resource: "https://nowhere.example.test/v1" }),
      "invalid_target",
      "draft.resource",
    );
    await expectRefused(
      h.root(signer, { connectionId: "conn-anthropic" }),
      "invalid_target",
      "draft.connection",
    );
    await expectRefused(
      h.root(signer, { connectionId: "conn-missing" }),
      "invalid_target",
      "draft.connection",
    );
    h.connections.set("conn-openai", { providerId: "openai", verified: false });
    await expectRefused(h.root(signer), "invalid_target", "draft.connection");
    h.connections.set("conn-openai", { providerId: "openai", verified: true });
    await expectRefused(h.root(null), "invalid_dpop_proof", "dpop.required");
    await expectRefused(
      h.root(signer, { lifetimeSeconds: 9 * 60 * 60 }),
      "invalid_authorization_details",
      "lifetime.ceiling",
    );
    await expectRefused(
      h.root(signer, { maximumDelegationDepth: 3 }),
      "invalid_request",
      "draft.depth",
    );
    await expectRefused(
      h.root(signer, { models: ["gpt-*"] }),
      "invalid_authorization_details",
      "models.entry",
    );
    await expectRefused(
      h.root(signer, {
        budget: {
          requests: 1,
          input_tokens: 1,
          output_tokens: 1,
          max_output_tokens: 99_999,
        },
      }),
      "invalid_authorization_details",
      "budget.ceiling",
    );
    expect(h.broker.list()).toHaveLength(0);
  });

  it("allows an unbound root only when the policy lets keys travel without a key", async () => {
    const h = harness({ senderConstraint: "dpop_optional" });
    const issued = await h.root(null);
    expect(h.broker.list()[0]?.bound).toBe(false);
    expect(issued.token).toMatch(KEY_PATTERN);
  });
});

describe("exchanging a key for a narrower one (RFC 8693)", () => {
  it("issues a derived key bound to the caller's key, with the granted details echoed", async () => {
    const h = harness();
    const signer = await newSigner();
    const parent = await h.root(signer);
    const response = await h.exchange(parent.token, narrow(), { signer });
    expect(response.access_token).toMatch(KEY_PATTERN);
    expect(response.access_token).not.toBe(parent.token);
    expect(response.issued_token_type).toBe(ACCESS_TOKEN_TYPE);
    expect(response.token_type).toBe("DPoP");
    expect(response.expires_in).toBe(600);
    expect(response.scope).toBe("model.invoke");
    expect(response.resource).toBe(OPENAI.baseUrl);
    expect(response.authorization_details).toEqual([
      {
        type: "model_access",
        locations: [OPENAI.baseUrl],
        actions: ["model.invoke"],
        models: ["gpt-4o"],
        budget: { ...FULL_BUDGET },
      },
    ]);
    const views = h.broker.list();
    expect(views).toHaveLength(2);
    expect(views.find((view) => view.depth === 1)).toMatchObject({
      parentId: parent.id,
      clientId: "app-1",
      connectionId: "conn-openai",
      models: ["model:openai/gpt-4o"],
      bound: true,
    });
    expect(
      h.events.filter((event) => event.type === "exchange.issued"),
    ).toHaveLength(1);
  });

  it("carves the child's budget out of the parent's, and leaves the parent what is left", async () => {
    const h = harness();
    const signer = await newSigner();
    const parent = await h.root(signer);
    await h.exchange(parent.token, narrow(), { signer });
    const [root] = h.broker.list().filter((view) => view.depth === 0);
    expect(root?.remaining).toEqual({
      requests: 90,
      input_tokens: 90_000,
      output_tokens: 45_000,
    });
  });

  it("can delegate to another key without handing over its own", async () => {
    const h = harness();
    const parentKey = await newSigner();
    const agentKey = await newSigner();
    const parent = await h.root(parentKey);
    const response = await h.exchange(parent.token, narrow(), {
      signer: parentKey,
      extra: { dpop_jkt: agentKey.jkt },
    });
    expect(h.broker.list().find((view) => view.depth === 1)?.bound).toBe(true);
    // the agent can use it with its own key, and the parent's key cannot
    await expect(
      h.call(response.access_token, agentKey, { body: h.chat() }),
    ).resolves.toMatchObject({
      providerId: "openai",
      connectionId: "conn-openai",
    });
    await expectRefused(
      h.call(response.access_token, parentKey, { body: h.chat() }),
      "invalid_dpop_proof",
      "dpop.key_mismatch",
    );
  });

  it("shortens a lifetime longer than the parent's and says so in expires_in", async () => {
    const h = harness();
    const signer = await newSigner();
    const parent = await h.root(signer, { lifetimeSeconds: 120 });
    const response = await h.exchange(
      parent.token,
      narrow({ lifetime_seconds: 3600 }),
      { signer },
    );
    expect(response.expires_in).toBe(120);
    const unaskedLifetime = await h.exchange(
      parent.token,
      (({ lifetime_seconds: _drop, ...rest }) => rest)(narrow()),
      { signer },
    );
    expect(unaskedLifetime.expires_in).toBe(120);
  });

  it("works through the production client's proof format too", async () => {
    // @opensesame/api-client signs with the real clock, so the broker's clock follows it.
    const { createDpopKeyPair } = await import("@opensesame/api-client");
    const h = harness();
    h.clock.now = Date.now();
    const pair = await createDpopKeyPair();
    const { calculateJwkThumbprint } = await import("jose");
    const jkt = await calculateJwkThumbprint(
      {
        kty: String(pair.jwk.kty),
        crv: String(pair.jwk.crv),
        x: String(pair.jwk.x),
        y: String(pair.jwk.y),
      },
      "sha256",
    );
    const parent = await h.root({ jkt }, {});
    const proof = await pair.createDpopProof(ENDPOINT, "POST", parent.token);
    const response = await h.exchange(parent.token, narrow(), { proof });
    expect(response.token_type).toBe("DPoP");
  });
});
