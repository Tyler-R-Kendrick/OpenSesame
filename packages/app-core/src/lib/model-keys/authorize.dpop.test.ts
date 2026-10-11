import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { ready } from "./harness.fixtures.test-support.js";
import {
  OPENAI,
  expectRefused,
  makeProof,
  newSigner,
} from "./harness.test-support.js";

describe("proof of possession on a call", () => {
  async function bound() {
    const r = await ready();
    const url = `${OPENAI.baseUrl}/chat/completions`;
    const proof = (
      options: Partial<Parameters<typeof makeProof>[1]> = {},
      who = r.signer,
    ) =>
      makeProof(who, {
        htm: "POST",
        htu: url,
        token: r.token,
        now: r.h.clock.now,
        ...options,
      });
    const send = (p: string | null, body: BoundaryValue = r.h.chat()) =>
      r.h.call(r.token, null, { body, proof: p });
    return { ...r, proof, send, url };
  }

  it("accepts a good proof once, and refuses it the second time", async () => {
    const { proof, send } = await bound();
    const p = await proof();
    await expect(send(p)).resolves.toBeDefined();
    await expectRefused(send(p), "invalid_dpop_proof", "dpop.replay");
  });

  it("requires a proof from a bound key, and the right key's", async () => {
    const { send, proof } = await bound();
    await expectRefused(send(null), "invalid_dpop_proof", "dpop.required");
    await expectRefused(
      send(await proof({}, await newSigner())),
      "invalid_dpop_proof",
      "dpop.key_mismatch",
    );
  });

  it("holds the proof to this method, this URL and this key", async () => {
    const { send, proof, token } = await bound();
    await expectRefused(
      send(await proof({ htm: "GET" })),
      "invalid_dpop_proof",
      "dpop.htm",
    );
    await expectRefused(
      send(await proof({ htu: `${OPENAI.baseUrl}/models` })),
      "invalid_dpop_proof",
      "dpop.htu",
    );
    await expectRefused(
      send(
        await proof({ htu: "https://api.anthropic.com/v1/chat/completions" }),
      ),
      "invalid_dpop_proof",
      "dpop.htu",
    );
    await expectRefused(
      send(await proof({ token: `osk_${"B".repeat(43)}` })),
      "invalid_dpop_proof",
      "dpop.ath",
    );
    await expectRefused(
      send(await proof({ ath: null })),
      "invalid_dpop_proof",
      "dpop.ath",
    );
    await expectRefused(
      send(await proof({ ath: token })),
      "invalid_dpop_proof",
      "dpop.ath",
    );
    // the query string is not part of what a proof binds (RFC 9449 §4.2)
    await expect(
      send(await proof({ htu: `${OPENAI.baseUrl}/chat/completions?x=1` })),
    ).resolves.toBeDefined();
  });

  it("holds the proof to the moment", async () => {
    const { send, proof, h } = await bound();
    await expectRefused(
      send(await proof({ iat: Math.floor(h.clock.now / 1000) - 301 })),
      "invalid_dpop_proof",
      "dpop.iat",
    );
    await expectRefused(
      send(await proof({ iat: Math.floor(h.clock.now / 1000) + 61 })),
      "invalid_dpop_proof",
      "dpop.iat",
    );
    await expectRefused(
      send(await proof({ claims: { iat: 1.5 } })),
      "invalid_dpop_proof",
      "dpop.iat",
    );
    await expectRefused(
      send(await proof({ claims: { iat: "now" } })),
      "invalid_dpop_proof",
      "dpop.iat",
    );
    await expect(
      send(await proof({ iat: Math.floor(h.clock.now / 1000) - 299 })),
    ).resolves.toBeDefined();
  });

  it("refuses a proof that is not the kind it must be", async () => {
    const { send, proof, signer, h, url } = await bound();
    await expectRefused(
      send(await proof({ typ: "JWT" })),
      "invalid_dpop_proof",
      "dpop.typ",
    );
    // `none` has an empty signature, and a symmetric alg is not a proof of a key
    const unsigned = (header: JsonObject, claims: JsonObject) =>
      [header, claims]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .join(".");
    await expectRefused(
      send(`${unsigned({ alg: "none", typ: "dpop+jwt" }, {})}.`),
      "invalid_dpop_proof",
      "dpop.shape",
    );
    const hs256 = await new SignJWT({
      jti: "x".repeat(20),
      htm: "POST",
      htu: url,
      iat: Math.floor(h.clock.now / 1000),
    })
      .setProtectedHeader({ alg: "HS256", typ: "dpop+jwt", jwk: signer.jwk })
      .sign(new TextEncoder().encode("secret-secret-secret-secret-secret!"));
    await expectRefused(send(hs256), "invalid_dpop_proof", "dpop.alg");
    await expectRefused(
      send(await proof({ jti: "short" })),
      "invalid_dpop_proof",
      "dpop.jti",
    );
    await expectRefused(
      send(await proof({ jti: "x".repeat(200) })),
      "invalid_dpop_proof",
      "dpop.jti",
    );
    // a proof that is not even a string: only the runtime can tell
    const notAString: string = overlapCast(42);
    for (const bad of [
      null,
      "",
      "abc",
      "a.b",
      "a.b.c.d",
      `${"a".repeat(5000)}.b.c`,
      "a b.c.d",
      notAString,
    ]) {
      await expectRefused(
        send(bad),
        "invalid_dpop_proof",
        bad === null ? "dpop.required" : "dpop.shape",
      );
    }
  });

  it("refuses a proof whose key carries anything but a public P-256 key", async () => {
    const { send, proof, signer } = await bound();
    await expectRefused(
      send(await proof({ header: { jwk: { ...signer.jwk, d: "AAAA" } } })),
      "invalid_dpop_proof",
      "dpop.jwk_members",
    );
    await expectRefused(
      send(await proof({ header: { jwk: { ...signer.jwk, kid: "x" } } })),
      "invalid_dpop_proof",
      "dpop.jwk_members",
    );
    await expectRefused(
      send(await proof({ header: { jwk: { ...signer.jwk, crv: "P-384" } } })),
      "invalid_dpop_proof",
      "dpop.jwk_type",
    );
    await expectRefused(
      send(await proof({ header: { jwk: { kty: "oct", k: "AAAA" } } })),
      "invalid_dpop_proof",
      "dpop.jwk_members",
    );
  });

  it("refuses a proof whose signature or payload was touched", async () => {
    const { send, proof } = await bound();
    const good = await proof();
    const [h, p, s] = good.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(p ?? "", "base64url").toString()),
        htm: "POST",
        jti: "forged-jti-0123456789",
      }),
    ).toString("base64url");
    await expectRefused(
      send(`${h}.${forged}.${s}`),
      "invalid_dpop_proof",
      "dpop.signature",
    );
    await expectRefused(
      send(`${h}.${p}.${"A".repeat((s ?? "").length)}`),
      "invalid_dpop_proof",
      "dpop.signature",
    );
  });

  it("tells a thief with only the key nothing about what the key would allow", async () => {
    const { h, token, proof } = await bound();
    const thief = await newSigner();
    // an out-of-policy request, with the wrong key: the answer is about the proof, never the policy
    const bad = h.chat({ model: "gpt-4", max_tokens: 999_999 });
    await expectRefused(
      h.call(token, null, { body: bad, proof: await proof({}, thief) }),
      "invalid_dpop_proof",
      "dpop.key_mismatch",
    );
    await expectRefused(
      h.call(token, null, { body: bad, proof: null }),
      "invalid_dpop_proof",
      "dpop.required",
    );
  });

  it("does not spend a proof it refused", async () => {
    const { send, proof } = await bound();
    const good = await proof();
    // refused for a body it was never meant to cover; a later, valid use of the same proof still works
    await expectRefused(
      send(good, { model: "gpt-4o" }),
      "invalid_request",
      "body.messages",
    );
    await expect(send(good)).resolves.toBeDefined();
  });
});
