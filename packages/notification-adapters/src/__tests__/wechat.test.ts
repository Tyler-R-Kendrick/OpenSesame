import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createWeChatAdapter,
  readXmlText,
  wechatSignature,
} from "../adapters/wechat.js";
import type { CallbackRequest } from "../contract.js";
import { FIXED_NOW, jsonFetch, renderInput } from "./helpers.js";

const APP_ID = "wx9f2b1c0d4e5a6b7c";
const TOKEN = "opensesame-oa-token";
const NOW_SECONDS = String(Math.floor(FIXED_NOW.getTime() / 1000));

function messageXml(from = "oABCD_1234567890abcdef"): string {
  return [
    "<xml>",
    "<ToUserName><![CDATA[gh_officialaccount]]></ToUserName>",
    `<FromUserName><![CDATA[${from}]]></FromUserName>`,
    `<CreateTime>${NOW_SECONDS}</CreateTime>`,
    "<MsgType><![CDATA[text]]></MsgType>",
    "<Content><![CDATA[approve]]></Content>",
    "</xml>",
  ].join("");
}

interface QueryOverrides {
  timestamp?: string;
  nonce?: string;
  signature?: string;
  echostr?: string;
}

function callback(body: string, query: QueryOverrides = {}): CallbackRequest {
  const timestamp = query.timestamp ?? NOW_SECONDS;
  const nonce = query.nonce ?? "Zx9Qm2";
  const base = {
    timestamp,
    nonce,
    signature: query.signature ?? wechatSignature(TOKEN, timestamp, nonce),
  };
  return {
    rawBody: new TextEncoder().encode(body),
    headers: { "content-type": "text/xml" },
    query: query.echostr ? { ...base, echostr: query.echostr } : base,
    now: FIXED_NOW,
  };
}

function adapter() {
  return createWeChatAdapter({
    appId: APP_ID,
    token: TOKEN,
    now: () => FIXED_NOW,
    fetchImpl: jsonFetch('{"errcode":0}').impl,
  });
}

describe("wechat signature algorithm", () => {
  /**
   * A hand-computed vector, not this function's own output. The sort is the
   * part that is easy to get subtly wrong and impossible to catch with a
   * self-referential test: the three *values* are sorted as strings, so the
   * order changes with the data rather than being fixed by parameter name.
   */
  it("matches a known-answer vector", () => {
    expect(wechatSignature(TOKEN, "1700000000", "Zx9Qm2")).toBe(
      "34f490f3bcfb2a7934ba9430fe63bd19e554a5d5",
    );
  });

  it("sorts the values lexicographically before hashing", () => {
    const sorted = ["1700000000", "Zx9Qm2", TOKEN].sort().join("");
    expect(sorted).toBe("1700000000Zx9Qm2opensesame-oa-token");
    expect(wechatSignature(TOKEN, "1700000000", "Zx9Qm2")).toBe(
      createHash("sha1").update(sorted, "utf8").digest("hex"),
    );
  });

  it("depends on the sort, not on argument order", () => {
    // Reversing which value is "timestamp" and which is "nonce" cannot
    // change the digest, because the sort is over the values themselves.
    expect(wechatSignature(TOKEN, "aaa", "bbb")).toBe(
      wechatSignature(TOKEN, "bbb", "aaa"),
    );
    // A different token does change it, which is the property that matters.
    expect(wechatSignature("other-token", "aaa", "bbb")).not.toBe(
      wechatSignature(TOKEN, "aaa", "bbb"),
    );
  });
});

