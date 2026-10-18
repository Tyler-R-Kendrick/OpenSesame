import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  NATIVE_LIMITS,
  NATIVE_PASSWORD,
  nativeHttpFixture,
} from "./bitwarden-native-http.test-support.js";
import {
  NativeWorkerReply,
  NativeWorkerRequest,
  type NativeWorkerSettings,
} from "./bitwarden-native-worker-protocol.js";
import { createBitwardenNativeWorkerRuntime } from "./bitwarden-native-worker-runtime.js";

type Fixture = Awaited<ReturnType<typeof nativeHttpFixture>>;
const fixtures: Fixture[] = [];
const closures: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closures.splice(0)) await close();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
function settings(fixture: Fixture): NativeWorkerSettings {
  const { email: accountEmail, ...credentials } = fixture.credentials;
  return {
    ...credentials,
    accountEmail,
    masterPassword: NATIVE_PASSWORD,
    providerId: "bitwarden",
    name: "Owned native worker",
    vaultId: "",
  };
}
async function runtime(modern: boolean) {
  const fixture = await nativeHttpFixture(modern);
  fixtures.push(fixture);
  const replies: NativeWorkerReply[] = [];
  const awaiting = new Map<number, (value: NativeWorkerReply) => void>();
  let finishClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const owner = createBitwardenNativeWorkerRuntime(
    {
      send(value) {
        replies.push(value);
        awaiting.get(value.id)?.(value);
        awaiting.delete(value.id);
      },
      close: finishClose,
    },
    fixture.transport,
    NATIVE_LIMITS,
  );
  closures.push(owner.dispose);
  const invoke = (request: NativeWorkerRequest) =>
    new Promise<NativeWorkerReply>((resolve) => {
      awaiting.set(request.id, resolve);
      owner.receive(request);
    });
  return { fixture, owner, invoke, replies, closed };
}
it.each([false, true])(
  "executes the strict worker command surface with actual encrypted native HTTP modern=%s",
  async (modern) => {
    const open = await runtime(modern);
    const input = settings(open.fixture);
    expect(
      await open.invoke({ id: 1, type: "initialize", settings: input }),
    ).toEqual({ id: 1, ok: true, value: null });
    expect(input.masterPassword).toBe(NATIVE_PASSWORD);
    const item = {
      kind: "note" as const,
      name: "Worker-owned private note 🔐",
      notes: "Worker plaintext stays out of HTTP",
      secret: "",
    };
    const created = NativeWorkerReply.parse(
      await open.invoke({ id: 2, type: "create", item }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("Expected completed create.");
    const value = created.value;
    const parsed = NativeWorkerRequest.parse({
      id: 3,
      type: "get",
      selector: nativeItemId(value),
    });
    expect(await open.invoke(parsed)).toEqual({
      id: 3,
      ok: true,
      value: created.value,
    });
    expect(
      await open.invoke({
        id: 4,
        type: "notes",
        selector: nativeItemId(value),
      }),
    ).toEqual({ id: 4, ok: true, value: item.notes });
    const list = await open.invoke({ id: 5, type: "list" });
    expect(list).toMatchObject({
      ok: true,
      value: [{ name: item.name, kind: "note" }],
    });
    expect(
      await open.invoke({
        id: 6,
        type: "update",
        itemId: nativeItemId(value),
        item: { ...item, notes: "Updated inside worker runtime" },
      }),
    ).toMatchObject({
      ok: true,
      value: { notes: "Updated inside worker runtime" },
    });
    expect(
      await open.invoke({ id: 7, type: "delete", itemId: nativeItemId(value) }),
    ).toEqual({ id: 7, ok: true, value: null });
    for (const request of open.fixture.requests.filter(
      (row) => row.path.startsWith("/api/ciphers") && row.method !== "GET",
    )) {
      expect(request.body).not.toContain(item.notes);
      expect(request.body).not.toContain(NATIVE_PASSWORD);
    }
    open.owner.receive({ id: 8, type: "dispose" });
    await open.closed;
  },
);
function nativeItemId(value: BoundaryValue): string {
  return z.object({ id: z.string().uuid() }).parse(value).id;
}

it("rejects invalid/replayed commands and closes the exact runtime without forwarding provider requests", async () => {
  const open = await runtime(false);
  const count = open.fixture.requests.length;
  open.owner.receive({
    id: 1,
    type: "get",
    selector: "x",
    key: "do not accept arbitrary crypto commands",
  });
  await open.closed;
  expect(open.replies).toEqual([]);
  expect(open.fixture.requests.length).toBe(count);
  const another = await runtime(false);
  expect(
    await another.invoke({
      id: 1,
      type: "initialize",
      settings: settings(another.fixture),
    }),
  ).toMatchObject({ ok: true });
  another.owner.receive({ id: 1, type: "list" });
  await another.closed;
  expect(another.replies).toHaveLength(1);
});
it("withdraws a pending initialization through the captured lifetime and emits no late ready result", async () => {
  const open = await runtime(true);
  const held = open.fixture.hold("/api/sync?excludeDomains=true", "GET");
  open.owner.receive({
    id: 1,
    type: "initialize",
    settings: settings(open.fixture),
  });
  await held.ready;
  open.fixture.controller.abort();
  await open.closed;
  held.release();
  expect(open.replies).toEqual([]);
});
it("reports sanitized authentication failure and closes instead of retaining a token-only worker", async () => {
  const open = await runtime(false);
  const input = settings(open.fixture);
  input.masterPassword = "wrong transient password";
  expect(
    await open.invoke({ id: 1, type: "initialize", settings: input }),
  ).toMatchObject({ ok: false, code: "authentication" });
  await open.closed;
  expect(JSON.stringify(open.replies)).not.toContain(input.masterPassword);
});
