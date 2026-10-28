import { type ChannelListener, channel } from "node:diagnostics_channel";
import { IncomingMessage, ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  authorize,
  deferCleanup,
  operations,
  setup,
} from "./native-oauth-resource.test-support.js";

it("physically closes a held TLS resource on caller cancellation and retains independent original operations", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  await authorize(f, saved.connectionId);
  const cancelled = new AbortController();
  cancelled.abort();
  const beforeAbort = f.captureCounts();
  const beforeRequests = f.requests.length;
  await expect(
    f.driver.invoke(
      saved.connectionId,
      "provider.resource.read",
      {},
      cancelled.signal,
    ),
  ).rejects.toThrow();
  expect(f.captureCounts()).toEqual(beforeAbort);
  expect(f.requests).toHaveLength(beforeRequests);
  const event = z.object({
    request: z.instanceof(IncomingMessage),
    response: z.instanceof(ServerResponse),
  });
  const actualServer = channel("http.server.request.start");
  let closed = false;
  const observe: ChannelListener = (message) => {
    const actual = event.parse(message);
    if (
      actual.request.url === "/resource" &&
      actual.request.headers.host === new URL(f.state.resource).host
    )
      actual.response.once("close", () => {
        closed = !actual.response.writableEnded;
      });
  };
  actualServer.subscribe(observe);
  deferCleanup(async () => {
    actualServer.unsubscribe(observe);
  });
  f.state.holdResource = true;
  const caller = new AbortController();
  const before = f.captureCounts();
  const operation = f.driver.invoke(
    saved.connectionId,
    "provider.resource.read",
    {},
    caller.signal,
  );
  operations.push(operation);
  const rejected = expect(operation).rejects.toThrow();
  expect(f.captureCounts().captures).toBe(before.captures + 1);
  expect(f.capturedSignal()).toBe(caller.signal);
  await f.entered.promise;
  const started = performance.now();
  caller.abort();
  await rejected;
  await expect.poll(() => closed, { timeout: 2000 }).toBe(true);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(f.controller.signal.aborted).toBe(false);
  expect(f.captureCounts().captures).toBe(f.captureCounts().released);
  f.release.resolve();
  f.state.holdResource = false;
  const independent = await f.driver.invoke(
    saved.connectionId,
    "provider.resource.read",
    {},
  );
  expect(JSON.parse(independent.items[0]?.secretValue ?? "null")).toEqual({
    projects: [{ id: "project-42", name: "Actual configured project" }],
  });
});