describe("wechat callback provenance", () => {
  it("accepts a correctly signed message and names OpenID and app id", () => {
    const result = adapter().verifyCallback?.(callback(messageXml()));
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.providerId).toBe("wechat");
    expect(result.providerTenantId).toBe(APP_ID);
    expect(result.providerSubjectId).toBe("oABCD_1234567890abcdef");
  });

  it("never returns a decision, whatever the message says", () => {
    for (const content of ["approve", "yes", "同意", "1"]) {
      const body = messageXml().replace("approve", content);
      const result = adapter().verifyCallback?.(callback(body));
      expect(result?.ok).toBe(true);
      if (!result?.ok) return;
      expect(result.decision).toBeUndefined();
      expect("decision" in result).toBe(false);
    }
  });

  it("declares that it cannot render a decision affordance", () => {
    expect(adapter().capabilities().canRenderDecisionActions).toBe(false);
  });

  it("rejects a signature computed under a different token", () => {
    const wrong = wechatSignature("attacker-token", NOW_SECONDS, "Zx9Qm2");
    expect(
      adapter().verifyCallback?.(callback(messageXml(), { signature: wrong })),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a missing signature, timestamp or nonce", () => {
    const body = new TextEncoder().encode(messageXml());
    expect(
      adapter().verifyCallback?.({ rawBody: body, headers: {}, query: {} }),
    ).toEqual({ ok: false, reason: "missing_signature" });
    expect(
      adapter().verifyCallback?.({
        rawBody: body,
        headers: {},
        query: { signature: "x" },
      }),
    ).toEqual({ ok: false, reason: "timestamp_missing" });
    expect(
      adapter().verifyCallback?.({
        rawBody: body,
        headers: {},
        query: { signature: "x", timestamp: NOW_SECONDS },
        now: FIXED_NOW,
      }),
    ).toEqual({ ok: false, reason: "malformed_signature" });
  });

  it("rejects a stale and a future timestamp", () => {
    const stale = String(Number(NOW_SECONDS) - 301);
    const ahead = String(Number(NOW_SECONDS) + 301);
    expect(
      adapter().verifyCallback?.(callback(messageXml(), { timestamp: stale })),
    ).toEqual({ ok: false, reason: "timestamp_stale" });
    expect(
      adapter().verifyCallback?.(callback(messageXml(), { timestamp: ahead })),
    ).toEqual({ ok: false, reason: "timestamp_future" });
  });

  it("verifies the echo handshake without inventing a subject", () => {
    const result = adapter().verifyCallback?.(
      callback("", { echostr: "1234567890123456789" }),
    );
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    // Empty, so `bindingMatchesProviderIdentity` can never match it: that
    // function requires a non-empty subject.
    expect(result.providerSubjectId).toBe("");
    expect(result.opaqueRef).toBe("1234567890123456789");
    expect(result.decision).toBeUndefined();
  });

  it("refuses an authenticated body with no FromUserName", () => {
    expect(
      adapter().verifyCallback?.(
        callback("<xml><MsgType>text</MsgType></xml>"),
      ),
    ).toEqual({ ok: false, reason: "identity_missing" });
  });

  it("is unconfigured without an app id and token", () => {
    const bare = createWeChatAdapter({ appId: "", token: "" });
    expect(bare.isConfigured()).toBe(false);
    expect(bare.verifyCallback?.(callback(messageXml()))).toEqual({
      ok: false,
      reason: "unconfigured",
    });
  });
});

describe("wechat XML reading", () => {
  it("reads CDATA and plain element text alike", () => {
    expect(readXmlText("<A><![CDATA[value]]></A>", "A")).toBe("value");
    expect(readXmlText("<A>value</A>", "A")).toBe("value");
  });

  it("returns undefined rather than throwing on hostile input", () => {
    for (const xml of ["", "<A>", "<A></A>", "<".repeat(5000)]) {
      expect(() => readXmlText(xml, "FromUserName")).not.toThrow();
      expect(readXmlText(xml, "FromUserName")).toBeUndefined();
    }
  });

  it("bounds what it will extract", () => {
    const huge = `<A>${"x".repeat(5000)}</A>`;
    expect(readXmlText(huge, "A")).toBeUndefined();
  });
});

describe("wechat delivery", () => {
  it("is unconfigured with no access-token supplier and makes no call", async () => {
    const recorder = jsonFetch('{"errcode":0}');
    const wechat = createWeChatAdapter({
      appId: APP_ID,
      token: TOKEN,
      fetchImpl: recorder.impl,
    });
    const outcome = await wechat.deliver(
      wechat.render(renderInput({ kind: "wechat" })),
      { channel: "wechat", openId: "oABCD" },
    );
    expect(outcome).toEqual({
      status: "unconfigured",
      error: "no_access_token",
    });
    expect(recorder.calls).toHaveLength(0);
  });

  it("sends a minimal text message when a token is available", async () => {
    const recorder = jsonFetch('{"errcode":0}');
    const wechat = createWeChatAdapter({
      appId: APP_ID,
      token: TOKEN,
      accessToken: async () => "ACCESS_TOKEN_VALUE",
      fetchImpl: recorder.impl,
    });
    const outcome = await wechat.deliver(
      wechat.render(renderInput({ kind: "wechat", confidentiality: "full" })),
      { channel: "wechat", openId: "oABCD" },
    );
    expect(outcome).toEqual({ status: "delivered" });
    const call = recorder.calls[0];
    expect(call?.url).toContain("/cgi-bin/message/custom/send");
    // The catalogue caps this channel at `minimal`, so the requester's text
    // never reaches the message even when the caller asked for `full`.
    expect(call?.body).not.toContain("Transfer funds");
  });
});
