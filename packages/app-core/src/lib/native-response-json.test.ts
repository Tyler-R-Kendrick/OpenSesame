import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { nativeApiHttp } from "./native-api-http.js";
import { nativeOAuthHttp } from "./native-oauth-http.js";
import { tlsFetch } from "./native-s3-backup.test-support.js";

const LIMIT = 256 * 1024;
let directory = "";
type OwnedTls = { key: Buffer; cert: Buffer };
let tls: OwnedTls;
const closes: (() => Promise<void>)[] = [];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "native-response-json-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  tls = {
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
});
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(write: (response: ServerResponse) => void) {
  const arrived = deferred();
  const closed = deferred();
  const headers = deferred();
  let finished = false;
  let closedBeforeCleanup = false;
  const server = createServer(tls, async (request, response) => {
    for await (const _part of request) {
      /* Drain the actual request. */
    }
    response.once("finish", () => {
      finished = true;
    });
    response.once("close", () => {
      closedBeforeCleanup = true;
      closed.resolve();
    });
    response.setHeader("content-type", "text/plain");
    write(response);
    arrived.resolve();
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  closes.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    url: `https://127.0.0.1:${address.port}/reply`,
    fetch: async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const response = await tlsFetch(tls.cert)(input, init);
      headers.resolve();
      return response;
    },
    headersReceived: headers.promise,
    arrived: arrived.promise,
    closed: closed.promise,
    finished: () => finished,
    closedBeforeCleanup: () => closedBeforeCleanup,
  };
}
async function read(
  kind: "api" | "oauth",
  f: Awaited<ReturnType<typeof fixture>>,
  signal?: AbortSignal,
) {
  const transport = { fetch: f.fetch, assertCurrent: () => {} };
  return kind === "api"
    ? nativeApiHttp(
        { url: f.url, method: "GET", headers: new Headers(), signal },
        transport,
      )
    : (
        await nativeOAuthHttp(
          f.url,
          new URLSearchParams({
            grant_type: "authorization_code",
            code: "owned",
          }),
          transport,
        )
      ).body;
}
it.each(["api", "oauth"] as const)(
  "%s consumes an exact-limit JSON response over verified TLS regardless of media metadata",
  async (kind) => {
    const payload = JSON.stringify("a".repeat(LIMIT - 2));
    const f = await fixture((response) => response.end(payload));
    expect(await read(kind, f)).toBe("a".repeat(LIMIT - 2));
    await f.closed;
    expect(f.finished()).toBe(true);
  },
);
it.each(["api", "oauth"] as const)(
  "%s cancels both actual body branches on an oversized held response before fixture cleanup",
  async (kind) => {
    const f = await fixture((response) => {
      response.writeHead(200);
      response.write(`"${"x".repeat(LIMIT)}`);
    });
    const reading = read(kind, f);
    await f.arrived;
    await expect(reading).rejects.toMatchObject({
      code: kind === "api" ? "response" : "provider",
    });
    await f.closed;
    expect(f.finished()).toBe(false);
  },
);
it.each(["api", "oauth"] as const)(
  "%s preserves split Unicode and sanitized malformed-JSON errors",
  async (kind) => {
    const f = await fixture((response) => {
      const bytes = Buffer.from(JSON.stringify({ value: "安全😀" }));
      for (const byte of bytes) response.write(Buffer.of(byte));
      response.end();
    });
    expect(await read(kind, f)).toEqual({ value: "安全😀" });
    const bad = await fixture((response) =>
      response.end("private-response-material"),
    );
    try {
      await read(kind, bad);
      throw new Error("Expected refusal");
    } catch (error) {
      expect(error).toMatchObject({
        code: kind === "api" ? "response" : "provider",
      });
      expect(String(error)).not.toContain("private-response-material");
    }
  },
);
it("preserves API replacement decoding and OAuth fatal UTF8 decoding", async () => {
  const f = await fixture((response) =>
    response.end(Buffer.of(0x22, 0xff, 0x22)),
  );
  expect(await read("api", f)).toBe("�");
  await expect(read("oauth", f)).rejects.toMatchObject({ code: "provider" });
});
it("preserves OAuth empty-null versus API empty refusal", async () => {
  const f = await fixture((response) => response.end());
  expect(await read("oauth", f)).toBeNull();
  await expect(read("api", f)).rejects.toMatchObject({ code: "response" });
});
it("aborts an API caller's held body and physically closes its TLS request before cleanup", async () => {
  const f = await fixture((response) => {
    response.writeHead(200);
    response.write('{"value":"');
  });
  const controller = new AbortController();
  const reading = read("api", f, controller.signal);
  await f.arrived;
  await f.headersReceived;
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await expect(reading).rejects.toMatchObject({ code: "response" });
  await f.closed;
  expect(f.finished()).toBe(false);
});
it.each(["api", "oauth"] as const)(
  "%s keeps its actual15-second held-response deadline and closes the socket",
  async (kind) => {
    const f = await fixture((response) => {
      response.writeHead(200);
      response.write('{"value":"');
    });
    const started = Date.now();
    const reading = read(kind, f);
    await f.arrived;
    await expect(reading).rejects.toMatchObject({
      code: kind === "api" ? "response" : "provider",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(13_000);
    expect(Date.now() - started).toBeLessThan(20_000);
    await f.closed;
    expect(f.finished()).toBe(false);
  },
  25_000,
);
it("keeps credential-mutation settlement independent of a withdrawn OAuth owner", async () => {
  let reply: ServerResponse | undefined;
  const f = await fixture((response) => {
    reply = response;
    response.writeHead(200);
    response.write('{"access_token":"');
  });
  const owner = new AbortController();
  const transport = {
    fetch: f.fetch,
    settleCredentialMutation: f.fetch,
    signal: owner.signal,
    assertCurrent: () => owner.signal.throwIfAborted(),
  };
  const reading = nativeOAuthHttp(f.url, "code=owned", transport);
  await f.arrived;
  owner.abort();
  if (!reply) throw new Error("Missing held mutation response");
  reply.end('minted-before-withdrawal"}');
  expect((await reading).body).toEqual({
    access_token: "minted-before-withdrawal",
  });
  await f.closed;
  expect(f.finished()).toBe(true);
});

it("preserves physical owner cancellation for OAuth reads that are not credential mutations", async () => {
  const f = await fixture((response) => {
    response.writeHead(200);
    response.write('{"value":"');
  });
  const owner = new AbortController();
  const transport = {
    fetch: (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) =>
      f.fetch(input, {
        ...init,
        signal: AbortSignal.any([
          owner.signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
    settleCredentialMutation: f.fetch,
    signal: owner.signal,
    assertCurrent: () => owner.signal.throwIfAborted(),
  };
  const reading = nativeOAuthHttp(
    f.url,
    "code=owned",
    transport,
    undefined,
    false,
  );
  await f.headersReceived;
  owner.abort();
  await expect(reading).rejects.toMatchObject({ code: "provider" });
  await f.closed;
  expect(f.finished()).toBe(false);
});

it.each(["api", "oauth"] as const)(
  "%s refuses a physically interrupted empty body instead of treating it as a completed empty reply",
  async (kind) => {
    let reply: ServerResponse | undefined;
    const f = await fixture((response) => {
      reply = response;
      response.writeHead(200);
      response.flushHeaders();
    });
    const reading = read(kind, f);
    await f.headersReceived;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!reply) throw new Error("Missing actual held response");
    reply.destroy();
    await expect(reading).rejects.toMatchObject({
      code: kind === "api" ? "response" : "provider",
    });
    await f.closed;
    expect(f.finished()).toBe(false);
  },
);

it.each([
  { status: 401, code: "authorization" },
  { status: 403, code: "permission" },
  { status: 429, code: "rate-limit" },
  { status: 500, code: "response" },
  { status: 302, code: "response" },
])(
  "API retires refused HTTP $status held body before fixture cleanup",
  async ({ status, code }) => {
    const secret = "private-upstream-refusal-material";
    const f = await fixture((response) => {
      response.writeHead(status);
      response.write(secret);
    });
    try {
      await read("api", f);
      throw new Error("Expected provider refusal");
    } catch (error) {
      expect(error).toMatchObject({ code, status });
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(f.url);
    }
    // Observe the actual TLS producer before afterEach can close its socket.
    await expect.poll(f.closedBeforeCleanup, { timeout: 1000 }).toBe(true);
    expect(f.finished()).toBe(false);
  },
);
it("API retires a held body when its original owner withdraws after headers", async () => {
  const f = await fixture((response) => {
    response.writeHead(200);
    response.write('{"private-upstream-material":"');
  });
  let current = true;
  const transport = {
    async fetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
      const response = await f.fetch(input, init);
      current = false;
      return response;
    },
    assertCurrent() {
      if (!current) throw new Error("Original owner ended after headers");
    },
  };
  await expect(
    nativeApiHttp(
      {
        url: f.url,
        method: "GET",
        headers: new Headers(),
      },
      transport,
    ),
  ).rejects.toMatchObject({ code: "network" });
  await expect.poll(f.closedBeforeCleanup, { timeout: 1000 }).toBe(true);
  expect(f.finished()).toBe(false);
});
