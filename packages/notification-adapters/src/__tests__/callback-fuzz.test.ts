/**
 * Every callback verifier, fed garbage, from both sides of the signature.
 *
 * A verifier is the one function in this package that an unauthenticated
 * stranger can call, as many times as they like, with any bytes they choose.
 * Two properties are asserted over a few hundred generated bodies:
 *
 * 1. **It never throws.** An exception out of a verifier is a 500 where a
 *    refusal was meant, and a 500 is a far more interesting reply than "no".
 * 2. **It never says yes.** None of these bodies is a real interaction, so
 *    every one of them must come back `ok: false` — including the ones fed
 *    through with a *valid* signature, which is the pass that actually
 *    exercises the parsers rather than stopping at the MAC.
 */

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createSlackAdapter } from "../adapters/slack.js";
import { createTelegramAdapter } from "../adapters/telegram.js";
import { createWeChatAdapter, wechatSignature } from "../adapters/wechat.js";
import type {
  CallbackRequest,
  CallbackVerification,
  ChannelAdapter,
} from "../contract.js";
import { FIXED_NOW, seededBytes } from "./helpers.js";

const SLACK_SECRET = "slack-signing-secret-for-tests-only";
const TELEGRAM_SECRET = "telegram-webhook-secret-for-tests-only";
const WECHAT_TOKEN = "opensesame-oa-token";
const NOW_SECONDS = String(Math.floor(FIXED_NOW.getTime() / 1000));

function adapters(): ChannelAdapter[] {
  return [
    createSlackAdapter({
      botToken: "xoxb-t",
      signingSecret: SLACK_SECRET,
      now: () => FIXED_NOW,
    }),
    createTelegramAdapter({
      botToken: "1:t",
      callbackSecretToken: TELEGRAM_SECRET,
    }),
    createWeChatAdapter({
      appId: "wx1",
      token: WECHAT_TOKEN,
      now: () => FIXED_NOW,
    }),
  ];
}

/**
 * Bodies that have broken a parser somewhere before, plus a long tail of
 * seeded noise. Truncated JSON, unbalanced XML, oversized input, lone
 * surrogates, deep nesting, and prototype-pollution bait.
 */
function hostileBodies(): Uint8Array[] {
  const encoder = new TextEncoder();
  const fixed = [
    "",
    " ",
    "{",
    "}",
    "[",
    "null",
    "0",
    '"',
    '{"a":',
    '{"team":{"id":',
    "payload=",
    "payload=%7B",
    `payload=${encodeURIComponent('{"team":{"id":')}`,
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{"x":1}}}',
    '{"update_id":"not-a-number"}',
    '{"update_id":1e999}',
    '{"update_id":1,"callback_query":{"from":{"id":1.5}}}',
    '{"update_id":1,"callback_query":{"from":{"id":9007199254740993}}}',
    "<xml>",
    "<xml><FromUserName>",
    "<xml><FromUserName><![CDATA[",
    "<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><xml>&e;</xml>",
    "\u{FFFD}\u{FFFD}",
    // A lone high surrogate: not valid text, and exactly the input a decoder
    // that trusts its own round trip mangles.
    String.fromCharCode(0xd800),
    "\u{202E}nimda",
    "a".repeat(200_000),
    "[".repeat(5000),
    JSON.stringify({ team: "T", user: "U" }),
    JSON.stringify({ team: null, user: null }),
    JSON.stringify({ team: { id: "" }, user: { id: "" } }),
  ].map((text) => encoder.encode(text));

  const noise: Uint8Array[] = [];
  for (let seed = 1; seed <= 200; seed += 1) {
    noise.push(seededBytes(seed, seed % 97));
  }
  // A handful of genuinely large ones, to exercise the size cap.
  for (let seed = 1; seed <= 8; seed += 1) {
    noise.push(seededBytes(seed * 7919, 200_000));
  }
  return [...fixed, ...noise];
}

