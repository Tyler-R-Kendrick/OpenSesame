import { describe, expect, it } from "vitest";
import { ecP256JwkThumbprint } from "./jwk.js";
import {
  MemoryLoginStore,
  type PendingSiopLogin,
  type SiopLoginStore,
} from "./rp-store.js";
import {
  CLIENT,
  ISSUER,
  REDIRECT,
  T0,
  codeOf,
  fragment,
  mint,
  relyingParty,
} from "./rp.fixture.js";
import { type SiopRelyingPartyConfig, generateLocalClientId } from "./rp.js";
import { p256Pair } from "./test-keys.js";

describe("startLogin", () => {
  it("sends the exact request Pages parses, with a fresh state and nonce", async () => {
    const { rp } = relyingParty();
    const first = await rp.startLogin();
    const second = await rp.startLogin();
    const url = new URL(first.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(ISSUER);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "id_token",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      scope: "openid",
      nonce: first.nonce,
      response_mode: "fragment",
      state: first.state,
    });
    expect(first.state).not.toBe(second.state);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.nonce.length).toBeGreaterThanOrEqual(43);
    expect(first.state.length).toBeGreaterThanOrEqual(32);
  });

  it("sends to the authorization endpoint the metadata named", async () => {
    const endpoint = "https://pages.example/OpenSesame/identity/siop";
    const { rp } = relyingParty({ authorizationEndpoint: endpoint });
    const started = await rp.startLogin();
    expect(started.authorizationUrl.startsWith(`${endpoint}?`)).toBe(true);
  });
});

describe("startLogin — one application id per person", () => {
  const OTHER = "local_11111111-1111-4111-8111-111111111111";

  it("sends the application id it is given and expects exactly that audience", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const { state, nonce, authorizationUrl } = await rp.startLogin({
      clientId: OTHER,
    });
    expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe(OTHER);
    // A token for the configured id answers a different login.
    expect(
      await codeOf(async () =>
        rp.completeLogin({
          response: fragment(await mint(keys, { nonce }), state),
        }),
      ),
    ).toBe("audience_mismatch");
    const result = await rp.completeLogin({
      response: fragment(await mint(keys, { nonce, audience: OTHER }), state),
    });
    expect(result.verified.aud).toBe(OTHER);
  });

  it("refuses an id that is not the shape Pages mints", async () => {
    const { rp } = relyingParty();
    for (const clientId of [
      "",
      "https://rp.example",
      "local_x",
      "local_00000000-0000-4000-8000-00000000000g!",
      `${CLIENT}0`,
    ]) {
      expect(await codeOf(() => rp.startLogin({ clientId })), clientId).toBe(
        "invalid_configuration",
      );
    }
  });
});

describe("completeLogin — the login that should succeed", () => {
  it("accepts a token that answers the login and returns the proven subject", async () => {
    const { rp, clock } = relyingParty();
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    clock.now = T0 + 5_000;
    const result = await rp.completeLogin({
      response: fragment(await mint(keys, { nonce }), state),
      receivedRedirectUri: REDIRECT,
    });
    expect(result.subject).toBe(await ecP256JwkThumbprint(keys.publicJwk));
    expect(result.verified.iss).toBe(ISSUER);
    expect(result.verified.aud).toBe(CLIENT);
    expect(result.verified.nonce).toBe(nonce);
    expect(result.state).toBe(state);
  });

  it("accepts the whole callback URL as well as its fragment", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    const result = await rp.completeLogin({
      response: `${REDIRECT}${fragment(await mint(keys, { nonce }), state)}`,
    });
    expect(result.subject).toBe(await ecP256JwkThumbprint(keys.publicJwk));
  });

  it("ignores a fragment and keeps the query when comparing the redirect_uri", async () => {
    const withQuery = `${REDIRECT}?tenant=a`;
    const { rp } = relyingParty({ redirectUri: withQuery });
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    const token = await mint(keys, { nonce });
    expect(
      await codeOf(() =>
        rp.completeLogin({
          response: fragment(token, state),
          receivedRedirectUri: `${REDIRECT}?tenant=b`,
        }),
      ),
    ).toBe("redirect_mismatch");
    const result = await rp.completeLogin({
      response: fragment(token, state),
      receivedRedirectUri: `${withQuery}#id_token=x`,
    });
    expect(result.state).toBe(state);
  });
});

