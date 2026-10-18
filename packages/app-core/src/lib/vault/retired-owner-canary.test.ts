/** Private Store issuance, real primary/factor crypto and paired P-256 custody. */
import { parseTotp, totpCode } from "@opensesame/vault-core";
import { expect, it } from "vitest";
import {
  OWNER_PASSWORD,
  OWNER_TOTP,
  retiredOwnerFixture,
} from "./retired-owner.fixture.js";
const receiver = {
  endpoint: "http://127.0.0.1:18791",
  bindPort: 18791,
  serviceId: "a".repeat(64),
  browserOrigin: "https://owner.example",
};
const pairing = { receiver, action: { kind: "pairing" as const } };
it("issues canary pairing only after fresh primary and registers exact result membership", async () => {
  const f = await retiredOwnerFixture();
  try {
    await expect(
      f.store.beginCanary({ kind: "password", secret: "wrong" }, pairing),
    ).rejects.toThrow();
    expect(f.records.size).toBe(0);
    const result = await f.store.beginCanary(
      { kind: "password", secret: OWNER_PASSWORD },
      pairing,
    );
    if (result.kind !== "complete" || result.result.kind !== "pairing")
      throw new Error("Genuine owner pairing missing.");
    expect(result.result.pairing.ownerPublicJwk.kty).toBe("EC");
    expect(f.store.isCanaryResultCurrent(result.result)).toBe(true);
    expect(f.store.isCanaryResultCurrent({ ...result.result })).toBe(false);
    expect(f.store.getSnapshot().status).toBe("locked");
    expect(f.held).toEqual([]);
    f.store.lock();
    expect(f.store.isCanaryResultCurrent(result.result)).toBe(false);
  } finally {
    f.dispose();
  }
});
it("configured factor challenge gates canary custody creation", async () => {
  const f = await retiredOwnerFixture(true);
  try {
    const started = await f.store.beginCanary(
      { kind: "password", secret: OWNER_PASSWORD },
      pairing,
    );
    if (started.kind !== "challenge")
      throw new Error("Configured canary challenge missing.");
    expect(f.records.size).toBe(0);
    const result = await started.complete({
      kind: "totp",
      code: await totpCode(parseTotp(OWNER_TOTP)),
    });
    expect(result.kind).toBe("pairing");
    expect(f.held).toEqual([]);
    expect(f.records.size).toBe(1);
  } finally {
    f.dispose();
  }
});