function headersFor(adapter: ChannelAdapter, body: Uint8Array, valid: boolean) {
  if (adapter.kind === "slack") {
    const signature = valid
      ? `v0=${createHmac("sha256", SLACK_SECRET)
          .update(Buffer.concat([Buffer.from(`v0:${NOW_SECONDS}:`), body]))
          .digest("hex")}`
      : "v0=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    return {
      "x-slack-signature": signature,
      "x-slack-request-timestamp": NOW_SECONDS,
    };
  }
  if (adapter.kind === "telegram") {
    return {
      "x-telegram-bot-api-secret-token": valid ? TELEGRAM_SECRET : "nope",
    };
  }
  return {};
}

function queryFor(adapter: ChannelAdapter, valid: boolean) {
  if (adapter.kind !== "wechat") return undefined;
  const nonce = "Zx9Qm2";
  return {
    timestamp: NOW_SECONDS,
    nonce,
    signature: valid
      ? wechatSignature(WECHAT_TOKEN, NOW_SECONDS, nonce)
      : "0".repeat(40),
  };
}

describe("callback verifiers survive hostile input", () => {
  const bodies = hostileBodies();

  it("has a corpus worth the name", () => {
    expect(bodies.length).toBeGreaterThanOrEqual(200);
  });

  for (const valid of [false, true]) {
    const label = valid
      ? "with a valid signature"
      : "with an invalid signature";
    it(`never throws and never accepts ${label}`, () => {
      for (const adapter of adapters()) {
        const verifyCallback = adapter.verifyCallback;
        expect(verifyCallback).toBeDefined();
        if (!verifyCallback) continue;
        const query = queryFor(adapter, valid);
        for (const body of bodies) {
          const base = {
            rawBody: body,
            headers: headersFor(adapter, body, valid),
            now: FIXED_NOW,
          };
          const request: CallbackRequest = query ? { ...base, query } : base;
          let result: CallbackVerification = {
            ok: false,
            reason: "unconfigured",
          };
          expect(() => {
            result = verifyCallback(request);
          }).not.toThrow();
          expect(result.ok).toBe(false);
        }
      }
    });
  }

  it("yields no decision when the actions field is not an array", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        team: { id: "T" },
        user: { id: "U" },
        actions: "not-array",
      }),
    );
    const slack = adapters()[0];
    // Well-formed identity, malformed affordance list. Provenance holds, so
    // this is a verified callback — with nothing in it that could be read as
    // a decision, which is the failure mode that matters.
    const result = slack?.verifyCallback?.({
      rawBody: body,
      headers: headersFor(slack, body, true),
      now: FIXED_NOW,
    });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.decision).toBeUndefined();
    expect(result.opaqueRef).toBeUndefined();
  });

  it("does not let a __proto__ key in a callback body pollute anything", () => {
    const body = new TextEncoder().encode(
      '{"__proto__":{"polluted":true},"team":{"id":"T"},"user":{"id":"U"}}',
    );
    const slack = adapters()[0];
    // A well-formed interaction that happens to carry `__proto__`: it
    // verifies, as it should, and leaves Object.prototype alone.
    const result = slack?.verifyCallback?.({
      rawBody: body,
      headers: headersFor(slack, body, true),
      now: FIXED_NOW,
    });
    expect(result?.ok).toBe(true);
    const probe: Record<string, string> = {};
    expect(probe.polluted).toBeUndefined();
  });

  it("refuses an oversized body before it hashes or parses it", () => {
    const huge = new Uint8Array(200_000);
    for (const adapter of adapters()) {
      const query = queryFor(adapter, true);
      const base = {
        rawBody: huge,
        headers: headersFor(adapter, huge, true),
        now: FIXED_NOW,
      };
      const request: CallbackRequest = query ? { ...base, query } : base;
      expect(adapter.verifyCallback?.(request)).toEqual({
        ok: false,
        reason: "body_too_large",
      });
    }
  });
});
