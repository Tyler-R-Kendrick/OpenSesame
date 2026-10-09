import { RunnerApiError } from "@opensesame/api-client";
import { describe, expect, it } from "vitest";
import { createRunnerService } from "./service";
import { rig } from "./test-support/rig";
import { RP } from "./test-support/site";

async function service(options?: Parameters<typeof rig>[0]) {
  const r = await rig({ armed: false, ...options });
  const svc = createRunnerService({
    settings: r.settings,
    vault: r.vault,
    grants: {
      has: async (o) => r.granted.has(o),
      revoke: async (o) => void r.granted.delete(o),
      privateAllowed: async () => r.browser.privateAllowed,
    },
    pagesFor: async () => null,
    closePage: async () => undefined,
    connect: async () => null,
  });
  return { r, svc };
}

describe("arming", () => {
  it("needs the browser's grant already held: a message cannot make the browser grant anything", async () => {
    const { r, svc } = await service({ grant: false });
    expect(await svc.arm(RP)).toBe("no_grant");
    expect(await r.settings.isArmed(RP)).toBe(false);
    r.granted.add(RP);
    expect(await svc.arm(RP)).toBe("armed");
    expect(await r.settings.isArmed(RP)).toBe(true);
  });

  it("refuses an origin the runner would not drive", async () => {
    const { r, svc } = await service();
    for (const origin of [
      "http://rp.example",
      "javascript:1",
      "",
      "https://rp.example/x",
    ]) {
      expect(await svc.arm(origin), origin).toBe("origin_refused");
    }
    expect((await r.settings.armed()).size).toBe(0);
  });

  it("an arm is bounded, and disarming gives the grant back", async () => {
    const { r, svc } = await service();
    await svc.arm(RP);
    const armed = (await r.settings.armed()).get(RP);
    expect((armed?.expiresAt ?? 0) - (armed?.armedAt ?? 0)).toBe(
      30 * 60 * 1000,
    );
    await svc.disarm(RP);
    expect(await r.settings.isArmed(RP)).toBe(false);
    expect(r.granted.has(RP)).toBe(false);
  });
});

describe("status", () => {
  it("says what is ready and names no value", async () => {
    const { r, svc } = await service();
    await svc.arm(RP);
    await r.vault.generate(
      { runId: "run:1", origin: RP },
      `candidate:${crypto.randomUUID()}`,
    );
    const status = await svc.status();
    expect(status).toMatchObject({
      session: true,
      privateAllowed: true,
      recovery: true,
      credentials: [RP],
      active: [],
    });
    expect(status.armed).toEqual([
      { origin: RP, expiresAt: expect.any(Number), granted: true },
    ]);
    expect(status.candidates).toHaveLength(1);
    const text = JSON.stringify(status);
    for (const secret of [
      "correct horse battery staple",
      "host-session-token",
    ]) {
      expect(text).not.toContain(secret);
    }
    for (const secret of await r.vault.secrets({
      runId: "run:1",
      origin: RP,
    })) {
      expect(text).not.toContain(secret);
    }
  });

  it("says so when the browser took a grant back", async () => {
    const { r, svc } = await service();
    await svc.arm(RP);
    r.granted.delete(RP);
    expect((await svc.status()).armed[0]?.granted).toBe(false);
  });

  it("says nothing is ready on a bare install", async () => {
    const { svc } = await service({
      session: false,
      credential: false,
      recovery: false,
    });
    expect(await svc.status()).toMatchObject({
      session: false,
      recovery: false,
      credentials: [],
      armed: [],
    });
  });
});

describe("the last pass", () => {
  it("says what a pass did and why it did not claim a run", async () => {
    const { r, svc } = await service({ grant: false, armed: true });
    r.host.openRun("run:1", RP);
    expect((await svc.status()).lastPass).toBeNull();
    // The grant is missing, so the pass names why and settles nothing.
    const gated = createRunnerService({
      settings: r.settings,
      vault: r.vault,
      grants: {
        has: async (o) => r.granted.has(o),
        revoke: async () => undefined,
        privateAllowed: async () => true,
      },
      pagesFor: async () => null,
      closePage: async () => undefined,
      connect: async () => ({ host: r.host, backup: r.host }),
    });
    await gated.tick();
    const pass = (await gated.status()).lastPass;
    expect(pass).toMatchObject({
      connected: true,
      driven: 0,
      settled: 0,
      skipped: ["no_grant"],
      error: null,
    });
  });

  it("names the Host's refusal, never what it said", async () => {
    const { r } = await service();
    const refusing = createRunnerService({
      settings: r.settings,
      vault: r.vault,
      grants: {
        has: async () => true,
        revoke: async () => undefined,
        privateAllowed: async () => true,
      },
      pagesFor: async () => null,
      closePage: async () => undefined,
      connect: async () => ({
        host: {
          ...r.host,
          listRuns: async () => {
            throw new RunnerApiError("agent_runs", 401, "invalid_token");
          },
          getRun: r.host.getRun.bind(r.host),
          claim: r.host.claim.bind(r.host),
          settle: r.host.settle.bind(r.host),
        },
        backup: r.host,
      }),
    });
    await r.settings.arm(RP);
    await expect(refusing.tick()).rejects.toBeInstanceOf(RunnerApiError);
    expect((await refusing.status()).lastPass?.error).toBe("401:invalid_token");
    const down = createRunnerService({
      settings: r.settings,
      vault: r.vault,
      grants: {
        has: async () => true,
        revoke: async () => undefined,
        privateAllowed: async () => true,
      },
      pagesFor: async () => null,
      closePage: async () => undefined,
      connect: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1");
      },
    });
    await expect(down.tick()).rejects.toThrow();
    expect((await down.status()).lastPass?.error).toBe("unreachable");
  });
});
