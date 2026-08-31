import { createHmac } from "node:crypto";

import { bindingMatchesProviderIdentity } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";

import {
  SLACK_APPROVE_ACTION_ID,
  SLACK_DENY_ACTION_ID,
  createSlackAdapter,
} from "../adapters/slack.js";
import type { CallbackRequest } from "../contract.js";
import { FIXED_NOW, jsonFetch, renderInput, throwingFetch } from "./helpers.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const OTHER_SECRET = "0000000000000000000000000000fedc";
const BOT_TOKEN = "xoxb-test-token";

function sign(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

function interaction(teamId = "T0AAAAA", userId = "U0BBBBB"): string {
  return JSON.stringify({
    type: "block_actions",
    team: { id: teamId, domain: "example" },
    user: { id: userId, username: "impersonatable", name: "Real Name" },
    actions: [
      {
        action_id: SLACK_APPROVE_ACTION_ID,
        value: "otp_e4Kx9QmZ",
        type: "button",
      },
    ],
  });
}

interface CallbackOverrides {
  secret?: string;
  timestamp?: string;
  signature?: string;
}

function callback(
  body: string,
  overrides: CallbackOverrides = {},
): CallbackRequest {
  const timestamp =
    overrides.timestamp ?? String(Math.floor(FIXED_NOW.getTime() / 1000));
  const signature =
    overrides.signature ??
    sign(overrides.secret ?? SIGNING_SECRET, timestamp, body);
  return {
    rawBody: new TextEncoder().encode(body),
    headers: {
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
      "content-type": "application/json",
    },
    now: FIXED_NOW,
  };
}

function adapter() {
  return createSlackAdapter({
    botToken: BOT_TOKEN,
    signingSecret: SIGNING_SECRET,
    now: () => FIXED_NOW,
    fetchImpl: jsonFetch('{"ok":true,"channel":"D1","ts":"1.2"}').impl,
  });
}

describe("slack callback provenance", () => {
  it("accepts a correctly signed interaction and names the identity tuple", () => {
    const result = adapter().verifyCallback?.(callback(interaction()));
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.providerId).toBe("slack");
    expect(result.providerTenantId).toBe("T0AAAAA");
    expect(result.providerSubjectId).toBe("U0BBBBB");
    expect(result.decision).toBe("approved");
    expect(result.opaqueRef).toBe("otp_e4Kx9QmZ");
    expect(result.fresh).toBe(true);
  });

  it("never takes identity from a username or display name", () => {
    const result = adapter().verifyCallback?.(callback(interaction()));
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.providerSubjectId).not.toContain("impersonatable");
    expect(result.providerSubjectId).not.toContain("Real Name");
  });

  it("rejects a body that changed after it was signed", () => {
    const body = interaction();
    const tampered = body.replace("U0BBBBB", "U0EVIL0");
    const signed = callback(body);
    const result = adapter().verifyCallback?.({
      ...signed,
      rawBody: new TextEncoder().encode(tampered),
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a timestamp older than the five-minute window", () => {
    const stale = String(Math.floor(FIXED_NOW.getTime() / 1000) - 301);
    const result = adapter().verifyCallback?.(
      callback(interaction(), { timestamp: stale }),
    );
    expect(result).toEqual({ ok: false, reason: "timestamp_stale" });
  });

  it("accepts a timestamp at the edge of the window", () => {
    const edge = String(Math.floor(FIXED_NOW.getTime() / 1000) - 300);
    const result = adapter().verifyCallback?.(
      callback(interaction(), { timestamp: edge }),
    );
    expect(result?.ok).toBe(true);
  });

  it("rejects a timestamp from the future", () => {
    const ahead = String(Math.floor(FIXED_NOW.getTime() / 1000) + 3600);
    const result = adapter().verifyCallback?.(
      callback(interaction(), { timestamp: ahead }),
    );
    expect(result).toEqual({ ok: false, reason: "timestamp_future" });
  });

  it("rejects a signature minted under a different secret", () => {
    const result = adapter().verifyCallback?.(
      callback(interaction(), { secret: OTHER_SECRET }),
    );
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a missing signature and a missing timestamp distinctly", () => {
    const body = interaction();
    const timestamp = String(Math.floor(FIXED_NOW.getTime() / 1000));
    expect(
      adapter().verifyCallback?.({
        rawBody: new TextEncoder().encode(body),
        headers: { "x-slack-request-timestamp": timestamp },
        now: FIXED_NOW,
      }),
    ).toEqual({ ok: false, reason: "missing_signature" });
    expect(
      adapter().verifyCallback?.({
        rawBody: new TextEncoder().encode(body),
        headers: { "x-slack-signature": sign(SIGNING_SECRET, timestamp, body) },
        now: FIXED_NOW,
      }),
    ).toEqual({ ok: false, reason: "timestamp_missing" });
  });

  it("rejects a signature that is not v0 hex", () => {
    const result = adapter().verifyCallback?.(
      callback(interaction(), { signature: "v0=not-hex-at-all" }),
    );
    expect(result).toEqual({ ok: false, reason: "malformed_signature" });
  });

  /**
   * The ordering property, proved from both sides. A parse refusal can only
   * be reached once the MAC has passed; an unauthenticated caller sending
   * the same malformed bytes is stopped at the signature and never reaches
   * the parser at all.
   */
  it("parses the body only after the signature verifies", () => {
    const malformed = '{"type":"block_actions", "team": ';
    expect(adapter().verifyCallback?.(callback(malformed))).toEqual({
      ok: false,
      reason: "body_unparseable",
    });
    const unsigned = adapter().verifyCallback?.(
      callback(malformed, { secret: OTHER_SECRET }),
    );
    expect(unsigned).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(unsigned).not.toEqual({ ok: false, reason: "body_unparseable" });
  });

  it("handles the form-encoded payload= shape interactive components use", () => {
    const body = `payload=${encodeURIComponent(interaction())}`;
    const result = adapter().verifyCallback?.(callback(body));
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.providerSubjectId).toBe("U0BBBBB");
  });

  it("refuses an authenticated payload with no team or user id", () => {
    const body = JSON.stringify({ type: "block_actions", actions: [] });
    expect(adapter().verifyCallback?.(callback(body))).toEqual({
      ok: false,
      reason: "identity_missing",
    });
  });

  it("reports no decision for an affordance that is not ours", () => {
    const body = JSON.stringify({
      team: { id: "T0AAAAA" },
      user: { id: "U0BBBBB" },
      actions: [{ action_id: "some_other_app", value: "x" }],
    });
    const result = adapter().verifyCallback?.(callback(body));
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.decision).toBeUndefined();
  });

  it("reads deny from the action id rather than the opaque value", () => {
    const body = JSON.stringify({
      team: { id: "T0AAAAA" },
      user: { id: "U0BBBBB" },
      actions: [{ action_id: SLACK_DENY_ACTION_ID, value: "approve" }],
    });
    const result = adapter().verifyCallback?.(callback(body));
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.decision).toBe("denied");
  });

  it("gives different digests to two deliveries of the same click", () => {
    const first = adapter().verifyCallback?.(callback(interaction()));
    const second = adapter().verifyCallback?.(callback(interaction("T0CCCCC")));
    expect(first?.ok && second?.ok).toBe(true);
    if (!first?.ok || !second?.ok) return;
    expect(first.callbackDigest).not.toBe(second.callbackDigest);
  });

  /**
   * The cross-tenant case. Slack user ids are unique inside a workspace and
   * not across them, so an attacker who owns their own workspace can create
   * a user whose id matches somebody else's binding. Only the whole tuple
   * distinguishes them.
   */
  it("extracts a tenant that distinguishes identical user ids", () => {
    const mine = adapter().verifyCallback?.(callback(interaction("T_VICTIM")));
    const theirs = adapter().verifyCallback?.(
      callback(interaction("T_ATTACKER")),
    );
    expect(mine?.ok && theirs?.ok).toBe(true);
    if (!mine?.ok || !theirs?.ok) return;
    expect(mine.providerSubjectId).toBe(theirs.providerSubjectId);
    expect(mine.providerTenantId).not.toBe(theirs.providerTenantId);

    const binding = {
      id: "bind_1",
      principalId: "prn_1",
      kind: "slack",
      providerId: "slack",
      providerTenantId: "T_VICTIM",
      providerSubjectId: "U0BBBBB",
      state: "active",
      verification: "provider_oauth_install",
      createdAt: FIXED_NOW,
      metadata: {},
      version: 1,
    } as const;
    expect(bindingMatchesProviderIdentity(binding, mine)).toBe(true);
    expect(bindingMatchesProviderIdentity(binding, theirs)).toBe(false);
  });

  it("refuses everything when the signing secret is absent", () => {
    const unconfigured = createSlackAdapter({
      botToken: "",
      signingSecret: "",
      now: () => FIXED_NOW,
    });
    expect(unconfigured.isConfigured()).toBe(false);
    expect(unconfigured.verifyCallback?.(callback(interaction()))).toEqual({
      ok: false,
      reason: "unconfigured",
    });
  });
});

