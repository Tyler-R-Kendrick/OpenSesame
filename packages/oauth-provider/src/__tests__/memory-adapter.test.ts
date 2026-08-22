import { isNumber } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createMemoryAdapterConstructor } from "../adapter/memory-adapter.js";

describe("memory oidc adapter", () => {
  it("round-trips a payload through upsert and find", async () => {
    const Adapter = createMemoryAdapterConstructor();
    const sessions = new Adapter("Session");

    expect(await sessions.find("s1")).toBeUndefined();

    await sessions.upsert("s1", { grantId: "g1", uid: "u1" });
    const found = await sessions.find("s1");
    expect(found?.grantId).toBe("g1");
    expect(found?.uid).toBe("u1");
  });

  it("keeps models isolated from each other", async () => {
    const Adapter = createMemoryAdapterConstructor();
    const sessions = new Adapter("Session");
    const codes = new Adapter("AuthorizationCode");

    await sessions.upsert("shared-id", { uid: "u1" });
    expect(await codes.find("shared-id")).toBeUndefined();
    expect(await sessions.find("shared-id")).toBeDefined();
  });

  it("purges expired entries on read and drops their indexes", async () => {
    const Adapter = createMemoryAdapterConstructor();
    const codes = new Adapter("DeviceCode");

    // expiresIn 0 means the entry is already stale by the next read.
    await codes.upsert("d1", { userCode: "CODE-1", grantId: "g9" }, 0);
    expect(await codes.find("d1")).toBeUndefined();
    expect(await codes.findByUserCode("CODE-1")).toBeUndefined();

    // Revoking the grant of an already-purged entry must be a no-op.
    await codes.revokeByGrantId("g9");
  });

  it("keeps entries without a TTL until destroyed", async () => {
    const Adapter = createMemoryAdapterConstructor();
    const grants = new Adapter("Grant");

    await grants.upsert("g1", { uid: "u1" });
    expect(await grants.find("g1")).toBeDefined();
  });

  it("finds payloads by userCode and uid", async () => {
    const Adapter = createMemoryAdapterConstructor();
    const codes = new Adapter("DeviceCode");

    expect(await codes.findByUserCode("nope")).toBeUndefined();
    expect(await codes.findByUid("nope")).toBeUndefined();

    await codes.upsert("d1", { userCode: "CODE-1", uid: "uid-1" });
    expect((await codes.findByUserCode("CODE-1"))?.uid).toBe("uid-1");
    expect((await codes.findByUid("uid-1"))?.userCode).toBe("CODE-1");
  });

  it("does not leak userCode/uid lookups across models", async () => {
    const Adapter = createMemoryAdapterConstructor();
    const codes = new Adapter("DeviceCode");
    const sessions = new Adapter("Session");

    await codes.upsert("d1", { userCode: "CODE-1", uid: "uid-1" });
    expect(await sessions.findByUserCode("CODE-1")).toBeUndefined();
    expect(await sessions.findByUid("uid-1")).toBeUndefined();
  });

  it("destroy removes the payload and its indexes", async () => {
    const Adapter = createMemoryAdapterConstructor();
    const codes = new Adapter("DeviceCode");

    await codes.upsert("d1", { userCode: "CODE-1", uid: "uid-1" });
    await codes.destroy("d1");

    expect(await codes.find("d1")).toBeUndefined();
    expect(await codes.findByUserCode("CODE-1")).toBeUndefined();
    expect(await codes.findByUid("uid-1")).toBeUndefined();

    // Destroying an unknown id must not throw.
    await codes.destroy("d1");
  });

  it("consume stamps the stored payload", async () => {
    const Adapter = createMemoryAdapterConstructor();
    const codes = new Adapter("AuthorizationCode");

    await codes.upsert("c1", {});
    await codes.consume("c1");
    const found = await codes.find("c1");
    expect(isNumber(found?.consumed)).toBe(true);

    // Consuming an unknown id must not throw.
    await codes.consume("missing");
  });

  it("revokeByGrantId destroys every payload in the grant", async () => {
    const Adapter = createMemoryAdapterConstructor();
    const sessions = new Adapter("Session");
    const tokens = new Adapter("AccessToken");

    await sessions.upsert("s1", { grantId: "g1" });
    await tokens.upsert("t1", { grantId: "g1" });
    await tokens.upsert("t2", { grantId: "g2" });

    await tokens.revokeByGrantId("g1");

    expect(await tokens.find("t1")).toBeUndefined();
    expect(await tokens.find("t2")).toBeDefined();
    // The Session model entry for g1 is removed too (grant-wide revocation).
    expect(await sessions.find("s1")).toBeUndefined();

    // Unknown grant is a no-op.
    await tokens.revokeByGrantId("g-unknown");
    expect(await tokens.find("t2")).toBeDefined();
  });

  it("still revokes remaining grant members after one was destroyed", async () => {
    const Adapter = createMemoryAdapterConstructor();
    const tokens = new Adapter("AccessToken");

    await tokens.upsert("t1", { grantId: "g1" });
    await tokens.upsert("t2", { grantId: "g1" });
    await tokens.destroy("t1");

    await tokens.revokeByGrantId("g1");
    expect(await tokens.find("t2")).toBeUndefined();
  });
});