describe("completeLogin — replay", () => {
  it("refuses the same response twice: the state is single use", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    const response = fragment(await mint(keys, { nonce }), state);
    await rp.completeLogin({ response });
    expect(await codeOf(() => rp.completeLogin({ response }))).toBe(
      "login_replayed",
    );
  });

  it("refuses a token captured from one login on another", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const first = await rp.startLogin();
    const stolen = await mint(keys, { nonce: first.nonce });
    await rp.completeLogin({ response: fragment(stolen, first.state) });
    const second = await rp.startLogin();
    // The ledger knows the token: refused before its nonce is even compared.
    expect(
      await codeOf(() =>
        rp.completeLogin({ response: fragment(stolen, second.state) }),
      ),
    ).toBe("token_replayed");
  });

  it("refuses a token captured from one login on another, ledger or not", async () => {
    // Same store, a ledger that remembers nothing (a restart): the nonce is
    // per login, so the stolen token still answers no other login.
    const store = new MemoryLoginStore();
    const { rp: first } = relyingParty({ store });
    const keys = await p256Pair();
    const one = await first.startLogin();
    const stolen = await mint(keys, { nonce: one.nonce });
    await first.completeLogin({ response: fragment(stolen, one.state) });
    const { rp: restarted } = relyingParty({ store });
    const two = await restarted.startLogin();
    expect(
      await codeOf(() =>
        restarted.completeLogin({ response: fragment(stolen, two.state) }),
      ),
    ).toBe("nonce_mismatch");
  });

  it("still refuses a token twice when the login store is not single use", async () => {
    const held = new Map<string, PendingSiopLogin>();
    const leaky: SiopLoginStore = {
      put: (state, login) => {
        held.set(state, login);
      },
      // A broken shared store: it returns the login without removing it.
      take: (state) => held.get(state),
    };
    const { rp } = relyingParty({ store: leaky });
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    const response = fragment(await mint(keys, { nonce }), state);
    await rp.completeLogin({ response });
    expect(await codeOf(() => rp.completeLogin({ response }))).toBe(
      "token_replayed",
    );
  });

  it("lets exactly one of two concurrent completions win", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    const response = fragment(await mint(keys, { nonce }), state);
    const outcomes = await Promise.all([
      codeOf(() => rp.completeLogin({ response })),
      codeOf(() => rp.completeLogin({ response })),
    ]);
    expect(outcomes.filter((code) => code === "no-refusal")).toHaveLength(1);
    expect(outcomes.filter((code) => code === "login_unknown")).toHaveLength(1);
  });
});

describe("configuration", () => {
  const bad: Array<[string, Partial<SiopRelyingPartyConfig>]> = [
    ["the static issuer", { issuer: "https://self-issued.me/v2" }],
    ["a plain-http issuer", { issuer: "http://pages.example/identity/siop" }],
    ["an empty client id", { clientId: "" }],
    ["a client id Pages cannot mint", { clientId: "my-app" }],
    ["a plain-http redirect", { redirectUri: "http://rp.example/callback" }],
    ["a redirect with a fragment", { redirectUri: `${REDIRECT}#x` }],
    [
      "a redirect with credentials",
      { redirectUri: "https://u:p@rp.example/cb" },
    ],
    ["a redirect that is not a URL", { redirectUri: "callback" }],
    [
      "an endpoint on another origin",
      { authorizationEndpoint: "https://evil.example/authorize" },
    ],
  ];
  for (const [name, patch] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => relyingParty(patch)).toThrow();
    });
  }

  it("admits loopback http for a development redirect", () => {
    expect(() =>
      relyingParty({ redirectUri: "http://127.0.0.1:4110/callback" }),
    ).not.toThrow();
    expect(() =>
      relyingParty({ redirectUri: "http://localhost:4110/callback" }),
    ).not.toThrow();
  });
});

describe("generateLocalClientId", () => {
  it("has the shape Pages registers: local_<uuid v4>", () => {
    const id = generateLocalClientId();
    expect(id).toMatch(
      /^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(generateLocalClientId()).not.toBe(id);
  });

  it("is deterministic for deterministic bytes", () => {
    const fixed = () => new Uint8Array(16).fill(0xab);
    expect(generateLocalClientId(fixed)).toBe(
      "local_abababab-abab-4bab-abab-abababababab",
    );
  });
});

describe("bounded memory", () => {
  it("a store under pressure evicts its oldest login, never grows past its bound", async () => {
    const store = new MemoryLoginStore(3);
    const { rp } = relyingParty({ store });
    const started = [];
    for (let index = 0; index < 5; index += 1) {
      started.push(await rp.startLogin());
    }
    expect(store.size).toBe(3);
    expect(store.take(started[0]?.state ?? "")).toBeUndefined();
    expect(store.take(started[4]?.state ?? "")).toBeDefined();
  });
});
