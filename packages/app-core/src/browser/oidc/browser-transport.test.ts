import { once } from "node:events";
import { type RequestListener, createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { loopbackProfileEligible } from "../../lib/__tests__/loopback-profile.js";
import { localNetworkFetchSeams } from "../../lib/local-network-fetch.js";
import {
  bindIdentityBrowserNodeFactory,
  reserveIdentityBrowserNode,
} from "../../lib/tailscale/browser-node-identity-port.js";
import { captureBrowserOidcHTTP } from "./browser-transport.js";

beforeEach(() => {
  vi.spyOn(localNetworkFetchSeams, "eligible").mockImplementation(
    loopbackProfileEligible,
  );
});
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function owner() {
  const stop = new AbortController();
  return {
    signal: stop.signal,
    assertCurrent: () => stop.signal.throwIfAborted(),
    stop,
  };
}
async function server(handler: RequestListener) {
  const current = createServer(handler);
  current.listen(0, "127.0.0.1");
  await once(current, "listening");
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve, reject) => {
      current.close((error) => (error ? reject(error) : resolve()));
    });
    current.closeAllConnections();
    await closed;
  });
  const { port } = z
    .object({ port: z.number().int().positive().max(65535) })
    .parse(current.address());
  return `http://127.0.0.1:${port}`;
}

it("uses the default browser HTTP function without constructing an installed native factory", async () => {
  const factory = vi.fn(() => {
    throw new Error("Public OIDC must not open a node");
  });
  cleanups.push(bindIdentityBrowserNodeFactory(factory));
  const base = await server((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end('{"keys":[]}');
  });
  const actualFetch = globalThis.fetch;
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => actualFetch(input, init));
  const carrier = captureBrowserOidcHTTP(owner());
  cleanups.push(carrier.retire);
  const response = await carrier.transport.fetch(`${base}/jwks`, {
    credentials: "include",
    mode: "no-cors",
    redirect: "follow",
  });
  expect(await response.json()).toEqual({ keys: [] });
  expect(fetch).toHaveBeenCalledWith(
    expect.any(Request),
    expect.objectContaining({
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    }),
  );
  expect(factory).not.toHaveBeenCalled();
  await carrier.retire();
  expect(carrier.transport.signal.aborted).toBe(true);
  expect(() => carrier.transport.assertCurrent()).toThrow();
});

