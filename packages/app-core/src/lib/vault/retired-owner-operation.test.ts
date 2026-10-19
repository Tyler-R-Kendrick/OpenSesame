/** Genuine fresh-owner crypto integrated through private Store management membership. */
import { parseTotp, totpCode } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  OWNER_PASSWORD,
  OWNER_TOTP,
  retiredOwnerFixture,
} from "./retired-owner.fixture.js";
const primary = { kind: "password" as const, secret: OWNER_PASSWORD };
const slot = "tomb/personal/retired-credentials.v2";
describe("private retired management", () => {
  it("freshly authenticates, durably enrolls, inspects and removes without unlocking a session", async () => {
    const f = await retiredOwnerFixture();
    try {
      const enrolled = await f.store.beginRetired(primary, {
        kind: "change",
        change: {
          type: "enroll",
          password: "formerly used credential 7462",
          response: "reject",
        },
      });
      expect(enrolled.kind).toBe("complete");
      if (enrolled.kind !== "complete") throw new Error("Unexpected factor");
      expect(enrolled.result.traps).toHaveLength(1);
      expect(f.records.get(slot)).not.toContain("formerly used credential");
      expect(f.store.getSnapshot().status).toBe("locked");
      expect(f.held).toEqual([]);
      expect(f.closed()).toBeGreaterThanOrEqual(4);
      const inspected = await f.store.beginRetired(primary, {
        kind: "inspect",
      });
      if (inspected.kind !== "complete") throw new Error("Unexpected factor");
      expect(f.store.isRetiredResultCurrent(enrolled.result)).toBe(false);
      expect(inspected.result.traps).toHaveLength(1);
      const id = inspected.result.traps[0]?.id;
      if (!id) throw new Error("Missing enrolled id");
      const removed = await f.store.beginRetired(primary, {
        kind: "change",
        change: { type: "remove", id },
      });
      if (removed.kind !== "complete") throw new Error("Unexpected factor");
      expect(removed.result.traps).toEqual([]);
    } finally {
      f.dispose();
    }
  });
  it("refuses wrong fresh primary and current-credential enrollment", async () => {
    const f = await retiredOwnerFixture();
    try {
      await expect(
        f.store.beginRetired(
          { kind: "password", secret: "wrong" },
          { kind: "inspect" },
        ),
      ).rejects.toThrow();
      await expect(
        f.store.beginRetired(primary, {
          kind: "change",
          change: {
            type: "enroll",
            password: OWNER_PASSWORD,
            response: "reject",
          },
        }),
      ).rejects.toThrow();
      expect(f.records.size).toBe(0);
      expect(f.held).toEqual([]);
    } finally {
      f.dispose();
    }
  });
  it("holds genuine leases through TOTP and refuses authority before factor completion", async () => {
    const f = await retiredOwnerFixture(true);
    try {
      const started = await f.store.beginRetired(primary, { kind: "inspect" });
      if (started.kind !== "challenge")
        throw new Error("Missing configured challenge");
      expect(started.routes).toEqual(["totp", "recovery"]);
      expect(f.held).toEqual([
        "opensesame.retired-credentials",
        "opensesame:vault-body:personal",
      ]);
      await expect(
        f.store.beginRetired(primary, { kind: "inspect" }),
      ).rejects.toThrow();
      const result = await started.complete({
        kind: "totp",
        code: await totpCode(parseTotp(OWNER_TOTP)),
      });
      expect(result.traps).toEqual([]);
      expect(f.held).toEqual([]);
      expect(f.store.getSnapshot().status).toBe("locked");
    } finally {
      f.dispose();
    }
  });
  it("spends a recovery factor durably and refuses reuse", async () => {
    const f = await retiredOwnerFixture(true);
    try {
      if (!f.recovery) throw new Error("Missing recovery fixture");
      const first = await f.store.beginRetired(primary, { kind: "inspect" });
      if (first.kind !== "challenge") throw new Error("Missing challenge");
      await first.complete({ kind: "recovery", code: f.recovery });
      const second = await f.store.beginRetired(primary, { kind: "inspect" });
      if (second.kind !== "challenge") throw new Error("Missing challenge");
      await expect(
        second.complete({ kind: "recovery", code: f.recovery }),
      ).rejects.toThrow();
      expect(f.held).toEqual([]);
    } finally {
      f.dispose();
    }
  });
  it("lock cancels the original challenge and drains its leases", async () => {
    const f = await retiredOwnerFixture(true);
    try {
      const started = await f.store.beginRetired(primary, { kind: "inspect" });
      if (started.kind !== "challenge") throw new Error("Missing challenge");
      f.store.lock();
      await started.cancel();
      expect(f.held).toEqual([]);
      await expect(
        started.complete({ kind: "totp", code: "123456" }),
      ).rejects.toThrow();
    } finally {
      f.dispose();
    }
  });
});

it("refuses substituted delivered reader methods and drains original resources", async () => {
  const f = await retiredOwnerFixture(true);
  try {
    const started = await f.store.beginRetired(primary, { kind: "inspect" });
    if (started.kind !== "challenge") throw new Error("Missing challenge");
    const reader = f.deviceReader();
    if (!reader) throw new Error("Missing delivered device source");
    let maliciousCalls = 0;
    Object.defineProperty(reader, "read", {
      value: async () => {
        maliciousCalls++;
        return null;
      },
    });
    await expect(
      started.complete({
        kind: "totp",
        code: await totpCode(parseTotp(OWNER_TOTP)),
      }),
    ).rejects.toThrow();
    expect(maliciousCalls).toBe(0);
    expect(f.held).toEqual([]);
    expect(f.closed()).toBe(3);
    expect(f.records.size).toBe(0);
  } finally {
    f.dispose();
  }
});
