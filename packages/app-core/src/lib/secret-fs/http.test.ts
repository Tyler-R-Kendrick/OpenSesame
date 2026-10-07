import { Duration, Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { fetchTo } from "./fetch.test-support.js";
import { describeSecretFiles, failureOf } from "./files.conformance.js";
import { makeFilesHandler } from "./http-handler.js";
import { makeHttpSecretFiles } from "./http.js";
import { makeMemorySecretFiles } from "./memory.js";
import { resilient } from "./resilient.js";

const TOKEN = "correct horse battery staple";
const ORIGIN = "https://vault.test";
const bytes = (text: string) => new TextEncoder().encode(text);

type WireOptions = Readonly<{
  token?: string;
  allowOrigin?: string;
  maxBytes?: number;
}>;

const NO_WIRE_OPTIONS: WireOptions = {};

/** A storage server in memory, and a client that reaches it with no network. */
function wire(options: WireOptions = NO_WIRE_OPTIONS) {
  const backing = makeMemorySecretFiles();
  const handler = makeFilesHandler(backing, {
    token: Redacted.make(options.token ?? TOKEN),
    allowOrigin: options.allowOrigin,
    maxBytes: options.maxBytes,
  });
  const fetcher = fetchTo(handler);
  const client = (token = TOKEN, fetchImpl: typeof fetch = fetcher) =>
    makeHttpSecretFiles({
      baseUrl: ORIGIN,
      token: Redacted.make(token),
      fetch: fetchImpl,
    });
  return { backing, handler, client };
}

describeSecretFiles("a storage server over HTTP", async () => ({
  files: wire().client(),
}));

describe("a storage server over HTTP", () => {
  it("stores the bytes on the server as the client wrote them", async () => {
    const { client, backing } = wire();
    await Effect.runPromise(
      client().write("t/secrets/a.json", bytes("sealed")),
    );
    expect(
      new TextDecoder().decode(backing.snapshot().get("t/secrets/a.json")),
    ).toBe("sealed");
  });

  it("refuses a wrong or missing credential with no hint of which", async () => {
    const { client, handler } = wire();
    expect(
      await failureOf(client("x".repeat(20)).read("a.json")),
    ).toMatchObject({
      _tag: "SecretFsRejected",
      kind: "permission",
    });
    const bare = await handler(new Request(`${ORIGIN}/v1/files/a.json`));
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("will not be built with a token too short to be a secret", () => {
    expect(() =>
      makeFilesHandler(makeMemorySecretFiles(), {
        token: Redacted.make("short"),
      }),
    ).toThrow(/16 characters/);
  });

  it("never lets an encoded dot segment reach the store", async () => {
    const { handler, backing } = wire();
    await Effect.runPromise(backing.write("b.json", bytes("kept")));
    const get = (path: string) =>
      handler(
        new Request(`${ORIGIN}/v1/files/${path}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      );
    // The URL parser resolves a single-encoded `..` before the handler sees it.
    expect((await get("a/%2e%2e/b.json")).status).toBe(200);
    expect((await get("%2e%2e/%2e%2e/etc/passwd")).status).toBe(404);
    // A double-encoded one arrives as text, and is refused as a name.
    expect((await get("a/%252e%252e/b.json")).status).toBe(400);
    expect((await get("a%2f..%2fb.json")).status).toBe(400);
  });

  it("refuses a body past its limit", async () => {
    const { client } = wire({ maxBytes: 8 });
    expect(
      await failureOf(client().write("a.json", bytes("123456789"))),
    ).toMatchObject({
      _tag: "SecretFsRejected",
    });
  });

  it("answers a cross-origin page only when its origin is the configured one", async () => {
    const { handler } = wire({ allowOrigin: "https://pwa.test" });
    const preflight = await handler(
      new Request(`${ORIGIN}/v1/files/a.json`, { method: "OPTIONS" }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://pwa.test",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "if-match",
    );
    const closed = wire().handler;
    const none = await closed(
      new Request(`${ORIGIN}/v1/files/a.json`, { method: "OPTIONS" }),
    );
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never puts the token in a failure", async () => {
    const down: typeof fetch = () =>
      Promise.reject(new TypeError(`connect ECONNREFUSED ${TOKEN}`));
    const error = await failureOf(wire().client(TOKEN, down).read("a.json"));
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(error._tag).toBe("SecretFsUnavailable");
  });

  it("does not follow a redirect, so a credential is not sent somewhere new", async () => {
    const seen: RequestInit[] = [];
    const spy: typeof fetch = async (_input, init) => {
      seen.push(init ?? {});
      return new Response(null, { status: 404 });
    };
    await failureOf(wire().client(TOKEN, spy).read("a.json"));
    expect(seen[0]?.redirect).toBe("error");
  });

  it("is resilient end to end: a dropped connection mid-write is retried to done", async () => {
    const { backing, handler } = wire();
    let calls = 0;
    const reach = fetchTo(handler);
    const lossy: typeof fetch = async (input, init) => {
      const response = await reach(input, init);
      calls += 1;
      if (calls === 1) throw new TypeError("socket hang up");
      return response;
    };
    const files = await Effect.runPromise(
      resilient(
        makeHttpSecretFiles({
          baseUrl: ORIGIN,
          token: Redacted.make(TOKEN),
          fetch: lossy,
        }),
        {
          backoff: Duration.millis(1),
        },
      ),
    );
    await Effect.runPromise(
      files.write("a.json", bytes("once"), { ifRevision: null }),
    );
    expect(calls).toBe(2);
    expect(backing.snapshot().size).toBe(1);
  });
});