describe("slack delivery", () => {
  it("posts a DM with the rendered body and the bot token in a header", async () => {
    const recorder = jsonFetch(
      '{"ok":true,"channel":"D1","ts":"1700000000.1"}',
    );
    const slack = createSlackAdapter({
      botToken: BOT_TOKEN,
      signingSecret: SIGNING_SECRET,
      fetchImpl: recorder.impl,
      now: () => FIXED_NOW,
    });
    const message = slack.render(
      renderInput({
        decisionTokens: { approve: "otp_yes", deny: "otp_no" },
      }),
    );
    const outcome = await slack.deliver(message, {
      channel: "slack",
      teamId: "T0AAAAA",
      userId: "U0BBBBB",
    });
    expect(outcome).toEqual({
      status: "delivered",
      providerMessageRef: "D1:1700000000.1",
    });
    const call = recorder.calls[0];
    expect(call?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(call?.headers.authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(call?.url).not.toContain(BOT_TOKEN);
    expect(call?.body).toContain("otp_yes");
    expect(call?.body).toContain(SLACK_APPROVE_ACTION_ID);
  });

  it("renders a link and no decision buttons without decision tokens", async () => {
    const recorder = jsonFetch('{"ok":true,"channel":"D1","ts":"1.2"}');
    const slack = createSlackAdapter({
      botToken: BOT_TOKEN,
      signingSecret: SIGNING_SECRET,
      fetchImpl: recorder.impl,
    });
    await slack.deliver(slack.render(renderInput()), {
      channel: "slack",
      teamId: "T0AAAAA",
      userId: "U0BBBBB",
    });
    expect(recorder.calls[0]?.body).not.toContain(SLACK_APPROVE_ACTION_ID);
    expect(recorder.calls[0]?.body).toContain("Review in OpenSesame");
  });

  it("withdraws the buttons when a settled message is revised", async () => {
    const recorder = jsonFetch('{"ok":true,"channel":"D1","ts":"1.2"}');
    const slack = createSlackAdapter({
      botToken: BOT_TOKEN,
      signingSecret: SIGNING_SECRET,
      fetchImpl: recorder.impl,
    });
    const message = slack.render(
      renderInput({ decisionTokens: { approve: "otp_yes", deny: "otp_no" } }),
    );
    await slack.update?.("D1:1.2", message);
    const call = recorder.calls[0];
    expect(call?.url).toBe("https://slack.com/api/chat.update");
    expect(call?.body).not.toContain("otp_yes");
    expect(call?.body).not.toContain(SLACK_APPROVE_ACTION_ID);
  });

  it("classifies a rate limit as retryable and a bad channel as permanent", async () => {
    const rateLimited = createSlackAdapter({
      botToken: BOT_TOKEN,
      signingSecret: SIGNING_SECRET,
      fetchImpl: jsonFetch('{"ok":false,"error":"ratelimited"}').impl,
    });
    await expect(
      rateLimited.deliver(rateLimited.render(renderInput()), {
        channel: "slack",
        teamId: "T",
        userId: "U",
      }),
    ).resolves.toEqual({ status: "retryable", error: "ratelimited" });

    const gone = createSlackAdapter({
      botToken: BOT_TOKEN,
      signingSecret: SIGNING_SECRET,
      fetchImpl: jsonFetch('{"ok":false,"error":"channel_not_found"}').impl,
    });
    await expect(
      gone.deliver(gone.render(renderInput()), {
        channel: "slack",
        teamId: "T",
        userId: "U",
      }),
    ).resolves.toEqual({ status: "permanent", error: "channel_not_found" });
  });

  it("never carries an unrecognized provider string into the outcome", async () => {
    const hostile = createSlackAdapter({
      botToken: BOT_TOKEN,
      signingSecret: SIGNING_SECRET,
      fetchImpl: jsonFetch(
        '{"ok":false,"error":"<script>alert(1)</script> secret=hunter2"}',
      ).impl,
    });
    const outcome = await hostile.deliver(hostile.render(renderInput()), {
      channel: "slack",
      teamId: "T",
      userId: "U",
    });
    expect(outcome).toEqual({ status: "permanent", error: "provider_error" });
    expect(outcome.error).not.toContain("hunter2");
  });

  it("treats a transport failure as retryable without echoing the message", async () => {
    const recorder = throwingFetch();
    const slack = createSlackAdapter({
      botToken: BOT_TOKEN,
      signingSecret: SIGNING_SECRET,
      fetchImpl: recorder.impl,
    });
    const outcome = await slack.deliver(slack.render(renderInput()), {
      channel: "slack",
      teamId: "T",
      userId: "U",
    });
    expect(outcome).toEqual({
      status: "retryable",
      error: "transport:TypeError",
    });
  });

  it("refuses a destination that belongs to another channel", async () => {
    const slack = adapter();
    await expect(
      slack.deliver(slack.render(renderInput()), {
        channel: "telegram",
        chatId: "1",
      }),
    ).resolves.toEqual({ status: "permanent", error: "destination_mismatch" });
  });
});
