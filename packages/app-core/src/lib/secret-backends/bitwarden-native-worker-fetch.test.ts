import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  type NativeFetchCancel,
  NativeFetchReply,
  type NativeFetchRequest,
} from "./bitwarden-native-network-protocol.js";
import { createBitwardenNativeWorkerFetch } from "./bitwarden-native-worker-fetch.js";

const closures: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closures.splice(0).reverse()) await close();
});
function fixture() {
  const controller = new AbortController();
  const posted: (NativeFetchRequest | NativeFetchCancel)[] = [];
  const owner = createBitwardenNativeWorkerFetch(
    (value) => posted.push(value),
    controller.signal,
  );
  closures.push(owner.close);
  return { controller, posted, owner };
}
function reply(id: number, status = 200, text = "response") {
  return NativeFetchReply.parse({
    type: "native-fetch-reply",
    id,
    ok: true,
    status,
    statusText: "",
    headers: [["content-type", "application/json"]],
    body: new TextEncoder().encode(text),
  });
}
it("round trips actual owned HTTP form, JSON, authorization, negative status, and empty 204", async () => {
  const seen: {
    path: string;
    body: string;
    authorization: string | undefined;
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({
      path: request.url ?? "",
      body: Buffer.concat(chunks).toString(),
      authorization: request.headers.authorization,
    });
    const status =
      request.url === "/denied" ? 401 : request.url === "/empty" ? 204 : 200;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      status === 204 ? undefined : JSON.stringify({ operation: request.url }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  closures.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const controller = new AbortController();
  const physical = new Map<number, AbortController>();
  const jobs: Promise<void>[] = [];
  const worker = createBitwardenNativeWorkerFetch((value) => {
    if (value.type === "native-fetch-cancel") {
      physical.get(value.id)?.abort();
      return;
    }
    const operation = new AbortController();
    physical.set(value.id, operation);
    jobs.push(
      (async () => {
        try {
          const response = await fetch(value.url, {
            method: value.method,
            headers: value.headers,
            body: value.body || undefined,
            signal: operation.signal,
          });
          worker.receive(
            NativeFetchReply.parse({
              type: "native-fetch-reply",
              id: value.id,
              ok: true,
              status: response.status,
              statusText: response.statusText,
              headers: [...response.headers.entries()],
              body: new Uint8Array(await response.arrayBuffer()),
            }),
          );
        } catch {
          worker.receive({
            type: "native-fetch-reply",
            id: value.id,
            ok: false,
          });
        } finally {
          physical.delete(value.id);
        }
      })(),
    );
  }, controller.signal);
  closures.push(async () => {
    worker.close();
    await Promise.all(jobs);
  });
  const base = `http://127.0.0.1:${address.port}`;
  const form = new URLSearchParams({ password: "synthetic + 🔐" });
  expect(
    await (
      await worker.fetch(new URL(`${base}/token`), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      })
    ).json(),
  ).toEqual({ operation: "/token" });
  expect(
    await (
      await worker.fetch(`${base}/item`, {
        method: "PUT",
        headers: {
          authorization: "Bearer owned-token",
          "content-type": "application/json",
        },
        body: '{"cipher":"owned encrypted bytes"}',
      })
    ).json(),
  ).toEqual({ operation: "/item" });
  const denied = await worker.fetch(`${base}/denied`);
  expect(denied.status).toBe(401);
  expect(denied.ok).toBe(false);
  const empty = await worker.fetch(`${base}/empty`);
  expect(empty.status).toBe(204);
  expect(await empty.text()).toBe("");
  expect(seen).toEqual([
    { path: "/token", body: form.toString(), authorization: undefined },
    {
      path: "/item",
      body: '{"cipher":"owned encrypted bytes"}',
      authorization: "Bearer owned-token",
    },
    { path: "/denied", body: "", authorization: undefined },
    { path: "/empty", body: "", authorization: undefined },
  ]);
});
it("cancels the exact pending request and ignores its late response without replay", async () => {
  const { owner, posted } = fixture();
  const first = new AbortController();
  const held = owner.fetch("https://vault.example/held", {
    signal: first.signal,
  });
  const rejected = expect(held).rejects.toMatchObject({ code: "network" });
  const other = owner.fetch("https://vault.example/other");
  first.abort();
  await rejected;
  expect(posted.at(-1)).toEqual({ type: "native-fetch-cancel", id: 1 });
  expect(owner.receive(reply(1))).toBe(true);
  expect(owner.receive(reply(2, 200, "other"))).toBe(true);
  expect(await (await other).text()).toBe("other");
  expect(posted.filter((row) => row.type === "native-fetch")).toHaveLength(2);
});
it("withdrawal ends every pending operation and a pre-withdrawn owner dispatches nothing", async () => {
  const { controller, owner, posted } = fixture();
  const pending = [
    owner.fetch("https://vault.example/one"),
    owner.fetch("https://vault.example/two"),
  ];
  const rejected = pending.map((request) =>
    expect(request).rejects.toMatchObject({ code: "network" }),
  );
  controller.abort();
  await Promise.all(rejected);
  expect(posted.slice(2)).toEqual([
    { type: "native-fetch-cancel", id: 1 },
    { type: "native-fetch-cancel", id: 2 },
  ]);
  await expect(owner.fetch("https://vault.example/late")).rejects.toMatchObject(
    { code: "network" },
  );
  const ended = new AbortController();
  ended.abort();
  const messages: NativeFetchRequest[] = [];
  const closed = createBitwardenNativeWorkerFetch((value) => {
    if (value.type === "native-fetch") messages.push(value);
  }, ended.signal);
  await expect(closed.fetch("https://vault.example/no")).rejects.toMatchObject({
    code: "network",
  });
  expect(messages).toEqual([]);
});
it("bounds concurrent requests, rejects malformed replies, and clears completed capacity", async () => {
  const { owner, posted } = fixture();
  const pending = Array.from({ length: 4 }, () =>
    owner.fetch("https://vault.example/pending"),
  );
  await expect(
    owner.fetch("https://vault.example/overflow"),
  ).rejects.toMatchObject({ code: "network" });
  expect(posted).toHaveLength(4);
  expect(
    owner.receive({
      type: "native-fetch-reply",
      id: 1,
      ok: true,
      token: "must not cross",
    }),
  ).toBe(false);
  expect(owner.receive({ type: "native-fetch-reply", id: 1, ok: false })).toBe(
    true,
  );
  await expect(pending[0]).rejects.toMatchObject({ code: "network" });
  for (const id of [2, 3, 4]) owner.receive(reply(id));
  await Promise.all(pending.slice(1));
  const later = owner.fetch("https://vault.example/later");
  owner.receive(reply(5, 204, ""));
  expect((await later).status).toBe(204);
});
it("rejects unsupported inputs, UTF8 oversized bodies, pre-abort, and failed posting without dispatch", async () => {
  const { owner, posted } = fixture();
  const ended = new AbortController();
  ended.abort();
  const requests = [
    owner.fetch(new Request("https://vault.example/no")),
    owner.fetch("https://vault.example/no", { method: "DELETE" }),
    owner.fetch("https://vault.example/no", {
      method: "POST",
      body: new Uint8Array([1]),
    }),
    owner.fetch("https://vault.example/no", {
      method: "POST",
      body: "🔐".repeat(2 * 1024 * 1024 + 1),
    }),
    owner.fetch("https://vault.example/no", { signal: ended.signal }),
  ];
  for (const request of requests)
    await expect(request).rejects.toMatchObject({ code: "network" });
  expect(posted).toEqual([]);
  const broken = createBitwardenNativeWorkerFetch(() => {
    throw new Error("private transport detail");
  }, new AbortController().signal);
  await expect(broken.fetch("https://vault.example/no")).rejects.toMatchObject({
    code: "network",
    message: "The captured native Bitwarden network operation ended.",
  });
  broken.close();
});
it("rejects invalid HTTP reconstruction and releases the pending entry", async () => {
  const { owner } = fixture();
  const held = owner.fetch("https://vault.example/no-content");
  owner.receive(reply(1, 204, "invalid nonempty 204"));
  await expect(held).rejects.toMatchObject({ code: "network" });
  const next = owner.fetch("https://vault.example/next");
  owner.receive(reply(2, 200, "next"));
  expect(await (await next).text()).toBe("next");
});
