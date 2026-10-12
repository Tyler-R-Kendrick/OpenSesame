import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  linearApiSeams,
  listLinearIssues,
  listLinearProjects,
  readLinearIssue,
  refreshLinearToken,
  revokeLinearToken,
  verifyLinearAccount,
} from "./linear-api.js";

const oauth = { kind: "oauth", token: "private-access-token" } as const;
const account = {};
function answer(body: BoundaryValue, status = 200) {
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const inactiveFetch = linearApiSeams.fetch;
beforeEach(() => {
  linearApiSeams.fetch = (url, init) => fetch(url, init);
});
afterEach(() => {
  linearApiSeams.fetch = inactiveFetch;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fail closed and scrub provider failures", () => {
  it("rejects provider pages larger than the explicitly requested fifty overview rows", async () => {
    const issue = {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Title",
      url: "https://linear.app/acme/issue/ENG-1",
    };
    answer({
      data: { issues: { nodes: Array.from({ length: 51 }, () => issue) } },
    });
    await expect(listLinearIssues(oauth)).rejects.toMatchObject({
      code: "response",
    });
    const project = {
      id: "project-1",
      name: "Project",
      url: "https://linear.app/acme/project/release",
    };
    answer({
      data: { projects: { nodes: Array.from({ length: 51 }, () => project) } },
    });
    await expect(listLinearProjects(oauth)).rejects.toMatchObject({
      code: "response",
    });
  });
  it("classifies only known OAuth failure codes without revealing the response", async () => {
    answer({ error: "invalid_grant", error_description: oauth.token }, 400);
    await expect(
      refreshLinearToken({ clientId: "client-1", refreshToken: "refresh" }),
    ).rejects.toMatchObject({ oauthError: "invalid_grant", status: 400 });
    answer({ error: "invalid_client", error_description: oauth.token }, 401);
    await expect(
      refreshLinearToken({ clientId: "client-1", refreshToken: "refresh" }),
    ).rejects.toMatchObject({ oauthError: "invalid_client", status: 401 });
    answer({ error: oauth.token }, 400);
    await expect(
      refreshLinearToken({ clientId: "client-1", refreshToken: "refresh" }),
    ).rejects.toMatchObject({ oauthError: undefined });
  });

  it("can revoke the refresh grant even when its access token has expired", async () => {
    const fetcher = answer(null);
    await revokeLinearToken(
      { kind: "oauth", token: "refresh-secret" },
      "refresh_token",
    );
    expect(
      Object.fromEntries(
        new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body)),
      ),
    ).toEqual({ token: "refresh-secret", token_type_hint: "refresh_token" });
  });
  it("refuses provider-returned unsafe resource links", async () => {
    answer({
      data: {
        issue: {
          id: "id",
          identifier: "ENG-1",
          title: "Title",
          description: null,
          url: "javascript:alert(1)",
        },
      },
    });
    await expect(readLinearIssue(oauth, "ENG-1")).rejects.toMatchObject({
      code: "response",
    });
  });
  it("does not use global fetch while the owning capability is inactive", async () => {
    const fetcher = answer({ data: account });
    linearApiSeams.fetch = inactiveFetch;
    await expect(verifyLinearAccount(oauth)).rejects.toMatchObject({
      code: "network",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [401, "authorization"],
    [403, "permission"],
    [429, "rate-limit"],
    [500, "response"],
  ])(
    "reports status %s without exposing a provider response",
    async (status, code) => {
      answer({ error: oauth.token }, Number(status));
      await expect(verifyLinearAccount(oauth)).rejects.toMatchObject({
        code,
        status,
      });
      try {
        await verifyLinearAccount(oauth);
      } catch (error) {
        expect(String(error)).not.toContain(oauth.token);
      }
    },
  );

  it("refuses header injection before fetch", async () => {
    const fetcher = answer({ data: account });
    await expect(
      verifyLinearAccount({ kind: "oauth", token: "access\r\nx-secret: leak" }),
    ).rejects.toMatchObject({ code: "input" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses oversized, malformed and anonymous successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("a".repeat(256 * 1024 + 1))),
    );
    await expect(verifyLinearAccount(oauth)).rejects.toMatchObject({
      code: "response",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json")),
    );
    await expect(verifyLinearAccount(oauth)).rejects.toMatchObject({
      code: "response",
    });
    answer({ data: { viewer: null } });
    await expect(verifyLinearAccount(oauth)).rejects.toMatchObject({
      code: "response",
    });
  });

  it("bounds requests that never receive a response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new Error("request aborted")),
              { once: true },
            );
          }),
      ),
    );
    const rejected = expect(verifyLinearAccount(oauth)).rejects.toMatchObject({
      code: "network",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
  });
});
