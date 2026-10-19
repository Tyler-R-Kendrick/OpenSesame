import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, expect, it, vi } from "vitest";
import { configureNativeApiConnector } from "./native-api-connectors.js";
import {
  type NativeApiOperationDefinition,
  executeNativeApiRequest,
} from "./native-api-operations.js";
import {
  deferredOperation,
  operationKey,
  operationOracle,
} from "./native-api-operations.test-support.js";
import {
  installNativeApiTests,
  nativeApiDraft,
} from "./native-api.test-support.js";

installNativeApiTests();
const oracles: Awaited<ReturnType<typeof operationOracle>>[] = [];
afterEach(async () => {
  for (const oracle of oracles.splice(0)) await oracle.close();
});
async function oracle(
  provider: Parameters<typeof operationOracle>[0] = "similarweb",
) {
  const result = await operationOracle(provider);
  oracles.push(result);
  return result;
}
function definition(
  providerId = "similarweb",
  changes: Partial<NativeApiOperationDefinition> = {},
): NativeApiOperationDefinition {
  return {
    providerId,
    operationId: "resource.read",
    method: "GET",
    path: "/resource",
    ...changes,
  };
}
function project(body: BoundaryValue): BoundaryValue {
  if (!isJsonObject(body) || !isString(body.label))
    throw new Error(JSON.stringify(body));
  return { label: body.label };
}
function execute(
  o: Awaited<ReturnType<typeof oracle>>,
  changes: Partial<NativeApiOperationDefinition> = {},
  body: BoundaryValue = {},
) {
  return executeNativeApiRequest(
    o.view.connectionId,
    definition(o.view.configuration.providerId, changes),
    body,
    project,
    o.transport,
  );
}
it.each(["similarweb", "telegram"] as const)(
  "%s injects only its compiled query/path credential into a real consumed request",
  async (provider) => {
    const o = await oracle(provider);
    o.reply((_request, response) =>
      response.end(
        JSON.stringify({ label: "Consumed resource", ignored: operationKey }),
      ),
    );
    expect(
      await execute(o, {
        query: { search: "a & b/安全?x=1", page: 2, active: true },
      }),
    ).toEqual({ label: "Consumed resource" });
    const last = o.requests.at(-1);
    expect(last?.authorized).toBe(true);
    const url = new URL(last?.path ?? "", "https://oracle.test");
    expect(url.pathname).toBe(
      provider === "telegram"
        ? `/bot${encodeURIComponent(operationKey)}/resource`
        : "/resource",
    );
    expect(url.searchParams.get("search")).toBe("a & b/安全?x=1");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("active")).toBe("true");
    expect(url.searchParams.getAll("api_key")).toHaveLength(
      provider === "similarweb" ? 1 : 0,
    );
  },
);
it.each(["openai", "mailgun", "datadog", "anthropic"] as const)(
  "%s preserves real model POST JSON and compiled header/Basic auth",
  async (provider) => {
    const o = await oracle(provider);
    o.reply((_request, response) => response.end('{"label":"Model result"}'));
    const sent = vi.fn();
    expect(
      await execute(
        o,
        {
          method: "POST",
          path: "/v1/chat/completions",
          onDispatch: sent,
          headers:
            provider === "anthropic"
              ? {
                  "anthropic-version": "2023-06-01",
                  "anthropic-dangerous-direct-browser-access": "true",
                }
              : {},
        },
        { messages: [{ role: "user", content: "Hello" }] },
      ),
    ).toEqual({ label: "Model result" });
    expect(o.requests.at(-1)).toMatchObject({
      authorized: true,
      method: "POST",
      path: "/v1/chat/completions",
    });
    expect(JSON.parse(o.requests.at(-1)?.body ?? "null")).toEqual({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(sent).toHaveBeenCalledOnce();
  },
);
it("rejects traversal, escaped retargets, raw query/fragment and invalid query values before dispatch", async () => {
  const o = await oracle();
  const paths = [
    "//evil.test/resource",
    "/../resource",
    "/a/./resource",
    "/%2e%2e/resource",
    "/%252e%252e/resource",
    "/a%2fresource",
    "/a%5cresource",
    "/a\\resource",
    "/resource?other=1",
    "/resource#fragment",
    "/bad%",
    `/${"a".repeat(2048)}`,
  ];
  const sent = vi.fn();
  for (const path of paths)
    await expect(execute(o, { path, onDispatch: sent })).rejects.toThrow();
  const invalid = [
    { api_key: "replacement" },
    { "bad&name": "x" },
    { constructor: "x" },
    { q: ["unexpected"] },
    { q: Number.NaN },
    { q: "x\n" },
    { q: "x".repeat(1025) },
    Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`field${index}`, "x"]),
    ),
    {
      a: "x".repeat(1024),
      b: "x".repeat(1024),
      c: "x".repeat(1024),
      d: "x".repeat(1024),
    },
  ];
  for (const query of invalid)
    await expect(
      execute(o, { query: overlapCast(query), onDispatch: sent }),
    ).rejects.toThrow();
  await expect(
    execute(o, { origin: "https://evil.test", onDispatch: sent }),
  ).rejects.toThrow("compiled target");
  expect(o.requests).toHaveLength(1);
  expect(sent).not.toHaveBeenCalled();
});
it("refuses raw and wire-encoded input/output credential echoes without exposing upstream errors", async () => {
  const o = await oracle();
  const encodings = [
    operationKey,
    encodeURIComponent(operationKey),
    new URLSearchParams({ value: operationKey }).toString().slice(6),
  ];
  for (const value of encodings) {
    await expect(execute(o, { query: { q: value } })).rejects.toMatchObject({
      code: "response",
    });
    await expect(
      execute(o, { path: `/resource/${value}` }),
    ).rejects.toMatchObject({ code: "response" });
    await expect(
      execute(o, { headers: { "x-query": value } }),
    ).rejects.toMatchObject({ code: "response" });
    await expect(
      execute(o, { method: "POST" }, { input: value }),
    ).rejects.toMatchObject({ code: "response" });
  }
  expect(o.requests).toHaveLength(1);
  for (const value of encodings) {
    o.reply((_request, response) =>
      response.end(JSON.stringify({ label: value })),
    );
    await expect(execute(o)).rejects.toMatchObject({
      code: "response",
      message: "Provider did not return the expected response",
    });
  }
  o.reply((_request, response) =>
    response.end(JSON.stringify({ error: operationKey })),
  );
  await expect(execute(o)).rejects.toMatchObject({
    code: "response",
    message: "Provider did not return the expected response",
  });
});
it("cannot override a secondary credential-bearing header", async () => {
  const o = await oracle("datadog");
  await expect(
    execute(o, { headers: { "DD-APPLICATION-KEY": "replacement" } }),
  ).rejects.toThrow("credential placement");
  expect(o.requests).toHaveLength(1);
});
it("bounds the actual streamed response at256KiB", async () => {
  const o = await oracle();
  const closed = deferredOperation();
  o.reply((_request, response) => {
    response.once("close", closed.resolve);
    response.write(`{"label":"${"x".repeat(256 * 1024)}`);
  });
  await expect(execute(o)).rejects.toMatchObject({ code: "response" });
  await closed.promise;
});
it.each(["owner", "caller"] as const)(
  "physically cancels a held TLS body when the original %s withdraws, including onDispatch",
  async (kind) => {
    const o = await oracle();
    const arrived = deferredOperation();
    const closed = deferredOperation();
    o.reply((_request, response) => {
      response.once("close", closed.resolve);
      response.write('{"label":"');
      arrived.resolve();
    });
    const caller = new AbortController();
    const sent = vi.fn();
    const pending = execute(o, { signal: caller.signal, onDispatch: sent });
    const rejection = expect(pending).rejects.toThrow();
    await arrived.promise;
    (kind === "owner" ? o.owner : caller).abort();
    await rejection;
    await closed.promise;
    expect(sent).toHaveBeenCalledOnce();
  },
);
it("rejects a held consumed result after saved revision changes and never dispatches after owner withdrawal", async () => {
  const o = await oracle();
  const arrived = deferredOperation();
  let finish: () => void = () => {};
  o.reply((_request, response) => {
    finish = () => response.end('{"label":"Stale result"}');
    arrived.resolve();
  });
  const pending = execute(o);
  const rejection = expect(pending).rejects.toThrow("changed");
  await arrived.promise;
  o.reply((_request, response) => response.end('{"name":"Renamed API"}'));
  await configureNativeApiConnector(
    {
      ...nativeApiDraft(),
      providerId: "similarweb",
      credentials: { api_key: operationKey },
      connectionId: o.view.connectionId,
      revision: o.view.revision,
      displayName: "Renamed",
    },
    o.transport,
  );
  finish();
  await rejection;
  o.owner.abort();
  const sent = vi.fn();
  await expect(execute(o, { onDispatch: sent })).rejects.toThrow();
  expect(sent).not.toHaveBeenCalled();
  expect(o.requests).toHaveLength(3);
});
