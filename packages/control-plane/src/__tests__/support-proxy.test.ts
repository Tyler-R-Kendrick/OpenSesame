import { afterEach, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  postSupportProxy,
  readSupportProxyConfig,
  supportProxySeams,
} from "../services/support-proxy.js";

const original = supportProxySeams.post;
afterEach(() => {
  supportProxySeams.post = original;
});
it("refuses unauthenticated/cross-origin traffic and rejects extra fields", async () => {
  let calls = 0;
  supportProxySeams.post = async () => {
    calls++;
    return 'data: {"type":"RUN_FINISHED"}\n\n';
  };
  const { app } = createControlPlane({
    config: {
      supportProxy: {
        url: "https://support.example/api",
        token: "test-only-server-token-longer-than-32chars",
      },
    },
  });
  expect((await app.request("/v1/support", { method: "HEAD" })).status).toBe(
    401,
  );
  const minted = await (
    await app.request("/v1/principals/provisional", { method: "POST" })
  ).json();
  const headers = {
    authorization: `Bearer ${minted.accessToken}`,
    origin: "http://127.0.0.1:8788",
    "content-type": "application/json",
  };
  const check = await app.request("/v1/support", { method: "HEAD", headers });
  expect(check.status).toBe(204);
  expect(check.headers.get("X-OpenSesame-Support-Session")).toBe("active");
  const body = {
    version: 2,
    question: "How do I lock?",
    pageId: "pages",
    route: "vault",
    featureIds: ["vault.lock"],
  };
  expect(
    (
      await app.request("/v1/support", {
        method: "POST",
        headers: { ...headers, origin: "https://foreign.example" },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request("/v1/support", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, token: "SENTINEL" }),
      })
    ).status,
  ).toBe(400);
  expect(calls).toBe(0);
  expect(
    (
      await app.request("/v1/support", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(200);
  expect(calls).toBe(1);
  supportProxySeams.post = async () => {
    throw new Error("SENTINEL_UPSTREAM_SECRET");
  };
  const failed = await app.request("/v1/support", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain("SENTINEL");
  const credential = "test-only-server-token-longer-than-32chars";
  supportProxySeams.post = async () => `data: {"answer":"${credential}"}\n\n`;
  const echo = await app.request("/v1/support", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(echo.status).toBe(502);
  expect(await echo.text()).not.toContain(credential);
});

it.each([
  "http://support.example/api",
  "https://127.0.0.1/api",
  "https://169.254.169.254/api",
  "https://user:secret@support.example/api",
  "https://support.example/api?token=SENTINEL",
  "https://support.example/api#secret",
])("rejects unsafe upstream configuration without exposing it", (url) => {
  expect(() =>
    readSupportProxyConfig({
      OPENSESAME_SUPPORT_UPSTREAM_URL: url,
      OPENSESAME_SUPPORT_UPSTREAM_TOKEN:
        "test-only-server-token-longer-than-32chars",
    }),
  ).toThrow(/Support proxy requires/);
});

it("is off by default and aborts before DNS for a cancelled request", async () => {
  expect(readSupportProxyConfig({})).toBeUndefined();
  const controller = new AbortController();
  controller.abort();
  await expect(
    postSupportProxy(
      {
        url: "https://support.example/api",
        token: "test-only-server-token-longer-than-32chars",
      },
      "{}",
      controller.signal,
    ),
  ).rejects.toThrow();
});
