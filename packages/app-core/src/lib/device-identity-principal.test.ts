/**
 * The key-backed device principal (ADR 0160): who a device session is, what
 * it may prove, and what it does while the vault is shut or another opens.
 */

/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  deviceIdentityFetch,
  resetDeviceIdentitySessionsForTests,
} from "./device-identity-host.js";
import { ensureDeviceIdentityKey } from "./device-identity-key.js";
import {
  type DeviceRouteRequest,
  registerDeviceRoutes,
  resetDeviceRoutesForTests,
} from "./device-identity-routes.js";
import {
  type DeviceVaultView,
  deviceVaultSeams,
} from "./device-identity-vault.js";
import { saveSettings } from "./settings.js";
import { lockTomb, unlockTomb } from "./vfs.js";

const realView = deviceVaultSeams.view;
let view: DeviceVaultView = { kind: "none" };

async function open(guest = false): Promise<string> {
  const tomb = `device-principal-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  view = { kind: "unlocked", tomb, guest };
  return tomb;
}

async function mint(): Promise<Response> {
  return deviceIdentityFetch("/v1/principals/provisional", {
    method: "POST",
    body: "{}",
  });
}

async function me(token: string): Promise<Response> {
  return deviceIdentityFetch("/v1/principals/me", {
    headers: { authorization: `Bearer ${token}` },
  });
}

type MintedSession = { principalId: string; accessToken: string };

async function session(): Promise<MintedSession> {
  const res = await mint();
  expect(res.status).toBe(201);
  const body = overlapCast(await res.json());
  return {
    principalId: String(body.principalId),
    accessToken: String(body.accessToken),
  };
}

beforeEach(() => {
  saveSettings({
    hostApi: "",
    identityApi: "",
    daemonApi: "",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
  view = { kind: "none" };
  deviceVaultSeams.view = () => view;
  resetDeviceIdentitySessionsForTests();
  resetDeviceRoutesForTests();
});

afterEach(() => {
  deviceVaultSeams.view = realView;
  resetDeviceIdentitySessionsForTests();
  resetDeviceRoutesForTests();
});

describe("with no vault on the device", () => {
  it("mints a random provisional principal, bound to nothing", async () => {
    const first = await session();
    const second = await session();
    expect(first.principalId).toMatch(/^prn_/);
    expect(first.principalId).not.toBe(second.principalId);
    const principal = overlapCast(await (await me(first.accessToken)).json());
    expect(principal).toMatchObject({
      id: first.principalId,
      state: "provisional",
      assurance: "provisional",
      identities: [],
    });
  });

  it("keeps an unbound session across a vault opening afterwards", async () => {
    const early = await session();
    await open(true);
    expect((await me(early.accessToken)).status).toBe(200);
  });
});

describe("with an unlocked member vault", () => {
  it("makes the principal the thumbprint of the vault's identity key", async () => {
    const tomb = await open();
    const key = await ensureDeviceIdentityKey(tomb);
    const minted = await session();
    expect(minted.principalId).toBe(key.principalId);
    const principal = overlapCast(await (await me(minted.accessToken)).json());
    expect(principal).toMatchObject({
      id: key.principalId,
      state: "active",
      assurance: "provisional",
    });
  });

  it("gives every session in the vault the same principal and its own bearer", async () => {
    await open();
    const a = await session();
    const b = await session();
    expect(a.principalId).toBe(b.principalId);
    expect(a.accessToken).not.toBe(b.accessToken);
  });

  it("keeps the bearer out of anything it stores", async () => {
    const tomb = await open();
    const minted = await session();
    const { readFile } = await import("./vfs.js");
    const stored = new TextDecoder().decode(
      await readFile(tomb, "config/device-identity-key"),
    );
    expect(stored).not.toContain(minted.accessToken);
  });

  it("creates the key on first use, in this vault only", async () => {
    const a = await open();
    const first = await session();
    const b = await open();
    const second = await session();
    expect(first.principalId).not.toBe(second.principalId);
    expect(first.principalId).toBe(
      (await ensureDeviceIdentityKey(a)).principalId,
    );
    expect(second.principalId).toBe(
      (await ensureDeviceIdentityKey(b)).principalId,
    );
  });
});

describe("with a guest vault", () => {
  it("keeps a provisional principal, in the guest tomb", async () => {
    const tomb = await open(true);
    const minted = await session();
    expect(minted.principalId).toBe(
      (await ensureDeviceIdentityKey(tomb)).principalId,
    );
    const principal = overlapCast(await (await me(minted.accessToken)).json());
    expect(principal).toMatchObject({
      state: "provisional",
      assurance: "provisional",
    });
  });

  it("is never raised by a proof that is about a member's vault", async () => {
    await open(true);
    registerDeviceRoutes({
      id: "vouch",
      serves: [],
      dispatch: async () => null,
      assurance: async () => ({ level: "phishing_resistant", verifiedAt: 5 }),
    });
    const minted = await session();
    const principal = overlapCast(await (await me(minted.accessToken)).json());
    expect(principal.assurance).toBe("provisional");
    expect(principal.verifiedAt).toBeUndefined();
  });
});

describe("assurance", () => {
  it("rises only on a proof a capability gives, with the time it was given", async () => {
    const tomb = await open();
    const seen: string[] = [];
    registerDeviceRoutes({
      id: "vouch",
      serves: [],
      dispatch: async () => null,
      assurance: async (asked) => {
        seen.push(asked);
        return { level: "phishing_resistant", verifiedAt: 1_700_000_000_000 };
      },
    });
    const minted = await session();
    const principal = overlapCast(await (await me(minted.accessToken)).json());
    expect(principal).toMatchObject({
      assurance: "phishing_resistant",
      verifiedAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(seen).toEqual([tomb]);
  });

  it("is provisional with no proof, however the vault was opened", async () => {
    await open();
    const minted = await session();
    const principal = overlapCast(await (await me(minted.accessToken)).json());
    expect(principal.assurance).toBe("provisional");
  });
});

describe("with a locked vault", () => {
  it("issues nothing and says locked", async () => {
    view = { kind: "locked" };
    const res = await mint();
    expect(res.status).toBe(423);
    expect(overlapCast(await res.json()).error).toBe("locked");
  });

  it("answers a bound session locked until the same vault opens again", async () => {
    const tomb = await open();
    const minted = await session();
    lockTomb(tomb);
    view = { kind: "locked" };
    const locked = await me(minted.accessToken);
    expect(locked.status).toBe(423);
    expect(overlapCast(await locked.json()).error).toBe("locked");
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    view = { kind: "unlocked", tomb, guest: false };
    expect((await me(minted.accessToken)).status).toBe(200);
  });

  it("ends a bound session when a different vault opens", async () => {
    await open();
    const minted = await session();
    await open();
    expect((await me(minted.accessToken)).status).toBe(401);
    view = { kind: "none" };
    expect((await me(minted.accessToken)).status).toBe(401);
  });

  it("refuses a claim to a bound session while its vault is shut", async () => {
    await open();
    const minted = await session();
    view = { kind: "locked" };
    const res = await deviceIdentityFetch("/v1/claims", {
      method: "POST",
      headers: { authorization: `Bearer ${minted.accessToken}` },
      body: JSON.stringify({ targetManifest: { kind: "drop" } }),
    });
    expect(res.status).toBe(423);
  });

  it("answers every capability route locked, with no fallback", async () => {
    let asked = 0;
    registerDeviceRoutes({
      id: "dir",
      serves: ["directory"],
      dispatch: async () => {
        asked += 1;
        return new Response("{}");
      },
    });
    view = { kind: "locked" };
    const res = await deviceIdentityFetch("/v1/projects");
    expect(res.status).toBe(423);
    expect(asked).toBe(0);
  });

  it("answers locked, not a random principal, when the tomb holds no key", async () => {
    // The view says open but the tomb never received its key: a plaintext
    // fallback would be a principal that is not the vault's.
    view = { kind: "unlocked", tomb: "never-unlocked", guest: false };
    const res = await mint();
    expect(res.status).toBe(423);
    expect(overlapCast(await res.json()).error).toBe("locked");
  });

  it("answers 503, not a random principal, when the stored key is corrupt", async () => {
    const tomb = await open();
    const { writeFile } = await import("./vfs.js");
    await writeFile(
      tomb,
      "config/device-identity-key",
      new TextEncoder().encode("{}"),
    );
    const res = await mint();
    expect(res.status).toBe(503);
    expect(overlapCast(await res.json()).error).toBe("unreachable");
  });

  it("does not issue if the vault locks while the key is being read", async () => {
    const tomb = await open();
    let reads = 0;
    deviceVaultSeams.view = () => {
      reads += 1;
      return reads === 1
        ? { kind: "unlocked", tomb, guest: false }
        : { kind: "locked" };
    };
    const res = await mint();
    expect(res.status).toBe(423);
  });
});

describe("what a contribution is handed", () => {
  it("carries the caller the bearer stands for, and never the token", async () => {
    const tomb = await open();
    const minted = await session();
    const seen: DeviceRouteRequest[] = [];
    registerDeviceRoutes({
      id: "probe",
      serves: ["notifications"],
      dispatch: async (request) => {
        seen.push(request);
        return new Response("{}");
      },
    });
    await deviceIdentityFetch("/v1/notifications?x=1", {
      headers: { authorization: `Bearer ${minted.accessToken}` },
    });
    await deviceIdentityFetch("/v1/notifications");
    expect(seen[0]?.bare).toBe("/v1/notifications");
    expect(seen[0]?.caller).toEqual({
      principalId: minted.principalId,
      tomb,
      guest: false,
    });
    expect(JSON.stringify(seen[0]?.caller)).not.toContain(minted.accessToken);
    expect(seen[1]?.caller).toBeNull();
  });
});
