import { describe, expect, it } from "vitest";

import { createTelegramAdapter } from "../adapters/telegram.js";
import { bytesEqual, secretsEqual } from "../bytes.js";
import type { CallbackRequest } from "../contract.js";
import { jsonFetch, renderInput } from "./helpers.js";

const BOT_TOKEN = "123456:AAH-test-bot-token";
const SECRET_TOKEN = "telegram-webhook-secret-for-tests-only";

function update(fromId = 987654321, data = "otp_e4Kx9QmZ"): string {
  return JSON.stringify({
    update_id: 4242,
    callback_query: {
      id: "cbq_1",
      from: { id: fromId, is_bot: false, username: "reassignable_handle" },
      message: { message_id: 77, chat: { id: fromId, type: "private" } },
      data,
    },
  });
}

function callback(body: string, secret = SECRET_TOKEN): CallbackRequest {
  return {
    rawBody: new TextEncoder().encode(body),
    headers: { "x-telegram-bot-api-secret-token": secret },
  };
}

function adapter() {
  return createTelegramAdapter({
    botToken: BOT_TOKEN,
    callbackSecretToken: SECRET_TOKEN,
    fetchImpl: jsonFetch(
      '{"ok":true,"result":{"message_id":77,"chat":{"id":1}}}',
    ).impl,
  });
}

