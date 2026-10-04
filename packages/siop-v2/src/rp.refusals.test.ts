import { describe, expect, it } from "vitest";
import { buildSelfIssuedIdToken } from "./id-token.js";
import {
  CLIENT,
  ISSUER,
  T0,
  answerFor,
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
    const started = await rp.startLogin();
    expect(
      await codeOf(async () =>
        rp.completeLogin(
          answerFor(started, await mint(keys, { nonce: "other" })),
        ),
      ),
    ).toBe("nonce_mismatch");
    const result = await rp.completeLogin(
      answerFor(started, await mint(keys, { nonce: started.nonce })),
    );
    expect(result.state).toBe(started.state);
  });

  it("closes a login after three failures", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const started = await rp.startLogin();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await codeOf(async () =>
          rp.completeLogin(
            answerFor(started, await mint(keys, { nonce: "bad" })),
          ),
        ),
      ).toBe("nonce_mismatch");
    }
    expect(
      await codeOf(async () =>
        rp.completeLogin(
          answerFor(started, await mint(keys, { nonce: started.nonce })),
        ),
      ),
    ).toBe("login_unknown");
  });

  it("refuses another audience", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const started = await rp.startLogin();
    expect(
      await codeOf(async () =>
        rp.completeLogin(
          answerFor(
            started,
            await mint(keys, {
              nonce: started.nonce,
              audience: "local_11111111-1111-4111-8111-111111111111",
            }),
          ),
        ),
      ),
    ).toBe("audience_mismatch");
  });

  it("refuses another issuer, including the static one", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const started = await rp.startLogin();
    expect(
      await codeOf(async () =>
        rp.completeLogin(
          answerFor(
            started,
            await mint(keys, {
              nonce: started.nonce,
              issuer: "https://evil.example/OpenSesame/identity/siop",
            }),
          ),
        ),
      ),
    ).toBe("issuer_mismatch");
    const staticToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience: CLIENT,
      nonce: started.nonce,
      publicJwk: keys.publicJwk,
      signingKey: keys.privateKey,
      nowSeconds: Math.floor(T0 / 1000),
    });
    expect(
      await codeOf(() => rp.completeLogin(answerFor(started, staticToken))),
    ).toBe("issuer_mismatch");
  });

  it("refuses an expired token and one from the future", async () => {
    const { rp, clock } = relyingParty({ loginTtlMs: 3_600_000 });
    const keys = await p256Pair();
    const started = await rp.startLogin();
    clock.now = T0 + 20 * 60_000;
    expect(
      await codeOf(async () =>
        rp.completeLogin(
          answerFor(
            started,
            await mint(keys, { nonce: started.nonce, at: T0, ttl: 60 }),
          ),
        ),
      ),
    ).toBe("token_expired");
    clock.now = T0 + 60_000;
    expect(
      await codeOf(async () =>
        rp.completeLogin(
          answerFor(
            started,
            await mint(keys, { nonce: started.nonce, at: T0 + 3_600_000 }),
          ),
        ),
      ),
    ).toBe("token_not_fresh");
  });

  it("refuses a tampered signature and a key that does not match sub_jwk", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const attacker = await p256Pair();
    const started = await rp.startLogin();
    const good = await mint(keys, { nonce: started.nonce });
    const flipped = `${good.slice(0, -4)}${good.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    expect(
      await codeOf(() => rp.completeLogin(answerFor(started, flipped))),
    ).toBe("signature_invalid");
    // The attacker advertises the victim's sub_jwk but signs with their own key.
    const forged = await buildSelfIssuedIdToken({
      profile: { kind: "dynamic", issuer: ISSUER },
      audience: CLIENT,
      nonce: started.nonce,
      publicJwk: keys.publicJwk,
      signingKey: attacker.privateKey,
      nowSeconds: Math.floor(T0 / 1000),
    });
    expect(
      await codeOf(() => rp.completeLogin(answerFor(started, forged))),
    ).toBe("signature_invalid");
  });

  // Mutation-style: the token, state, nonce, audience and binding are all
  // right, and the control below shows they are. Only the address the response
  // arrived at differs, so a kit whose redirect_uri comparison were removed (or
  // loosened to origin or path alone) would answer these instead of refusing.
  it("refuses a response that arrives at a different redirect_uri", async () => {
    const keys = await p256Pair();
    for (const receivedRedirectUri of [
      "https://rp.example/other-callback",
      "https://evil.example/callback",
      "https://rp.example/callback?extra=1",
      "https://rp.example/callback/",
      "http://rp.example/callback",
    ]) {
      // A login each: three refusals close one (see above).
      const { rp } = relyingParty();
      const started = await rp.startLogin();
      const token = await mint(keys, { nonce: started.nonce });
      expect(
        await codeOf(() =>
          rp.completeLogin(answerFor(started, token, { receivedRedirectUri })),
        ),
        receivedRedirectUri,
      ).toBe("redirect_mismatch");
      // The control: the same token, state, nonce and binding at the right
      // address are accepted, so the address was the only thing wrong.
      const result = await rp.completeLogin(answerFor(started, token));
      expect(result.state).toBe(started.state);
    }
  });

  it("refuses a state it never issued, and no state at all", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const started = await rp.startLogin();
    const token = await mint(keys, { nonce: "n" });
    expect(
      await codeOf(() =>
        rp.completeLogin(
          answerFor(started, token, { response: fragment(token, "nope") }),
        ),
      ),
    ).toBe("login_unknown");
    expect(
      await codeOf(() =>
        rp.completeLogin(
          answerFor(started, token, { response: `#id_token=${token}` }),
        ),
      ),
    ).toBe("missing_state");
  });

  it("refuses a login that waited past its lifetime", async () => {
    const { rp, clock } = relyingParty({ loginTtlMs: 60_000 });
    const keys = await p256Pair();
    const started = await rp.startLogin();
    clock.now = T0 + 61_000;
    expect(
      await codeOf(async () =>
        rp.completeLogin(
          answerFor(
            started,
            await mint(keys, { nonce: started.nonce, at: clock.now }),
          ),
        ),
      ),
    ).toBe("login_expired");
  });

  it("reports an OP error to the browser that started the login, and closes it", async () => {
    const { rp } = relyingParty();
    const started = await rp.startLogin();
    const denied = answerFor(started, "unused", {
      response: `#error=access_denied&state=${started.state}`,
    });
    try {
      await rp.completeLogin(denied);
      expect.unreachable("expected provider_error");
    } catch (error) {
      expect(error).toBeInstanceOf(SiopRpError);
      if (error instanceof SiopRpError) {
        expect(error.code).toBe("provider_error");
        expect(error.providerError).toBe("access_denied");
      }
    }
    expect(await codeOf(() => rp.completeLogin(denied))).toBe("login_unknown");
  });

  it("refuses a response that is not a fragment response at all", async () => {
    const { rp } = relyingParty();
    const started = await rp.startLogin();
    for (const response of ["#nothing=here", ""]) {
      expect(
        await codeOf(() =>
          rp.completeLogin(answerFor(started, "unused", { response })),
        ),
        response,
      ).toBe("malformed_request");
    }
  });
});
