import { IncomingMessage } from "node:http";
import https, { type RequestOptions } from "node:https";
import { Socket } from "node:net";
import { Writable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { postWebhook } from "./delivery.js";

const transport = { request: vi.spyOn(https, "request") };

const init = {
  method: "POST",
  redirect: "error",
  headers: { "content-type": "application/json", "webhook-id": "delivery_1" },
  body: '{"eventType":"authority.invocation.requested"}',
  signal: AbortSignal.timeout(10_000),
} satisfies Parameters<typeof postWebhook>[1];

beforeEach(() => {
  transport.request.mockReset();
});
afterAll(() => {
  transport.request.mockRestore();
});

describe("public-only webhook delivery", () => {
  it.each([
    "https://127.0.0.1/hook",
    "https://[::1]/hook",
    "https://169.254.169.254/hook",
    "https://2130706433/hook",
    "https://localhost/hook",
    "http://public.example/hook",
    "https://user:password@public.example/hook",
  ])("refuses %s before opening a socket", async (url) => {
    const lookup = vi.fn();
    await expect(postWebhook(url, init, lookup)).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("rejects private DNS answers, including a mixed public/private answer", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(
      postWebhook("https://public.example/hook", init, lookup),
    ).rejects.toThrow("Blocked resolved address");
    expect(transport.request).not.toHaveBeenCalled();
  });

  it.each([204, 302, 999])(
    "pins DNS and does not follow redirects (HTTP %s)",
    async (status) => {
      let sent = "";
      // SAFETY: the tested postWebhook contract calls request(options, callback) and only on/end.
      transport.request.mockImplementation(((
        _options: RequestOptions,
        callback: (response: IncomingMessage) => void,
      ) => {
        const request = new Writable({
          write(chunk, _encoding, done) {
            sent += chunk.toString();
            done();
          },
        });
        request.on("finish", () => {
          const response = new IncomingMessage(new Socket());
          response.statusCode = status;
          response.headers.location = "https://127.0.0.1/private";
          callback(response);
        });
        return request;
      }) as typeof https.request);
      const lookup = vi.fn(async () => [
        { address: "93.184.216.34", family: 4 },
      ]);
      const response = await postWebhook(
        "https://public.example:8443/hook?q=1",
        init,
        lookup,
      );
      expect(response.status).toBe(status === 999 ? 502 : status);
      expect(sent).toBe(init.body);
      expect(lookup).toHaveBeenCalledExactlyOnceWith("public.example", {
        all: true,
      });
      expect(transport.request).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          hostname: "93.184.216.34",
          servername: "public.example",
          port: "8443",
          path: "/hook?q=1",
          rejectUnauthorized: true,
          agent: false,
          headers: { ...init.headers, host: "public.example:8443" },
        }),
        expect.any(Function),
      );
    },
  );

  it("aborts while DNS is pending without opening a socket", async () => {
    const controller = new AbortController();
    const lookup = vi.fn(() => new Promise<never>(() => {}));
    const result = postWebhook(
      "https://public.example/hook",
      { ...init, signal: controller.signal },
      lookup,
    );
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(transport.request).not.toHaveBeenCalled();
  });
});
