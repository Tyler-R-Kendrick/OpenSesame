import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { kvGet } from "./kv.js";
import { clearStagedClaimTokens, enqueue } from "./queue.js";
import { createVault } from "./vault/crypto.js";
import { MIN_PIN_LENGTH, wrapVaultKeyWithPin } from "./vault/unlock-methods.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — Pages vault / queue / authz", () => {
  it("vault key import is non-extractable; PIN floor is enforced", async () => {
    assertSourceOrder(readFileSync(join(here, "vault/crypto.ts"), "utf8"), [
      'importKey("raw"',
      "false",
      '"encrypt"',
    ]);
    const { vaultKey } = await createVault("correct horse battery staple");
    expect(vaultKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", vaultKey)).rejects.toThrow();

    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    await expect(wrapVaultKeyWithPin(raw, "123")).rejects.toThrow(
      /PIN must be/,
    );
    expect(MIN_PIN_LENGTH).toBeGreaterThanOrEqual(8);
    raw.fill(0);
  });

  it("claim tokens never reach durable queue storage", () => {
    assertSourceOrder(readFileSync(join(here, "queue.ts"), "utf8"), [
      'item.kind === "claim_complete"',
      "stagedClaims",
      "saveDeviceActions",
    ]);
    clearStagedClaimTokens();
    enqueue({
      kind: "claim_complete",
      userCode: "WORD-WORD",
      claimToken: "osc_clm_pact.secret",
    });
    expect(kvGet("outbox.v1") ?? "[]").not.toContain("secret");
    clearStagedClaimTokens();
  });

  it("auth.js origin-binds postMessage and checks iss then aud", () => {
    const src = readFileSync(join(here, "../../public/auth.js"), "utf8");
    assertSourceOrder(src, [
      "event.origin !== brokerOrigin",
      "claims.iss",
      "claims.aud",
    ]);
  });

  it("passkey host repair survives the cross-origin localhost hop", () => {
    const src = readFileSync(
      join(here, "../sections/settings/UnlockMethodsPanel.tsx"),
      "utf8",
    );
    expect(src).toContain('searchParams.set(ENROLL_PASSKEY_PARAM, "1")');
    expect(src).toContain("window.location.assign(url)");
    expect(src).not.toContain("sessionStorage");
  });

  it("contract: TaskBus Host responses parse strictly and reject secrets", async () => {
    const { GetTaskBusResponseSchema } = await import("@opensesame/contracts");
    const parsed = GetTaskBusResponseSchema.parse({
      taskbus: {
        backend: "nats",
        nats_url: "nats://127.0.0.1:4222",
        source: "stored",
        status: "ok",
        last_error: null,
      },
    });
    expect(parsed.taskbus.backend).toBe("nats");
    expect(
      GetTaskBusResponseSchema.safeParse({
        taskbus: { ...parsed.taskbus, access_token: "leak" },
      }).success,
    ).toBe(false);
  });
});
