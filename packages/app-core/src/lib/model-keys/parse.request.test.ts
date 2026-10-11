import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { expectRefused } from "./harness.test-support.js";
import { paramsFromSearch, parseExchangeRequest } from "./request.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from "./vocabulary.js";

const KEY = `osk_${"A".repeat(43)}`;
const base = {
  grant_type: TOKEN_EXCHANGE_GRANT,
  subject_token: KEY,
  subject_token_type: ACCESS_TOKEN_TYPE,
};
const refused = (input: BoundaryValue, error: string, reason: string) =>
  expectRefused(() => parseExchangeRequest(input), error, reason);

describe("RFC 8693 request parameters", () => {
  it("reads the smallest valid request, and a full one", () => {
    expect(parseExchangeRequest(base)).toEqual({
      subjectToken: KEY,
      resource: null,
      audienceProvider: null,
      actions: null,
      details: null,
      dpopJkt: null,
    });
    const full = parseExchangeRequest({
      ...base,
      requested_token_type: ACCESS_TOKEN_TYPE,
      resource: "https://api.openai.com/v1",
      audience: "urn:opensesame:model:openai",
      scope: "model.invoke model.list",
      authorization_details: '[{"type":"model_access"}]',
      dpop_jkt: "A".repeat(43),
    });
    expect(full).toMatchObject({
      resource: "https://api.openai.com/v1",
      audienceProvider: "openai",
      actions: ["model.invoke", "model.list"],
      dpopJkt: "A".repeat(43),
    });
    expect(full.details).toEqual([{ type: "model_access" }]);
  });

  it("is a request made of a plain object of strings and nothing else", async () => {
    for (const input of [
      null,
      undefined,
      "x",
      4,
      true,
      [],
      [base],
      new Map(),
      new Date(),
      () => base,
    ]) {
      await refused(input, "invalid_request", "request.shape");
    }
    await refused(
      Object.create({ ...base }),
      "invalid_request",
      "request.shape",
    );
    await refused({}, "invalid_request", "request.size");
    await refused(
      {
        ...base,
        ...Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [`p${i}`, "x"]),
        ),
      },
      "invalid_request",
      "request.size",
    );
  });

  it("names the grant type this exchange speaks", async () => {
    for (const grant_type of [
      undefined,
      "",
      "authorization_code",
      "client_credentials",
      TOKEN_EXCHANGE_GRANT.toUpperCase(),
      `${TOKEN_EXCHANGE_GRANT} `,
    ]) {
      await refused(
        { ...base, grant_type },
        "invalid_request",
        "param.value",
      ).catch(() => undefined);
      await expectRefused(
        () => parseExchangeRequest({ ...base, grant_type: grant_type ?? "" }),
        "unsupported_grant_type",
        "grant_type",
      );
    }
  });

  it("wants a subject token of one type, and a requested type of the same", async () => {
    await refused(
      {
        grant_type: base.grant_type,
        subject_token_type: base.subject_token_type,
      },
      "invalid_request",
      "subject.missing",
    );
    await refused(
      { grant_type: base.grant_type, subject_token: KEY },
      "invalid_request",
      "subject.missing",
    );
    for (const type of [
      "urn:ietf:params:oauth:token-type:jwt",
      "urn:ietf:params:oauth:token-type:id_token",
      "urn:ietf:params:oauth:token-type:refresh_token",
      "urn:ietf:params:oauth:token-type:saml2",
      "access_token",
    ]) {
      await refused(
        { ...base, subject_token_type: type },
        "invalid_request",
        "subject.type",
      );
      await refused(
        { ...base, requested_token_type: type },
        "invalid_request",
        "requested.type",
      );
    }
  });

  it("holds the subject token to the exact shape of a key", async () => {
    for (const token of [
      "",
      "osk_",
      `osk_${"A".repeat(42)}`,
      `osk_${"A".repeat(44)}`,
      `${KEY}\n`,
      ` ${KEY}`,
      `${KEY} `,
      `osk_${"A".repeat(42)}+`,
      `osk-${"A".repeat(43)}`,
      `OSK_${"A".repeat(43)}`,
      `sk-${"A".repeat(48)}`,
    ]) {
      await refused(
        { ...base, subject_token: token },
        "invalid_grant",
        "subject.shape",
      );
    }
  });

  it("refuses a parameter it does not define, and says plainly that it will not take an actor token", async () => {
    await refused(
      { ...base, client_id: "app-1" },
      "invalid_request",
      "param.unknown",
    );
    await refused(
      { ...base, client_secret: "x" },
      "invalid_request",
      "param.unknown",
    );
    await refused(
      { ...base, actor_token: KEY },
      "invalid_request",
      "param.actor_token",
    );
    await refused(
      { ...base, actor_token_type: ACCESS_TOKEN_TYPE },
      "invalid_request",
      "param.actor_token_type",
    );
    const hostile = JSON.parse(
      '{"grant_type":"x","__proto__":{"subject_token":"y"}}',
    );
    await refused(hostile, "invalid_request", "param.unknown");
  });

  it("takes strings only, and none longer than a bound", async () => {
    for (const scope of [1, null, ["model.invoke"], { a: 1 }, true]) {
      await refused({ ...base, scope }, "invalid_request", "param.value");
    }
    await refused(
      { ...base, scope: "x".repeat(4097) },
      "invalid_request",
      "param.value",
    );
  });

  it("holds a scope to the actions there are, once each", async () => {
    for (const scope of [
      "",
      " ",
      "model.invoke ",
      " model.invoke",
      "model.invoke  model.list",
      "model.invoke,model.list",
      "MODEL.INVOKE",
      "admin",
      "model.invoke\nmodel.list",
      "model:invoke",
    ]) {
      await expect(() => parseExchangeRequest({ ...base, scope })).toThrow();
    }
    await refused(
      { ...base, scope: "model.invoke model.invoke" },
      "invalid_scope",
      "scope.duplicate",
    );
    await refused(
      {
        ...base,
        scope: Array.from({ length: 9 }, (_, i) => `a${i}`).join(" "),
      },
      "invalid_scope",
      "scope.shape",
    );
    await refused(
      { ...base, scope: "model.delete" },
      "invalid_scope",
      "scope.unknown",
    );
  });

  it("holds authorization_details to a small JSON array", async () => {
    await refused(
      { ...base, authorization_details: "{" },
      "invalid_authorization_details",
      "details.json",
    );
    await refused(
      { ...base, authorization_details: "{}" },
      "invalid_authorization_details",
      "details.shape",
    );
    await refused(
      { ...base, authorization_details: "[]" },
      "invalid_authorization_details",
      "details.shape",
    );
    await refused(
      { ...base, authorization_details: JSON.stringify(Array(5).fill({})) },
      "invalid_authorization_details",
      "details.shape",
    );
    await refused(
      { ...base, authorization_details: `[${'"x",'.repeat(2000)}"x"]` },
      "invalid_request",
      "param.value",
    );
    await refused(
      { ...base, authorization_details: "null" },
      "invalid_authorization_details",
      "details.shape",
    );
  });

  it("holds audience and dpop_jkt to their shapes", async () => {
    for (const audience of [
      "openai",
      "urn:opensesame:model:",
      "urn:opensesame:model:OpenAI",
      "urn:opensesame:model:a/b",
      "https://api.openai.com/v1",
      "urn:opensesame:model:a b",
    ]) {
      await refused({ ...base, audience }, "invalid_target", "audience.shape");
    }
    for (const dpop_jkt of [
      "",
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}+`,
    ]) {
      await refused({ ...base, dpop_jkt }, "invalid_request", "dpop_jkt.shape");
    }
  });

  it("refuses a parameter given twice in a query string", () => {
    expect(paramsFromSearch("a=1&b=2")).toEqual({ a: "1", b: "2" });
    expect(() => paramsFromSearch("a=1&a=2")).toThrow();
    expect(() =>
      paramsFromSearch("scope=model.invoke&scope=model.list"),
    ).toThrow();
  });
});
