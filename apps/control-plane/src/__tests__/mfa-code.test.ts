import type {
  ChannelAdapter,
  DeliveryDestination,
  RenderedMessage,
} from "@opensesame/notification-adapters";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { maskDestination } from "../routes/mfa.js";

type App = ReturnType<typeof createControlPlane>["app"];

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
    allowDevDefaults: true,
  } as const;
}

async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

function json(token: string, body: JsonObject): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

/** The bridge as a test double: records what it was asked to send. */
function recordingSms(configured: boolean) {
  const sent: { text: string; to: string }[] = [];
  const adapter: ChannelAdapter = {
    kind: "sms",
    isConfigured: () => configured,
    capabilities: () => {
      throw new Error("unused");
    },
    render: () => {
      throw new Error("unused");
    },
    deliver: async (msg: RenderedMessage, dest: DeliveryDestination) => {
      if (dest.channel !== "sms") throw new Error("wrong destination");
      sent.push({ text: msg.body, to: dest.e164 });
      return { status: "delivered", providerMessageRef: "d1" };
    },
  };
  return { adapter, sent };
}

/** The six digits inside a captured message. */
function codeIn(text: string): string {
  const match = text.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no code in: ${text}`);
  return match[1] ?? "";
}

describe("one-time codes by email and text", () => {
  it("sends an email code and verifies it once", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const send = await app.request(
      "/v1/mfa/code/send",
      json(owner.accessToken, { channel: "email", to: "tyler@example.com" }),
    );
    expect(send.status).toBe(200);
    const sent = overlapCast(await send.json());
    expect(sent.ok).toBe(true);
    expect(sent.channel).toBe("email");
    // Masked on the way back: the client shows it, it never re-learns it.
    expect(sent.to).toBe("t•••@example.com");
    expect(sent.challengeId).toMatch(/^mfc_/);

    const mail = ctx.mailer.outbox.at(-1);
    expect(mail?.envelope.to).toEqual(["tyler@example.com"]);
    const code = codeIn(mail?.body ?? "");

    const wrong = await app.request(
      "/v1/mfa/code/verify",
      json(owner.accessToken, {
        challengeId: sent.challengeId,
        code: "000000",
      }),
    );
    expect(wrong.status).toBe(401);
    expect(overlapCast(await wrong.json()).error).toBe("invalid_code");

    const right = await app.request(
      "/v1/mfa/code/verify",
      json(owner.accessToken, {
        challengeId: sent.challengeId,
        code: `${code.slice(0, 3)} ${code.slice(3)}`,
      }),
    );
    expect(right.status).toBe(200);
    expect(overlapCast(await right.json())).toMatchObject({
      ok: true,
      channel: "email",
      to: "t•••@example.com",
    });

    // Spent: the same code answers like a wrong one.
    const again = await app.request(
      "/v1/mfa/code/verify",
      json(owner.accessToken, { challengeId: sent.challengeId, code }),
    );
    expect(again.status).toBe(401);
  });

  it("sends a text through the bridge, and refuses when there is none", async () => {
    const sms = recordingSms(true);
    const { app } = createControlPlane({
      config: testConfig(),
      sms: sms.adapter,
    });
    const owner = await provisional(app);
    const send = await app.request(
      "/v1/mfa/code/send",
      json(owner.accessToken, { channel: "sms", to: "+14155550142" }),
    );
    expect(send.status).toBe(200);
    const sent = overlapCast(await send.json());
    expect(sent.to).toBe("+1 ••• ••• 0142");
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]?.to).toBe("+14155550142");
    const code = codeIn(sms.sent[0]?.text ?? "");
    const ok = await app.request(
      "/v1/mfa/code/verify",
      json(owner.accessToken, { challengeId: sent.challengeId, code }),
    );
    expect(ok.status).toBe(200);

    const none = createControlPlane({
      config: testConfig(),
      sms: recordingSms(false).adapter,
    });
    const other = await provisional(none.app);
    const refused = await none.app.request(
      "/v1/mfa/code/send",
      json(other.accessToken, { channel: "sms", to: "+14155550142" }),
    );
    expect(refused.status).toBe(503);
    expect(overlapCast(await refused.json()).error).toBe("sms_not_configured");
  });

  it("rejects a bad channel or address before sending anything", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    for (const body of [
      { channel: "pigeon", to: "tyler@example.com" },
      { channel: "email", to: "not an address" },
      { channel: "sms", to: "415 555 0142" },
    ]) {
      const res = await app.request(
        "/v1/mfa/code/send",
        json(owner.accessToken, body),
      );
      expect(res.status).toBe(400);
    }
    expect(ctx.mailer.outbox).toHaveLength(0);
  });

  it("binds a challenge to the principal who asked for it", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const stranger = await provisional(app);
    const send = await app.request(
      "/v1/mfa/code/send",
      json(owner.accessToken, { channel: "email", to: "tyler@example.com" }),
    );
    const sent = overlapCast(await send.json());
    const code = codeIn(ctx.mailer.outbox.at(-1)?.body ?? "");
    const theft = await app.request(
      "/v1/mfa/code/verify",
      json(stranger.accessToken, { challengeId: sent.challengeId, code }),
    );
    expect(theft.status).toBe(401);
    // And the owner can still spend it: a stranger's guess did not burn it.
    const mine = await app.request(
      "/v1/mfa/code/verify",
      json(owner.accessToken, { challengeId: sent.challengeId, code }),
    );
    expect(mine.status).toBe(200);
  });

  it("spends a challenge after five wrong codes and expires it after ten minutes", async () => {
    let at = Date.parse("2026-09-02T10:00:00Z");
    const { app, ctx } = createControlPlane({
      config: testConfig(),
      clock: () => new Date(at),
    });
    const owner = await provisional(app);
    const first = overlapCast(
      await (
        await app.request(
          "/v1/mfa/code/send",
          json(owner.accessToken, {
            channel: "email",
            to: "tyler@example.com",
          }),
        )
      ).json(),
    );
    const code = codeIn(ctx.mailer.outbox.at(-1)?.body ?? "");
    let last = 0;
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request(
        "/v1/mfa/code/verify",
        json(owner.accessToken, {
          challengeId: first.challengeId,
          code: "111111",
        }),
      );
      last = res.status;
      if (i === 4) {
        expect(overlapCast(await res.json()).error).toBe("challenge_spent");
      }
    }
    expect(last).toBe(401);
    const afterSpent = await app.request(
      "/v1/mfa/code/verify",
      json(owner.accessToken, { challengeId: first.challengeId, code }),
    );
    expect(afterSpent.status).toBe(401);

    const second = overlapCast(
      await (
        await app.request(
          "/v1/mfa/code/send",
          json(owner.accessToken, {
            channel: "email",
            to: "tyler@example.com",
          }),
        )
      ).json(),
    );
    const secondCode = codeIn(ctx.mailer.outbox.at(-1)?.body ?? "");
    at += 11 * 60_000;
    const expired = await app.request(
      "/v1/mfa/code/verify",
      json(owner.accessToken, {
        challengeId: second.challengeId,
        code: secondCode,
      }),
    );
    expect(expired.status).toBe(401);
  });

  it("caps live challenges per principal", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request(
        "/v1/mfa/code/send",
        json(owner.accessToken, { channel: "email", to: "tyler@example.com" }),
      );
      expect(res.status).toBe(200);
    }
    const sixth = await app.request(
      "/v1/mfa/code/send",
      json(owner.accessToken, { channel: "email", to: "tyler@example.com" }),
    );
    expect(sixth.status).toBe(429);
  });

  it("masks addresses and numbers to a recognisable remainder", () => {
    expect(maskDestination("email", "tyler@example.com")).toBe(
      "t•••@example.com",
    );
    expect(maskDestination("sms", "+14155550142")).toBe("+1 ••• ••• 0142");
    expect(maskDestination("sms", "+447700900123")).toBe("+44 ••• ••• 0123");
  });
});