describe("telegram callback provenance", () => {
  it("accepts an update carrying the configured secret token", () => {
    const result = adapter().verifyCallback?.(callback(update()));
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.providerId).toBe("telegram");
    expect(result.providerSubjectId).toBe("987654321");
    expect(result.providerTenantId).toBe("");
    expect(result.opaqueRef).toBe("otp_e4Kx9QmZ");
  });

  it("reports no provider-attested freshness, because there is none", () => {
    const result = adapter().verifyCallback?.(callback(update()));
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    // The Bot API stamps no time on the click. Saying `false` is what keeps
    // the caller obliged to get freshness from the one-time token's expiry.
    expect(result.fresh).toBe(false);
  });

  it("never derives a decision from an opaque callback token", () => {
    const result = adapter().verifyCallback?.(callback(update(1, "approve")));
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    // Even a token that spells "approve" is just a token: the meaning lives
    // with whoever minted it, not with the string.
    expect(result.decision).toBeUndefined();
    expect(result.opaqueRef).toBe("approve");
  });

  it("rejects a mismatched secret token", () => {
    expect(
      adapter().verifyCallback?.(callback(update(), "wrong-secret")),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a secret that shares a prefix with the real one", () => {
    const almost = `${SECRET_TOKEN.slice(0, SECRET_TOKEN.length - 1)}X`;
    expect(adapter().verifyCallback?.(callback(update(), almost))).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a missing header rather than comparing against nothing", () => {
    const result = adapter().verifyCallback?.({
      rawBody: new TextEncoder().encode(update()),
      headers: {},
    });
    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("rejects an empty header even when the adapter has a secret", () => {
    expect(adapter().verifyCallback?.(callback(update(), ""))).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  /**
   * The comparison is `timingSafeEqual` behind a length guard, which is what
   * makes a wrong-length secret a plain refusal rather than a thrown
   * `RangeError` — the observable difference between a constant-time
   * compare done properly and one bolted on.
   */
  it("compares the secret in constant time, including across lengths", () => {
    const short = SECRET_TOKEN.slice(0, 4);
    const long = `${SECRET_TOKEN}${SECRET_TOKEN}`;
    for (const presented of [short, long]) {
      expect(() =>
        adapter().verifyCallback?.(callback(update(), presented)),
      ).not.toThrow();
      expect(adapter().verifyCallback?.(callback(update(), presented))).toEqual(
        {
          ok: false,
          reason: "signature_mismatch",
        },
      );
    }
    expect(secretsEqual(SECRET_TOKEN, SECRET_TOKEN)).toBe(true);
    expect(secretsEqual(SECRET_TOKEN, short)).toBe(false);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(
      false,
    );
  });

  it("takes the numeric id and never the mutable @username", () => {
    const result = adapter().verifyCallback?.(callback(update()));
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.providerSubjectId).toBe("987654321");
    expect(JSON.stringify(result)).not.toContain("reassignable_handle");
  });

  it("refuses an authenticated update with no numeric sender", () => {
    const body = JSON.stringify({
      update_id: 1,
      callback_query: { from: { username: "only_a_handle" }, data: "x" },
    });
    expect(adapter().verifyCallback?.(callback(body))).toEqual({
      ok: false,
      reason: "identity_missing",
    });
  });

  it("refuses an update with no update_id to key the replay ledger by", () => {
    const body = JSON.stringify({ callback_query: { from: { id: 1 } } });
    expect(adapter().verifyCallback?.(callback(body))).toEqual({
      ok: false,
      reason: "body_unparseable",
    });
  });

  it("digests the update id alongside the body", () => {
    const first = adapter().verifyCallback?.(callback(update()));
    const second = adapter().verifyCallback?.(
      callback(update().replace('"update_id":4242', '"update_id":4243')),
    );
    expect(first?.ok && second?.ok).toBe(true);
    if (!first?.ok || !second?.ok) return;
    expect(first.callbackDigest).not.toBe(second.callbackDigest);
  });
});

describe("telegram delivery", () => {
  it("puts the opaque token in callback_data and never a request id", async () => {
    const recorder = jsonFetch(
      '{"ok":true,"result":{"message_id":77,"chat":{"id":987654321}}}',
    );
    const telegram = createTelegramAdapter({
      botToken: BOT_TOKEN,
      callbackSecretToken: SECRET_TOKEN,
      fetchImpl: recorder.impl,
    });
    const message = telegram.render(
      renderInput({
        kind: "telegram",
        decisionTokens: { approve: "otp_yes_1", deny: "otp_no_1" },
      }),
    );
    const outcome = await telegram.deliver(message, {
      channel: "telegram",
      chatId: "987654321",
    });
    expect(outcome).toEqual({
      status: "delivered",
      providerMessageRef: "987654321:77",
    });
    const call = recorder.calls[0];
    expect(call?.body).toContain('"callback_data":"otp_yes_1"');
    expect(call?.body).toContain('"callback_data":"otp_no_1"');
    expect(call?.body).not.toContain('rz-QHXT-KPLM","callback_data');
  });

  it("degrades to a link when a token will not fit callback_data", async () => {
    const recorder = jsonFetch('{"ok":true,"result":{"message_id":1}}');
    const telegram = createTelegramAdapter({
      botToken: BOT_TOKEN,
      callbackSecretToken: SECRET_TOKEN,
      fetchImpl: recorder.impl,
    });
    const message = telegram.render(
      renderInput({
        kind: "telegram",
        decisionTokens: { approve: "y".repeat(65), deny: "n".repeat(65) },
      }),
    );
    await telegram.deliver(message, { channel: "telegram", chatId: "1" });
    expect(recorder.calls[0]?.body).not.toContain("callback_data");
    expect(recorder.calls[0]?.body).toContain("Review in OpenSesame");
  });

  it("disables link previews so the chat never fetches the rendezvous", async () => {
    const recorder = jsonFetch('{"ok":true,"result":{"message_id":1}}');
    const telegram = createTelegramAdapter({
      botToken: BOT_TOKEN,
      callbackSecretToken: SECRET_TOKEN,
      fetchImpl: recorder.impl,
    });
    await telegram.deliver(telegram.render(renderInput({ kind: "telegram" })), {
      channel: "telegram",
      chatId: "1",
    });
    expect(recorder.calls[0]?.body).toContain('"is_disabled":true');
  });

  it("classifies a 429 as retryable", async () => {
    const telegram = createTelegramAdapter({
      botToken: BOT_TOKEN,
      callbackSecretToken: SECRET_TOKEN,
      fetchImpl: jsonFetch('{"ok":false,"error_code":429}', 429).impl,
    });
    await expect(
      telegram.deliver(telegram.render(renderInput({ kind: "telegram" })), {
        channel: "telegram",
        chatId: "1",
      }),
    ).resolves.toEqual({ status: "retryable", error: "status:429" });
  });

  it("is unconfigured without both a bot token and a callback secret", () => {
    expect(
      createTelegramAdapter({
        botToken: BOT_TOKEN,
        callbackSecretToken: "",
      }).isConfigured(),
    ).toBe(false);
  });
});
