/**
 * The key-backed device principal (ADR 0160): who a device session is, what
 * it may prove, and what it does while the vault is shut or another opens.
 */

/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  deviceIdentityFetch,
  resetDeviceIdentitySessionsForTests,
} from "./device-identity-host.js";
import {
  ensureDeviceIdentityKey,
  forgetDeviceIdentityKeyInFlightForTests,
} from "./device-identity-key.js";
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
import { lockTomb, readFile, unlockTomb, writeFile } from "./vfs.js";

const realView = deviceVaultSeams.view;
let view: DeviceVaultView = { kind: "none" };

/** The key each tomb was opened with, so a re-unlock is the same vault. */
const vaultKeys = new Map<string, CryptoKey>();

async function open(guest = false): Promise<string> {
  const tomb = `device-principal-${crypto.randomUUID()}`;
  const { vaultKey } = await mintVaultKey();
  vaultKeys.set(tomb, vaultKey);
  unlockTomb(tomb, vaultKey);
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
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  resetDeviceIdentitySessionsForTests();
  resetDeviceRoutesForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetDeviceIdentityKeyInFlightForTests();
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
});

describe("assurance", () => {
  it("is provisional however the vault was opened, with no time of proof", async () => {
    await open();
    const minted = await session();
    const principal = overlapCast(await (await me(minted.accessToken)).json());
    expect(principal.assurance).toBe("provisional");
    expect(principal.verifiedAt).toBeUndefined();
  });

  it("is not raised by any registered capability: a passkey session proves a local person, not this principal", async () => {
    await open();
    registerDeviceRoutes({
      id: "identity.local-iam",
      routes: { directory: async () => null },
    });
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
    const vaultKey = vaultKeys.get(tomb);
    if (!vaultKey) throw new Error("the tomb was never opened");
    unlockTomb(tomb, vaultKey);
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
      routes: {
        directory: async () => {
          asked += 1;
          return new Response("{}");
        },
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
  it("carries the caller the bearer stands for, and nothing that holds the token", async () => {
    const tomb = await open();
    const minted = await session();
    const seen: DeviceRouteRequest[] = [];
    registerDeviceRoutes({
      id: "probe",
      routes: {
        notifications: async (received) => {
          seen.push(received);
          return new Response("{}");
        },
      },
    });
    await deviceIdentityFetch("/v1/notification-preferences/effective?x=1", {
      method: "POST",
      headers: {
        authorization: `Bearer ${minted.accessToken}`,
        "x-claim-token": "claim-secret",
      },
      body: '{"a":1}',
    });
    await deviceIdentityFetch("/v1/notification-preferences/effective");
    expect(seen[0]?.bare).toBe("/v1/notification-preferences/effective");
    expect(seen[0]?.body).toBe('{"a":1}');
    expect(seen[0]?.caller).toEqual({
      principalId: minted.principalId,
      tomb,
      guest: false,
    });
    // Nothing a handler can reach holds a bearer or any other header.
    const everything = JSON.stringify(seen);
    expect(everything).not.toContain(minted.accessToken);
    expect(everything).not.toContain("claim-secret");
    expect(everything).not.toMatch(/authorization/i);
    expect(seen[0]).not.toHaveProperty("init");
    expect(seen[0]).not.toHaveProperty("headers");
    expect(seen[1]?.caller).toBeNull();
  });

  it("answers the email and text code routes itself, whoever is registered", async () => {
    registerDeviceRoutes({
      id: "identity.local-iam",
      routes: { directory: async () => new Response("{}") },
    });
    const res = await deviceIdentityFetch("/v1/mfa/code/send", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(503);
    expect(overlapCast(await res.json()).error).toBe("not_configured");
  });

  it("does not let a directory handler answer a path of another family", async () => {
    registerDeviceRoutes({
      id: "greedy",
      routes: { directory: async () => new Response("{}", { status: 200 }) },
    });
    expect((await deviceIdentityFetch("/v1/audit/events")).status).toBe(501);
    expect((await deviceIdentityFetch("/v1/wallet/registrations")).status).toBe(
      501,
    );
    expect((await deviceIdentityFetch("/v1/projects")).status).toBe(200);
  });
});

const KEY_PATH = "config/device-identity-key";

async function plant(tomb: string, bytes: string): Promise<void> {
  await writeFile(tomb, KEY_PATH, new TextEncoder().encode(bytes));
}

async function stored(tomb: string): Promise<string> {
  return new TextDecoder().decode(await readFile(tomb, KEY_PATH));
}

describe("a key record this build cannot read", () => {
  it("still opens a provisional session: random, unbound, provisional, and says why", async () => {
    const tomb = await open();
    await plant(tomb, '{"version":2,"from":"a newer build"}');
    const res = await mint();
    expect(res.status).toBe(201);
    const body = overlapCast(await res.json());
    expect(body.identityKey).toBe("unreadable");
    expect(String(body.principalId)).toMatch(/^prn_[A-Za-z0-9_-]{16}$/);
    const principal = overlapCast(
      await (await me(String(body.accessToken))).json(),
    );
    expect(principal).toMatchObject({
      id: body.principalId,
      state: "provisional",
      assurance: "provisional",
    });
    expect(principal.verifiedAt).toBeUndefined();
  });

  it("never overwrites or destroys the record", async () => {
    const tomb = await open();
    const unknown = '{"version":2,"from":"a newer build"}';
    await plant(tomb, unknown);
    await mint();
    await mint();
    expect(await stored(tomb)).toBe(unknown);
  });

  it("does not bind that session to the vault, so it is no member's principal", async () => {
    const tomb = await open();
    await plant(tomb, "not json");
    const minted = await session();
    const seen: DeviceRouteRequest[] = [];
    registerDeviceRoutes({
      id: "probe",
      routes: {
        directory: async (received) => {
          seen.push(received);
          return new Response("{}");
        },
      },
    });
    await deviceIdentityFetch("/v1/projects", {
      headers: { authorization: `Bearer ${minted.accessToken}` },
    });
    expect(seen[0]?.caller).toEqual({
      principalId: minted.principalId,
      tomb: "",
      guest: false,
    });
  });
});

describe("with no cross-tab lock", () => {
  it("opens a provisional session and mints no key", async () => {
    const tomb = await open();
    vi.stubGlobal("navigator", {});
    const res = await mint();
    expect(res.status).toBe(201);
    const body = overlapCast(await res.json());
    expect(body.identityKey).toBe("no-fence");
    expect(String(body.principalId)).toMatch(/^prn_[A-Za-z0-9_-]{16}$/);
    await expect(readFile(tomb, KEY_PATH)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("binds to a key that already exists, with or without the lock", async () => {
    const tomb = await open();
    const key = await ensureDeviceIdentityKey(tomb);
    forgetDeviceIdentityKeyInFlightForTests();
    vi.stubGlobal("navigator", {});
    expect((await session()).principalId).toBe(key.principalId);
  });
});

describe("a tomb whose key changed under a live bearer", () => {
  async function replaceKey(tomb: string): Promise<void> {
    const other = await open();
    await ensureDeviceIdentityKey(other);
    await plant(tomb, await stored(other));
    view = {
      kind: "unlocked",
      tomb,
      guest: view.kind === "unlocked" && view.guest,
    };
  }

  it("ends the bearer when a same-named tomb holds another key", async () => {
    const tomb = await open(true);
    const minted = await session();
    expect((await me(minted.accessToken)).status).toBe(200);
    await replaceKey(tomb);
    const res = await me(minted.accessToken);
    expect(res.status).toBe(401);
    // Gone, not merely refused once: the old principal does not come back.
    expect((await me(minted.accessToken)).status).toBe(401);
  });

  it("refuses a claim, and a capability call is handed no caller", async () => {
    const tomb = await open();
    const minted = await session();
    await replaceKey(tomb);
    const claim = await deviceIdentityFetch("/v1/claims", {
      method: "POST",
      headers: { authorization: `Bearer ${minted.accessToken}` },
      body: JSON.stringify({ targetManifest: { kind: "drop" } }),
    });
    expect(claim.status).toBe(401);
  });

  it("fails closed when the key can no longer be read", async () => {
    const tomb = await open();
    const minted = await session();
    await plant(tomb, "garbage");
    expect((await me(minted.accessToken)).status).toBe(401);
  });

  it("keeps the bearer while the same key is in place", async () => {
    await open();
    const minted = await session();
    expect((await me(minted.accessToken)).status).toBe(200);
    expect((await me(minted.accessToken)).status).toBe(200);
  });
});

describe("claims while a vault is shut", () => {
  const claimBody = JSON.stringify({ targetManifest: { kind: "drop" } });

  it("refuses create, poll and present for a session minted before any vault existed", async () => {
    const early = await session();
    await open();
    view = { kind: "locked" };
    const create = await deviceIdentityFetch("/v1/claims", {
      method: "POST",
      headers: { authorization: `Bearer ${early.accessToken}` },
      body: claimBody,
    });
    expect(create.status).toBe(423);
    expect(overlapCast(await create.json()).error).toBe("locked");
    const poll = await deviceIdentityFetch("/v1/claims/c1/poll", {
      headers: { "x-claim-token": "t" },
    });
    expect(poll.status).toBe(423);
    const present = await deviceIdentityFetch("/v1/claims/present", {
      method: "POST",
      body: JSON.stringify({ token: "t", userCode: "u" }),
    });
    expect(present.status).toBe(423);
  });

  it("still creates a claim for that same session once the vault is open", async () => {
    const early = await session();
    const tomb = await open();
    const create = await deviceIdentityFetch("/v1/claims", {
      method: "POST",
      headers: { authorization: `Bearer ${early.accessToken}` },
      body: claimBody,
    });
    expect(create.status).toBe(201);
    expect(tomb).toBeTruthy();
  });

  it("leaves health and revoke working while locked", async () => {
    const early = await session();
    view = { kind: "locked" };
    expect((await deviceIdentityFetch("/v1/health/live")).status).toBe(200);
    const revoked = await deviceIdentityFetch(
      "/v1/principals/provisional/revoke",
      {
        method: "POST",
        headers: { authorization: `Bearer ${early.accessToken}` },
      },
    );
    expect(revoked.status).toBe(200);
  });
});
