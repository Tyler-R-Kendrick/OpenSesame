import { afterEach, describe, expect, it, vi } from "vitest";
import { createBitwardenWorkerFetch } from "./bitwarden-worker-fetch.js";
import { createBitwardenWorkerHttp } from "./bitwarden-worker-http.js";
import type { BitwardenFetchRequest } from "./bitwarden-worker-protocol.js";
import { secretHttpFixture } from "./onepassword-http.test-support.js";
import type { SecretBackendFetch } from "./types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function request(url: string): BitwardenFetchRequest {
  return { type: "fetch", id: 1, url, method: "GET", headers: [], body: "" };
}

describe("Bitwarden isolated worker network boundary", () => {
  it("forwards real request/response bodies through the captured main transport", async () => {
    const server = await secretHttpFixture((incoming) => ({
      body: JSON.stringify({
        method: incoming.method,
        body: incoming.body,
        authorization: incoming.headers.authorization,
      }),
    }));
    cleanup.push(server.close);
    const captured: RequestInit[] = [];
    const fencedFetch: SecretBackendFetch = async (input, init = {}) => {
      captured.push(init);
      return fetch(input, init);
    };
    const forward = createBitwardenWorkerHttp(
      { apiUrl: `${server.url}/api`, identityUrl: `${server.url}/identity` },
      fencedFetch,
    );
    const bridge = createBitwardenWorkerFetch((message) => {
      void forward(message).then((result) => {
        bridge.receive(result);
      });
    });
    const response = await bridge.fetch(
      `${server.url}/identity/connect/token`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer scoped-token",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        redirect: "follow",
        credentials: "include",
      },
    );
    expect(response).toBeInstanceOf(Response);
    expect(response.url).toBe(`${server.url}/identity/connect/token`);
    expect(await response.json()).toEqual({
      method: "POST",
      body: "grant_type=client_credentials",
      authorization: "Bearer scoped-token",
    });
    expect(captured[0]).toMatchObject({
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(server.requests).toHaveLength(1);
    bridge.close();
  });

  it("refuses external origins, escaped base paths and embedded credentials before transport", async () => {
    const fetcher = vi.fn();
    const forward = createBitwardenWorkerHttp(
      {
        apiUrl: "https://secrets.example/api",
        identityUrl: "https://identity.example/identity",
      },
      fetcher,
    );
    for (const url of [
      "https://other.example/api/secrets",
      "https://secrets.example/api-other/secrets",
      "https://secrets.example/api/../outside",
      "https://user:password@secrets.example/api/secrets",
      "https://identity.example/outside",
    ]) {
      await expect(forward(request(url))).rejects.toMatchObject({
        code: "configuration",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks the captured lease on every request and refuses work after its abort", async () => {
    const controller = new AbortController();
    let current = true;
    const fetched = vi.fn<SecretBackendFetch>(async () => new Response("{}"));
    const fencedFetch: SecretBackendFetch = async (input, init) => {
      if (!current) throw new Error("The capability lease changed");
      return fetched(input, init);
    };
    const forward = createBitwardenWorkerHttp(
      {
        apiUrl: "https://secrets.example/api",
        identityUrl: "https://identity.example/identity",
      },
      fencedFetch,
      controller.signal,
    );
    await forward(request("https://secrets.example/api/secrets"));
    current = false;
    await expect(
      forward(request("https://secrets.example/api/secrets")),
    ).rejects.toThrow("lease changed");
    controller.abort();
    await expect(
      forward(request("https://secrets.example/api/secrets")),
    ).rejects.toThrow();
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized response streams and failed transport RPC without returning a response", async () => {
    const forward = createBitwardenWorkerHttp(
      {
        apiUrl: "https://secrets.example/api",
        identityUrl: "https://identity.example/identity",
      },
      async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
    );
    await expect(
      forward(request("https://secrets.example/api/secrets")),
    ).rejects.toThrow("too large");
    const bridge = createBitwardenWorkerFetch((message) => {
      bridge.receive({
        type: "fetch-result",
        id: message.id,
        ok: false,
        status: 0,
        statusText: "",
        url: message.url,
        headers: [],
        body: new Uint8Array(),
      });
    });
    await expect(
      bridge.fetch("https://secrets.example/api/secrets"),
    ).rejects.toThrow("network request failed");
    bridge.close();
  });
});
