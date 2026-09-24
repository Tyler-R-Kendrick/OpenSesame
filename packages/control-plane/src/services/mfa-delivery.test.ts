import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { MailerNotConfiguredError, createMailer } from "./mailer.js";
import { createSmsBridge } from "./sms-bridge.js";

function testConfig(allowDevDefaults: boolean) {
  if (allowDevDefaults) {
    return loadConfig({
      OPENSESAME_ENV: "test",
      OPENSESAME_PUBLIC_URL: "https://id.example",
      OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
    });
  }
  return loadConfig({
    OPENSESAME_ENV: "test",
    OPENSESAME_PUBLIC_URL: "https://id.example",
    OPENSESAME_ALLOW_DEV_DEFAULTS: "0",
    OPENSESAME_CLAIM_PEPPER: "pepper-for-tests-only-not-a-production-secret",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createMailer ESP paths", () => {
  it("sends through Resend when OPENSESAME_RESEND_API_KEY is set", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ id: "re_123" }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const mailer = createMailer(
      { OPENSESAME_RESEND_API_KEY: "re_test", OPENSESAME_MAIL_FROM: "a@b.c" },
      testConfig(false),
    );
    await mailer.send({
      to: "user@example.com",
      subject: "code",
      text: "Your code is 123456",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.resend.com/emails");
    expect(mailer.outbox[0]?.messageId).toBe("re_123");
  });

  it("refuses when no ESP and no SMTP and dev defaults are off", async () => {
    const mailer = createMailer({}, testConfig(false));
    await expect(
      mailer.send({ to: "a@b.c", subject: "x", text: "y" }),
    ).rejects.toBeInstanceOf(MailerNotConfiguredError);
  });
});

describe("createSmsBridge Twilio path", () => {
  it("delivers through Twilio when account credentials are set", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ sid: "SM123" }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sms = createSmsBridge({
      OPENSESAME_TWILIO_ACCOUNT_SID: "ACabc",
      OPENSESAME_TWILIO_AUTH_TOKEN: "secret",
      OPENSESAME_TWILIO_FROM_NUMBER: "+15551234567",
    });
    expect(sms.isConfigured()).toBe(true);

    const outcome = await sms.deliver(
      {
        kind: "sms",
        confidentiality: "minimal",
        title: "OpenSesame",
        body: "Your OpenSesame code is 123456.",
      },
      { channel: "sms", e164: "+15557654321" },
    );

    expect(outcome.status).toBe("delivered");
    expect(outcome.providerMessageRef).toBe("SM123");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.twilio.com");
  });
});
