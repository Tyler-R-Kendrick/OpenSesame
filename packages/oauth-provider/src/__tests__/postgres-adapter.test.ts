import { describe, expect, it, vi } from "vitest";
import {
  type PostgresOidcStore,
  createPostgresAdapterConstructor,
} from "../adapter/types.js";

function createStore() {
  return {
    upsert: vi.fn(async () => {}),
    find: vi.fn(async () => ({ grantId: "g1" })),
    findByUserCode: vi.fn(async () => undefined),
    findByUid: vi.fn(async () => ({ uid: "u1" })),
    destroy: vi.fn(async () => {}),
    consume: vi.fn(async () => {}),
    revokeByGrantId: vi.fn(async () => {}),
  } satisfies PostgresOidcStore;
}

describe("createPostgresAdapterConstructor", () => {
  it("delegates every adapter method to the store with the model name", async () => {
    const store = createStore();
    const Adapter = createPostgresAdapterConstructor(store);
    const adapter = new Adapter("Session");

    await adapter.find("s1");
    expect(store.find).toHaveBeenCalledWith("Session", "s1");

    await adapter.findByUserCode("code-1");
    expect(store.findByUserCode).toHaveBeenCalledWith("Session", "code-1");

    const byUid = await adapter.findByUid("uid-1");
    expect(store.findByUid).toHaveBeenCalledWith("Session", "uid-1");
    expect(byUid?.uid).toBe("u1");

    await adapter.destroy("s1");
    expect(store.destroy).toHaveBeenCalledWith("Session", "s1");

    await adapter.consume("s1");
    expect(store.consume).toHaveBeenCalledWith("Session", "s1");

    await adapter.revokeByGrantId("g1");
    expect(store.revokeByGrantId).toHaveBeenCalledWith("g1");
  });

  it("converts expiresIn seconds to an absolute expiry Date", async () => {
    const store = createStore();
    const Adapter = createPostgresAdapterConstructor(store);
    const adapter = new Adapter("AccessToken");

    const before = Date.now();
    await adapter.upsert("t1", { grantId: "g1" }, 60);
    const after = Date.now();

    expect(store.upsert).toHaveBeenCalledTimes(1);
    const [model, id, payload, expiresAt] = store.upsert.mock.calls[0] ?? [];
    expect(model).toBe("AccessToken");
    expect(id).toBe("t1");
    expect(payload).toEqual({ grantId: "g1" });
    expect(expiresAt).toBeInstanceOf(Date);
    const ms = (expiresAt as Date).getTime();
    expect(ms).toBeGreaterThanOrEqual(before + 60_000);
    expect(ms).toBeLessThanOrEqual(after + 60_000);
  });

  it("passes a null expiry when expiresIn is omitted", async () => {
    const store = createStore();
    const Adapter = createPostgresAdapterConstructor(store);
    const adapter = new Adapter("Grant");

    await adapter.upsert("g1", {});
    expect(store.upsert).toHaveBeenCalledWith("Grant", "g1", {}, null);
  });
});
