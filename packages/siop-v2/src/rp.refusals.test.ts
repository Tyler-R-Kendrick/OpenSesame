import { describe, expect, it } from "vitest";
import { buildSelfIssuedIdToken } from "./id-token.js";
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
import { SiopRpError } from "./rp.js";
import { p256Pair } from "./test-keys.js";

describe("completeLogin — what a hostile or confused response gets", () => {
  it("refuses a wrong nonce and keeps the login open for the real token", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    expect(
      await codeOf(async () =>
        rp.completeLogin({
          response: fragment(await mint(keys, { nonce: "other" }), state),
        }),
      ),
    ).toBe("nonce_mismatch");
    const result = await rp.completeLogin({
      response: fragment(await mint(keys, { nonce }), state),
    });
    expect(result.state).toBe(state);
  });

  it("closes a login after three failures", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await codeOf(async () =>
          rp.completeLogin({
            response: fragment(await mint(keys, { nonce: "bad" }), state),
          }),
        ),
      ).toBe("nonce_mismatch");
    }
    expect(
      await codeOf(async () =>
        rp.completeLogin({
          response: fragment(await mint(keys, { nonce }), state),
        }),
      ),
    ).toBe("login_unknown");
  });

  it("refuses another audience", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    expect(
      await codeOf(async () =>
        rp.completeLogin({
          response: fragment(
            await mint(keys, {
              nonce,
              audience: "local_11111111-1111-4111-8111-111111111111",
            }),
            state,
          ),
        }),
      ),
    ).toBe("audience_mismatch");
  });

  it("refuses another issuer, including the static one", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    expect(
      await codeOf(async () =>
        rp.completeLogin({
          response: fragment(
            await mint(keys, {
              nonce,
              issuer: "https://evil.example/OpenSesame/identity/siop",
            }),
            state,
          ),
        }),
      ),
    ).toBe("issuer_mismatch");
    const staticToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience: CLIENT,
      nonce,
      publicJwk: keys.publicJwk,
      signingKey: keys.privateKey,
      nowSeconds: Math.floor(T0 / 1000),
    });
    expect(
      await codeOf(() =>
        rp.completeLogin({ response: fragment(staticToken, state) }),
      ),
    ).toBe("issuer_mismatch");
  });

  it("refuses an expired token and one from the future", async () => {
    const { rp, clock } = relyingParty({ loginTtlMs: 3_600_000 });
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    clock.now = T0 + 20 * 60_000;
    expect(
      await codeOf(async () =>
        rp.completeLogin({
          response: fragment(
            await mint(keys, { nonce, at: T0, ttl: 60 }),
            state,
          ),
        }),
      ),
    ).toBe("token_expired");
    clock.now = T0 + 60_000;
    expect(
      await codeOf(async () =>
        rp.completeLogin({
          response: fragment(
            await mint(keys, { nonce, at: T0 + 3_600_000 }),
            state,
          ),
        }),
      ),
    ).toBe("token_not_fresh");
  });

  it("refuses a tampered signature and a key that does not match sub_jwk", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const attacker = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    const good = await mint(keys, { nonce });
    const flipped = `${good.slice(0, -4)}${good.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    expect(
      await codeOf(() =>
        rp.completeLogin({ response: fragment(flipped, state) }),
      ),
    ).toBe("signature_invalid");
    // The attacker advertises the victim's sub_jwk but signs with their own key.
    const forged = await buildSelfIssuedIdToken({
      profile: { kind: "dynamic", issuer: ISSUER },
      audience: CLIENT,
      nonce,
      publicJwk: keys.publicJwk,
      signingKey: attacker.privateKey,
      nowSeconds: Math.floor(T0 / 1000),
    });
    expect(
      await codeOf(() =>
        rp.completeLogin({ response: fragment(forged, state) }),
      ),
    ).toBe("signature_invalid");
  });

  it("refuses a response that arrives at a different redirect_uri", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    const response = fragment(await mint(keys, { nonce }), state);
    expect(
      await codeOf(() =>
        rp.completeLogin({
          response,
          receivedRedirectUri: "https://rp.example/other-callback",
        }),
      ),
    ).toBe("redirect_mismatch");
    expect(
      await codeOf(() =>
        rp.completeLogin({
          response,
          receivedRedirectUri: "https://evil.example/callback",
        }),
      ),
    ).toBe("redirect_mismatch");
    const result = await rp.completeLogin({
      response,
      receivedRedirectUri: REDIRECT,
    });
    expect(result.state).toBe(state);
  });

  it("refuses a state it never issued, and no state at all", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    expect(
      await codeOf(async () =>
        rp.completeLogin({
          response: fragment(await mint(keys, { nonce: "n" }), "nope"),
        }),
      ),
    ).toBe("login_unknown");
    expect(
      await codeOf(async () =>
        rp.completeLogin({
          response: `#id_token=${await mint(keys, { nonce: "n" })}`,
        }),
      ),
    ).toBe("missing_state");
  });

  it("refuses a login that waited past its lifetime", async () => {
    const { rp, clock } = relyingParty({ loginTtlMs: 60_000 });
    const keys = await p256Pair();
    const { state, nonce } = await rp.startLogin();
    clock.now = T0 + 61_000;
    expect(
      await codeOf(async () =>
        rp.completeLogin({
          response: fragment(await mint(keys, { nonce, at: clock.now }), state),
        }),
      ),
    ).toBe("login_expired");
  });

  it("reports an OP error and closes the login", async () => {
    const { rp } = relyingParty();
    const { state } = await rp.startLogin();
    const denied = `#error=access_denied&state=${state}`;
    try {
      await rp.completeLogin({ response: denied });
      expect.unreachable("expected provider_error");
    } catch (error) {
      expect(error).toBeInstanceOf(SiopRpError);
      if (error instanceof SiopRpError) {
        expect(error.code).toBe("provider_error");
        expect(error.providerError).toBe("access_denied");
      }
    }
    expect(await codeOf(() => rp.completeLogin({ response: denied }))).toBe(
      "login_unknown",
    );
  });

  it("refuses a response that is not a fragment response at all", async () => {
    const { rp } = relyingParty();
    expect(
      await codeOf(() => rp.completeLogin({ response: "#nothing=here" })),
    ).toBe("malformed_request");
    expect(await codeOf(() => rp.completeLogin({ response: "" }))).toBe(
      "malformed_request",
    );
  });
});
