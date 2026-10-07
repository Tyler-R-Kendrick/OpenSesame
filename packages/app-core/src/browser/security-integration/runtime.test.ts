/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { kvSetDurable } from "../../lib/kv.js";
import { HEADER_PATH, tombFileKey } from "../../lib/vfs.js";
import { SECURITY_PORT } from "../security/broker.js";
import { action } from "../security/dom.js";
import { click, ownerPanel } from "./panel-dom.fixture.js";

it("keeps a rendered action pending until genuine completion despite clock advancement", async () => {
  vi.useFakeTimers();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let state = "pending";
  let performed = false;
  const control = action(
    "Held rendered action",
    async () => {
      await held;
      performed = true;
    },
    () => {},
  );
  document.body.append(control);
  const completion = click("Held rendered action").then(
    () => {
      state = "completed";
    },
    () => {
      state = "failed";
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(1500);
    expect(state).toBe("pending");
    expect(control.disabled).toBe(true);
    expect(performed).toBe(false);
    release();
    await completion;
    expect(state).toBe("completed");
    expect(control.disabled).toBe(false);
    expect(performed).toBe(true);
  } finally {
    release();
    vi.useRealTimers();
  }
});

it("accepts the actual extension owner port but rejects foreign identities and webpage senders before any credential work", async () => {
  const f = await ownerPanel();
  expect(await f.bridge.client.authorize()).toBe(true);
  for (const sender of [
    undefined,
    {
      id: "another-extension",
      url: "chrome-extension://trusted-extension/security.html",
    },
    { id: "trusted-extension", url: "https://untrusted.example" },
    { id: "trusted-extension" },
  ]) {
    const port = f.bridge.open(SECURITY_PORT, sender);
    expect(port.closed()).toBe(true);
    expect(port.replies).toEqual([]);
    expect(() =>
      port.page.postMessage({
        id: 0,
        op: "unlock",
        password: f.owner.password,
      }),
    ).toThrow("disconnected");
  }
  const unrelated = f.bridge.open("unrelated-channel", {
    id: "trusted-extension",
    url: "chrome-extension://trusted-extension/security.html",
  });
  unrelated.page.postMessage({ unexpected: true });
  expect(unrelated.closed()).toBe(false);
  expect(unrelated.replies).toEqual([]);
  expect(await f.bridge.client.authorize()).toBe(true);
});

it("malformed browser messages revoke only their actual port; a separately authenticated owner recovers", async () => {
  const f = await ownerPanel();
  const original = f.bridge.client.permit();
  expect(original).toBeDefined();
  f.bridge.transport.page.postMessage({
    id: 1,
    op: "manage",
    operation: { verb: "receiver-status" },
    password: f.owner.password,
    permit: original,
    unexpectedAuthority: true,
  });
  expect(f.bridge.transport.closed()).toBe(true);
  expect(f.bridge.client.permit()).toBeUndefined();
  expect(await f.bridge.broker.allows(original)).toBe(false);
  expect(await f.bridge.client.authorize()).toBe(false);
  const fresh = f.bridge.open(SECURITY_PORT, {
    id: "trusted-extension",
    url: "chrome-extension://trusted-extension/security.html",
  });
  fresh.page.postMessage({ id: 10, op: "unlock", password: f.owner.password });
  await vi.waitFor(() => expect(fresh.replies).toHaveLength(1));
  expect(fresh.replies[0].realm).toBe("real");
  expect(await f.bridge.broker.allows(fresh.replies[0].permit)).toBe(true);
  fresh.close();
  expect(await f.bridge.broker.allows(fresh.replies[0].permit)).toBe(false);
});

it("a failed browser reply cannot leave its undelivered production permit valid", async () => {
  const f = await ownerPanel();
  const original = f.bridge.client.permit();
  f.bridge.transport.failReplies();
  f.bridge.transport.page.postMessage({
    id: 42,
    op: "authorize",
    permit: original,
  });
  await vi.waitFor(async () =>
    expect(await f.bridge.broker.allows(original)).toBe(false),
  );
  f.bridge.transport.close();
  expect(f.bridge.client.permit()).toBeUndefined();
  expect(await f.bridge.client.authorize()).toBe(false);
});

it("a rejected authorization read closes its browser port and never treats damaged protected storage as unprotected", async () => {
  const f = await ownerPanel();
  const original = f.bridge.client.permit();
  await kvSetDurable(
    tombFileKey("personal", HEADER_PATH),
    "damaged-protected-header",
  );
  await expect(f.bridge.client.authorize()).resolves.toBe(false);
  expect(f.bridge.transport.closed()).toBe(true);
  expect(f.bridge.client.permit()).toBeUndefined();
  await kvSetDurable(
    tombFileKey("personal", HEADER_PATH),
    JSON.stringify(f.owner.header),
  );
  expect(await f.bridge.broker.allows(original)).toBe(false);
  const fresh = f.bridge.open(SECURITY_PORT, {
    id: "trusted-extension",
    url: "chrome-extension://trusted-extension/security.html",
  });
  fresh.page.postMessage({ id: 20, op: "unlock", password: f.owner.password });
  await vi.waitFor(() => expect(fresh.replies).toHaveLength(1));
  expect(fresh.replies[0].realm).toBe("real");
});