it("sends the actual bounded protocol POST without replacing its explicit authentication/body", async () => {
  const observed: string[] = [];
  const base = await server(async (request, response) => {
    request.setEncoding("utf8");
    let body = "";
    for await (const part of request) body += String(part);
    observed.push(
      request.method ?? "",
      String(request.headers.authorization),
      body,
    );
    response.setHeader("Content-Type", "application/json");
    response.end('{"id_token":"test"}');
  });
  const carrier = captureBrowserOidcHTTP(owner());
  cleanups.push(carrier.retire);
  const response = await carrier.transport.fetch(`${base}/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic public-synthetic-client",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=authorization_code&code_verifier=original",
  });
  expect(await response.json()).toEqual({ id_token: "test" });
  expect(observed).toEqual([
    "POST",
    "Basic public-synthetic-client",
    "grant_type=authorization_code&code_verifier=original",
  ]);
});

it("refuses insecure/decorated targets and non-protocol methods before HTTP", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const carrier = captureBrowserOidcHTTP(owner());
  cleanups.push(carrier.retire);
  for (const target of [
    "http://idp.example.test/token",
    "https://user:secret@idp.example.test/token",
    "https://idp.example.test/token?changed=1",
  ]) {
    await expect(carrier.transport.fetch(target)).rejects.toThrow();
  }
  await expect(
    carrier.transport.fetch("https://idp.example.test/token", {
      method: "DELETE",
    }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("aborts and settles a real headers request under the original owner cancellation", async () => {
  let entered = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const base = await server(() => entered());
  const selected = owner();
  const carrier = captureBrowserOidcHTTP(selected);
  cleanups.push(carrier.retire);
  const pending = carrier.transport.fetch(`${base}/token`);
  const refused = expect(pending).rejects.toThrow();
  await reached;
  selected.stop.abort();
  await refused;
  await carrier.retire();
});

it("retirement cancels an unread real response body before its completion promise resolves", async () => {
  let closed = () => {};
  const drained = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const base = await server((_request, response) => {
    response.on("close", closed);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"held":');
  });
  const carrier = captureBrowserOidcHTTP(owner());
  const response = await carrier.transport.fetch(`${base}/jwks`);
  expect(response.body).not.toBeNull();
  await carrier.retire();
  await drained;
});

it("does not revive a carrier after the captured global HTTP function is replaced and restored", async () => {
  const carrier = captureBrowserOidcHTTP(owner());
  const original = globalThis.fetch;
  const replacement = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("replacement"));
  expect(() => carrier.transport.assertCurrent()).toThrow();
  replacement.mockRestore();
  expect(globalThis.fetch).toBe(original);
  expect(() => carrier.transport.assertCurrent()).toThrow();
  await carrier.retire();
});

it("reserves native authority without constructing a node and refuses a later activation", () => {
  const selected = owner();
  const first = vi.fn(() => {
    throw new Error("Must remain unopened");
  });
  cleanups.push(bindIdentityBrowserNodeFactory(first));
  const open = reserveIdentityBrowserNode(selected);
  expect(first).not.toHaveBeenCalled();
  cleanups.push(
    bindIdentityBrowserNodeFactory(() => {
      throw new Error("Must not select replacement");
    }),
  );
  expect(open).toThrow("changed");
  expect(first).not.toHaveBeenCalled();
});

it("an absent initiating factory remains absent and its reservation is single use", () => {
  const open = reserveIdentityBrowserNode(owner());
  expect(open()).toBeNull();
  expect(open).toThrow("already opened");
});

it("retains shared-origin local-address and operator-header refusals before any HTTP", async () => {
  vi.spyOn(localNetworkFetchSeams, "eligible").mockReturnValue(false);
  const fetch = vi.spyOn(globalThis, "fetch");
  const carrier = captureBrowserOidcHTTP(owner());
  cleanups.push(carrier.retire);
  await expect(
    carrier.transport.fetch("http://127.0.0.1:5180/jwks"),
  ).rejects.toMatchObject({ name: "SecurityError" });
  await expect(
    carrier.transport.fetch("https://idp.example.test/token", {
      headers: { "X-OpenSesame-Operator": "public-synthetic-operator" },
    }),
  ).rejects.toMatchObject({ name: "SecurityError" });
  expect(fetch).not.toHaveBeenCalled();
});

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {};
  const promise = new Promise<Value>((completed) => {
    resolve = completed;
  });
  return { promise, resolve };
}

it("retirement waits for refused headers cancellation to physically settle", async () => {
  const entered = deferred<void>();
  const headers = deferred<Response>();
  const cancelling = deferred<void>();
  const release = deferred<void>();
  let cancelled = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    entered.resolve(undefined);
    return headers.promise;
  });
  const carrier = captureBrowserOidcHTTP(owner());
  const operation = carrier.transport.fetch("https://idp.example.test/jwks");
  const refused = expect(operation).rejects.toThrow();
  await entered.promise;
  const retirement = carrier.retire();
  let retired = false;
  void retirement.then(() => {
    retired = true;
  });
  headers.resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        async cancel() {
          cancelling.resolve(undefined);
          await release.promise;
          cancelled = true;
        },
      }),
    ),
  );
  try {
    await cancelling.promise;
    await setImmediate();
    expect(cancelled).toBe(false);
    expect(retired).toBe(false);
  } finally {
    release.resolve(undefined);
    await refused;
    await retirement;
  }
  expect(cancelled).toBe(true);
  expect(retired).toBe(true);
});

it("retirement reserves one promise before adopted body cancellation reenters", async () => {
  const cancelling = deferred<void>();
  const release = deferred<void>();
  let reentered: Promise<void> | null = null;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        reentered = carrier.retire();
        cancelling.resolve(undefined);
        return release.promise;
      },
    }),
  );
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  const carrier = captureBrowserOidcHTTP(owner());
  await carrier.transport.fetch("https://idp.example.test/jwks");
  const retirement = carrier.retire();
  let retired = false;
  void retirement.then(() => {
    retired = true;
  });
  try {
    await cancelling.promise;
    expect(reentered).toBe(retirement);
    expect(carrier.retire()).toBe(retirement);
    await setImmediate();
    expect(retired).toBe(false);
  } finally {
    release.resolve(undefined);
    await Promise.allSettled([retirement, reentered]);
  }
  expect(retired).toBe(true);
});

it("retirement joins cancellation already running on an adopted body", async () => {
  const cancelling = deferred<void>();
  const release = deferred<void>();
  const cancel = vi.fn(() => {
    cancelling.resolve(undefined);
    return release.promise;
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(new ReadableStream<Uint8Array>({ cancel })),
  );
  const carrier = captureBrowserOidcHTTP(owner());
  const response = await carrier.transport.fetch(
    "https://idp.example.test/jwks",
  );
  if (!response.body) throw new Error("Expected an adopted response body");
  const cancelled = response.body.cancel();
  await cancelling.promise;
  const retirement = carrier.retire();
  let retired = false;
  void retirement.then(() => {
    retired = true;
  });
  try {
    await setImmediate();
    expect(retired).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(undefined);
    await Promise.all([cancelled, retirement]);
  }
  expect(retired).toBe(true);
});
