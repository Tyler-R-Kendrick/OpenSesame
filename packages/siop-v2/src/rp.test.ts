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
  answerFor,
  codeOf,
  fragment,
  mint,
  relyingParty,
} from "./rp.fixture.js";
import { type SiopRelyingPartyConfig, generateLocalClientId } from "./rp.js";
import { p256Pair } from "./test-keys.js";

describe("startLogin", () => {
  it("sends the exact request Pages parses, with a fresh state, nonce and binding", async () => {
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
    expect(first.binding).not.toBe(second.binding);
    expect(first.nonce.length).toBeGreaterThanOrEqual(43);
    expect(first.state.length).toBeGreaterThanOrEqual(32);
    expect(first.binding.length).toBeGreaterThanOrEqual(43);
    // The binding is for the browser alone: the OP is never told it.
    expect(first.authorizationUrl).not.toContain(first.binding);
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
    const started = await rp.startLogin({ clientId: OTHER });
    expect(
      new URL(started.authorizationUrl).searchParams.get("client_id"),
    ).toBe(OTHER);
    // A token for the configured id answers a different login.
    expect(
      await codeOf(async () =>
        rp.completeLogin(
          answerFor(started, await mint(keys, { nonce: started.nonce })),
        ),
      ),
    ).toBe("audience_mismatch");
    const result = await rp.completeLogin(
      answerFor(
        started,
        await mint(keys, { nonce: started.nonce, audience: OTHER }),
      ),
    );
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

describe("startLogin — more than one registered callback", () => {
  const MOBILE = "https://rp.example/callback/mobile";

  it("sends a login to an allowed callback and expects the response there", async () => {
    const { rp } = relyingParty({ allowedRedirectUris: [MOBILE] });
    const keys = await p256Pair();
    const started = await rp.startLogin({ redirectUri: MOBILE });
    expect(
      new URL(started.authorizationUrl).searchParams.get("redirect_uri"),
    ).toBe(MOBILE);
    const token = await mint(keys, { nonce: started.nonce });
    expect(
      await codeOf(() => rp.completeLogin(answerFor(started, token))),
    ).toBe("redirect_mismatch");
    const result = await rp.completeLogin(
      answerFor(started, token, { receivedRedirectUri: MOBILE }),
    );
    expect(result.state).toBe(started.state);
  });

  it("refuses a callback nobody registered, before any login exists", async () => {
    const store = new MemoryLoginStore();
    const { rp } = relyingParty({ allowedRedirectUris: [MOBILE], store });
    for (const redirectUri of [
      "https://rp.example/elsewhere",
      "https://evil.example/callback",
      `${REDIRECT}?extra=1`,
    ]) {
      expect(
        await codeOf(() => rp.startLogin({ redirectUri })),
        redirectUri,
      ).toBe("invalid_configuration");
    }
    expect(store.size).toBe(0);
  });
});

describe("completeLogin — the login that should succeed", () => {
  it("accepts a token that answers the login and returns the proven subject", async () => {
    const { rp, clock } = relyingParty();
    const keys = await p256Pair();
    const started = await rp.startLogin();
    clock.now = T0 + 5_000;
    const result = await rp.completeLogin(
      answerFor(started, await mint(keys, { nonce: started.nonce })),
    );
    expect(result.subject).toBe(await ecP256JwkThumbprint(keys.publicJwk));
    expect(result.verified.iss).toBe(ISSUER);
    expect(result.verified.aud).toBe(CLIENT);
    expect(result.verified.nonce).toBe(started.nonce);
    expect(result.state).toBe(started.state);
  });

  it("accepts the whole callback URL as well as its fragment", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const started = await rp.startLogin();
    const token = await mint(keys, { nonce: started.nonce });
    const result = await rp.completeLogin(
      answerFor(started, token, {
        response: `${REDIRECT}${fragment(token, started.state)}`,
      }),
    );
    expect(result.subject).toBe(await ecP256JwkThumbprint(keys.publicJwk));
  });

  it("ignores a fragment and keeps the query when comparing the redirect_uri", async () => {
    const withQuery = `${REDIRECT}?tenant=a`;
    const { rp } = relyingParty({ redirectUri: withQuery });
    const keys = await p256Pair();
    const started = await rp.startLogin();
    const token = await mint(keys, { nonce: started.nonce });
    expect(
      await codeOf(() =>
        rp.completeLogin(
          answerFor(started, token, {
            receivedRedirectUri: `${REDIRECT}?tenant=b`,
          }),
        ),
      ),
    ).toBe("redirect_mismatch");
    const result = await rp.completeLogin(
      answerFor(started, token, {
        receivedRedirectUri: `${withQuery}#id_token=x`,
      }),
    );
    expect(result.state).toBe(started.state);
  });

  it("will not complete without saying where the response arrived", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const started = await rp.startLogin();
    const token = await mint(keys, { nonce: started.nonce });
    const input = answerFor(started, token);
    expect(
      await codeOf(() =>
        // @ts-expect-error the address the response arrived at is required
        rp.completeLogin({ response: input.response, binding: input.binding }),
      ),
    ).toBe("redirect_mismatch");
  });
});

describe("completeLogin — replay", () => {
  it("refuses the same response twice: the state is single use", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const started = await rp.startLogin();
    const input = answerFor(
      started,
      await mint(keys, { nonce: started.nonce }),
    );
    await rp.completeLogin(input);
    expect(await codeOf(() => rp.completeLogin(input))).toBe("login_replayed");
  });

  it("refuses a token captured from one login on another", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const first = await rp.startLogin();
    const stolen = await mint(keys, { nonce: first.nonce });
    await rp.completeLogin(answerFor(first, stolen));
    const second = await rp.startLogin();
    // The ledger knows the token: refused before its nonce is even compared.
    expect(
      await codeOf(() => rp.completeLogin(answerFor(second, stolen))),
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
    await first.completeLogin(answerFor(one, stolen));
    const { rp: restarted } = relyingParty({ store });
    const two = await restarted.startLogin();
    expect(
      await codeOf(() => restarted.completeLogin(answerFor(two, stolen))),
    ).toBe("nonce_mismatch");
  });

  it("still refuses a token twice when the login store is not single use", async () => {
    const held = new Map<string, PendingSiopLogin>();
    const leaky: SiopLoginStore = {
      put: (state, login) => {
        held.set(state, login);
        return true;
      },
      // A broken shared store: it returns the login without removing it.
      take: (state) => held.get(state),
    };
    const { rp } = relyingParty({ store: leaky });
    const keys = await p256Pair();
    const started = await rp.startLogin();
    const input = answerFor(
      started,
      await mint(keys, { nonce: started.nonce }),
    );
    await rp.completeLogin(input);
    expect(await codeOf(() => rp.completeLogin(input))).toBe("token_replayed");
  });

  it("lets exactly one of two concurrent completions win", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const started = await rp.startLogin();
    const input = answerFor(
      started,
      await mint(keys, { nonce: started.nonce }),
    );
    const outcomes = await Promise.all([
      codeOf(() => rp.completeLogin(input)),
      codeOf(() => rp.completeLogin(input)),
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
      "an allowed redirect that is plain http",
      { allowedRedirectUris: ["http://rp.example/other"] },
    ],
    [
      "an endpoint on another origin",
      { authorizationEndpoint: "https://evil.example/authorize" },
    ],
    [
      "an endpoint that carries a query",
      { authorizationEndpoint: `${ISSUER}?prompt=none` },
    ],
  ];
  for (const [name, patch] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => relyingParty(patch)).toThrow();
    });
  }

  it("refuses loopback http unless the caller opts in", () => {
    const loopback = {
      redirectUri: "http://127.0.0.1:4110/callback",
    } as const;
    expect(() => relyingParty(loopback)).toThrow();
    expect(() =>
      relyingParty({ ...loopback, allowLoopbackHttp: true }),
    ).not.toThrow();
    expect(() =>
      relyingParty({
        redirectUri: "http://localhost:4110/callback",
        allowLoopbackHttp: true,
      }),
    ).not.toThrow();
    expect(() =>
      relyingParty({
        issuer: "http://localhost:5180/OpenSesame/identity/siop",
        allowLoopbackHttp: true,
      }),
    ).not.toThrow();
    expect(() =>
      relyingParty({
        issuer: "http://localhost:5180/OpenSesame/identity/siop",
      }),
    ).toThrow();
  });

  it("still refuses plain http to a host that is not loopback, opted in or not", () => {
    expect(() =>
      relyingParty({
        redirectUri: "http://rp.example/callback",
        allowLoopbackHttp: true,
      }),
    ).toThrow();
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
