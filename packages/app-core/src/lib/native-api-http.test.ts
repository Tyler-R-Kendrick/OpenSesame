import { afterEach, describe, expect, it, vi } from "vitest";
import { EgressDenied } from "./capabilities/egress.js";
import { nativeApiHttp } from "./native-api-http.js";

afterEach(() => vi.useRealTimers());

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("bounded provider HTTP boundary", () => {
  const request = {
    url: "https://api.telegram.org/botprivate-key/getMe",
    method: "GET" as const,
    headers: new Headers(),
  };
  it("distinguishes deployment refusal without exposing the credential-bearing endpoint", async () => {
    const transport = {
      fetch: vi.fn(async () => {
        throw new EgressDenied(
          "local-authority-not-permitted",
          "connectors.external",
          String(request.url),
        );
      }),
      assertCurrent: vi.fn(),
    };
    await expect(nativeApiHttp(request, transport)).rejects.toMatchObject({
      code: "deployment",
      message: "This deployment does not permit this provider endpoint",
    });
  });
  it.each(["invalid JSON", JSON.stringify({ text: "a".repeat(262144) })])(
    "refuses malformed or oversized response without reflecting body",
    async (body) => {
      const transport = {
        fetch: vi.fn(async () => new Response(body)),
        assertCurrent: vi.fn(),
      };
      await expect(nativeApiHttp(request, transport)).rejects.toMatchObject({
        code: "response",
      });
    },
  );
  it("does not expose credential-bearing destination or provider text in errors", async () => {
    const transport = {
      fetch: vi.fn(async () => {
        throw new Error("Failed https://api.telegram.org/botprivate-key/getMe");
      }),
      assertCurrent: vi.fn(),
    };
    try {
      await nativeApiHttp(request, transport);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "network" });
      expect(String(error)).not.toContain("private-key");
    }
  });
  it("uses browser CORS without cookies, redirect following, caching, or referrers", async () => {
    const transport = {
      fetch: vi.fn(
        async (_url: RequestInfo | URL, _init?: RequestInit) =>
          new Response("{}"),
      ),
      assertCurrent: vi.fn(),
    };
    await nativeApiHttp(request, transport);
    expect(transport.fetch.mock.calls[0]?.[1]).toMatchObject({
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  });
  describe("a status the provider documents as proof", () => {
    const answering = (status: number) => ({
      fetch: vi.fn(async () =>
        Response.json({ detail: "not found" }, { status }),
      ),
      assertCurrent: vi.fn(),
    });
    const proving = { ...request, validStatuses: [404] };
    it("proves the credential without reading the body", async () => {
      await expect(nativeApiHttp(proving, answering(404))).resolves.toEqual({});
    });
    it("is still a failure where the contract names none", async () => {
      await expect(
        nativeApiHttp(request, answering(404)),
      ).rejects.toMatchObject({ code: "response", status: 404 });
    });
    it("never turns a refused credential into a proof", async () => {
      await expect(
        nativeApiHttp(proving, answering(401)),
      ).rejects.toMatchObject({ code: "authorization" });
    });
    it.each([
      [401, "authorization"],
      [403, "permission"],
      [429, "rate-limit"],
    ])(
      "cannot override reserved refusal %s with a configured status",
      async (status, code) => {
        const refused = Number(status);
        await expect(
          nativeApiHttp(
            { ...request, validStatuses: [refused] },
            answering(refused),
          ),
        ).rejects.toMatchObject({ code, status: refused });
      },
    );
    it("refuses a redirected status proof", async () => {
      const response = Response.json({}, { status: 404 });
      Object.defineProperty(response, "redirected", { value: true });
      await expect(
        nativeApiHttp(proving, {
          fetch: vi.fn(async () => response),
          assertCurrent: vi.fn(),
        }),
      ).rejects.toMatchObject({ code: "response", status: 404 });
    });
    it("does not use a configured 2xx status to bypass JSON validation", async () => {
      await expect(
        nativeApiHttp(
          { ...request, validStatuses: [200] },
          {
            fetch: vi.fn(async () => new Response("invalid JSON")),
            assertCurrent: vi.fn(),
          },
        ),
      ).rejects.toMatchObject({ code: "response" });
    });
    it("does not send an already canceled status-proof request", async () => {
      const controller = new AbortController();
      controller.abort();
      const transport = answering(404);
      await expect(
        nativeApiHttp({ ...proving, signal: controller.signal }, transport),
      ).rejects.toMatchObject({ code: "network" });
      expect(transport.fetch).not.toHaveBeenCalled();
    });
    it("refuses a late status proof when fetch ignored cancellation", async () => {
      const controller = new AbortController();
      await expect(
        nativeApiHttp(
          { ...proving, signal: controller.signal },
          {
            fetch: vi.fn(async () => {
              controller.abort();
              return new Response(null, { status: 404 });
            }),
            assertCurrent: vi.fn(),
          },
        ),
      ).rejects.toMatchObject({ code: "network" });
    });
    it.each(["owner", "request", "deadline", "current"] as const)(
      "retains %s custody through real unread-body cancellation",
      async (reason) => {
        if (reason === "deadline") vi.useFakeTimers();
        const entered = latch();
        const finish = latch();
        const controller = new AbortController();
        let current = true;
        const response = new Response(
          new ReadableStream({
            cancel() {
              entered.release();
              return finish.promise;
            },
          }),
          { status: 404 },
        );
        const outcome = nativeApiHttp(
          { ...proving, signal: controller.signal },
          {
            fetch: vi.fn(async () => response),
            assertCurrent() {
              if (!current) throw new Error("private owner context");
            },
          },
        );
        const observed = (async () => {
          try {
            return { ok: true, value: await outcome };
          } catch (error) {
            return { ok: false, error };
          }
        })();
        await entered.promise;
        if (reason === "owner") current = false;
        if (reason === "request") controller.abort();
        if (reason === "deadline") await vi.advanceTimersByTimeAsync(15_001);
        finish.release();
        const result = await observed;
        if (reason === "current")
          expect(result).toEqual({ ok: true, value: {} });
        else {
          expect(result).toMatchObject({
            ok: false,
            error: { code: "network" },
          });
          if ("error" in result)
            expect(String(result.error)).not.toContain("private owner context");
        }
      },
    );
    it("refuses before it reads a proof, even from a request that names a refusal", async () => {
      // The schema refuses such a contract; this request is built by hand.
      for (const [status, code] of [
        [401, "authorization"],
        [403, "permission"],
        [407, "response"],
        [429, "rate-limit"],
      ] as const)
        await expect(
          nativeApiHttp(
            { ...request, validStatuses: [status] },
            answering(status),
          ),
          String(status),
        ).rejects.toMatchObject({ code, status });
    });
    it("takes no proof from an answer that was redirected", async () => {
      const moved = Response.json({}, { status: 404 });
      Object.defineProperty(moved, "redirected", { value: true });
      await expect(
        nativeApiHttp(proving, {
          fetch: vi.fn(async () => moved),
          assertCurrent: vi.fn(),
        }),
      ).rejects.toMatchObject({ code: "response", status: 404 });
    });
  });
});
