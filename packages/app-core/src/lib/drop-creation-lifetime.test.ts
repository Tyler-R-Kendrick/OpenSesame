/** Drop creation retains the real realm that supplied its payload. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requiresFreshOwnerAuthentication } from "./decoy-session.js";
import { deviceIdentityOrigin } from "./device-identity.js";
import {
  clearSession,
  currentSession,
  identityBase,
  identitySeams,
  isDeviceIdentityMode,
  restoreSession,
} from "./identity.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "./retired-credentials/test-support.js";
import { unlockWithRetiredCredentialGate } from "./retired-credentials/unlock.js";
import {
  createDrop,
  createDropSession,
  dropSeams,
  openDrop,
  sealDrop,
  shareOnce,
} from "./vault/drop.js";

const TEXT = "generated original drop payload";
const TOKEN = "generated lifetime bearer";
const RETIRED = "generated drop lifetime retired credential";
const originalIdentity = { ...identitySeams };
const originalDrop = { ...dropSeams };
const releases: (() => void)[] = [];
const drains: Promise<unknown>[] = [];
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;

function bindFrontendSession() {
  // Generated frontend context + HTTP port double, not server-authentication proof.
  restoreSession({
    principalId: "prn_generated",
    accessToken: "generated transport context",
    issuerOrigin: isDeviceIdentityMode()
      ? deviceIdentityOrigin()
      : new URL(identityBase()).origin,
  });
  expect(currentSession()).not.toBeNull();
}

beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  await fixture.enroll(RETIRED, "synthetic_decoy");
  bindFrontendSession();
  dropSeams.claimBase = () => "https://generated.example.invalid/OpenSesame";
});
afterEach(async () => {
  try {
    for (const release of releases.splice(0)) release();
    await Promise.allSettled(drains.splice(0));
    fixture.store.lock();
    await fixture.store.unlock(PASSWORD);
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "unlocked",
      decoy: false,
      guest: false,
    });
  } finally {
    try {
      clearSession();
    } finally {
      try {
        fixture.restore();
      } finally {
        Object.assign(identitySeams, originalIdentity);
        Object.assign(dropSeams, originalDrop);
        vi.restoreAllMocks();
      }
    }
  }
});

async function transition(mode: "synthetic" | "pending" | "fresh") {
  fixture.store.lock();
  await expect(
    unlockWithRetiredCredentialGate(fixture.store, RETIRED),
  ).resolves.toBe("retired_credential_session");
  expect(fixture.store.getSnapshot().decoy).toBe(true);
  if (mode === "synthetic") return;
  fixture.store.lock();
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  if (mode === "pending") return;
  await fixture.store.unlock(PASSWORD);
  expect(fixture.store.getSnapshot()).toMatchObject({
    status: "unlocked",
    decoy: false,
    guest: false,
  });
  bindFrontendSession();
}

function holdActualDropEncryption() {
  let reached = false;
  let intercepted = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
    const ciphertext = await encrypt(...args);
    // Hold the first real AES result for this exact generated payload only.
    // Original-owner/trap/recovery encryption proceeds without interference.
    if (!intercepted && new TextDecoder().decode(args[2]) === TEXT) {
      intercepted = true;
      reached = true;
      await held;
    }
    return ciphertext;
  });
  return { reached: () => reached, release };
}

function generatedClaim() {
  return {
    claimId: "claim_generated",
    claimToken: TOKEN,
    userCode: "generated code",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}
function installClaimHttp() {
  let manifest: BoundaryValue = null;
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    // A real JSON request and native Response; HTTP authentication is a double.
    manifest = JSON.parse(String(init?.body)).targetManifest;
    return Response.json(generatedClaim());
  });
  identitySeams.identityFetch = fetch;
  return { fetch, manifest: () => manifest };
}
function observe<T>(pending: Promise<T>) {
  const observed = pending.then(
    (value) => ({ ok: true as const, value }),
    (error: Error) => ({
      ok: false as const,
      blocked: /authenticate again/.test(error.message),
    }),
  );
  drains.push(observed);
  return observed;
}
const calls: { name: string; call: () => Promise<{ link: string }> }[] = [
  {
    name: "one-time share",
    call: () => shareOnce({ name: "Generated", text: TEXT, ttlMs: 60_000 }),
  },
  {
    name: "kept-copy drop",
    call: () =>
      createDrop({
        name: "Generated",
        payload: { kind: "text", name: "Generated", text: TEXT },
        ttlMs: 60_000,
        keepCopy: true,
      }),
  },
];
for (const scenario of calls) {
  it.each(["synthetic", "pending", "fresh"] as const)(
    `does not mint an old ${scenario.name} payload after its AES result crosses %s`,
    async (mode) => {
      const body = holdActualDropEncryption();
      const http = installClaimHttp();
      const pending = observe(scenario.call());
      try {
        await vi.waitFor(() => expect(body.reached()).toBe(true), {
          timeout: 1000,
          interval: 10,
        });
        expect(http.fetch).not.toHaveBeenCalled();
        await transition(mode);
      } finally {
        body.release();
      }
      const result = await pending;
      expect(
        result.ok ? "accepted" : result.blocked ? "blocked" : "error",
      ).toBe("blocked");
      expect(http.fetch).not.toHaveBeenCalled();
    },
  );
  it(`creates and genuinely decrypts a fresh-owner ${scenario.name}`, async () => {
    await transition("fresh");
    const body = holdActualDropEncryption();
    const http = installClaimHttp();
    const pending = observe(scenario.call());
    try {
      await vi.waitFor(() => expect(body.reached()).toBe(true), {
        timeout: 1000,
        interval: 10,
      });
    } finally {
      body.release();
    }
    const result = await pending;
    expect(result.ok ? "accepted" : result.blocked ? "blocked" : "error").toBe(
      "accepted",
    );
    if (!result.ok) return;
    const fragment = new URLSearchParams(
      new URL(result.value.link).hash.slice(1),
    );
    expect(fragment.get("token") === TOKEN).toBe(true);
    const key = fragment.get("key");
    expect(key?.length).toBe(43);
    expect(http.fetch).toHaveBeenCalledOnce();
    expect(http.fetch).toHaveBeenCalledWith("/v1/claims", expect.any(Object));
    expect(await openDrop(http.manifest(), key ?? "")).toEqual({
      kind: "text",
      name: "Generated",
      text: TEXT,
    });
  });
}

// Public supplied-transport compatibility control, not a claimed production
// replacement of the default Identity transport or server-authentication proof.
it("withholds a held supplied claim port after original-owner replacement", async () => {
  const sealed = await sealDrop({
    kind: "text",
    name: "Generated",
    text: TEXT,
  });
  let reached = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  dropSeams.createClaim = async () => {
    reached = true;
    await held;
    return {
      claimId: "claim_generated",
      bearerToken: TOKEN,
      userCode: "generated code",
      verifyUrl: "https://generated.example.invalid/OpenSesame/",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  };
  const pending = observe(createDropSession(sealed.manifest, 60_000));
  try {
    await vi.waitFor(() => expect(reached).toBe(true), {
      timeout: 1000,
      interval: 10,
    });
    await transition("fresh");
  } finally {
    release();
  }
  const result = await pending;
  expect(result.ok ? "accepted" : result.blocked ? "blocked" : "error").toBe(
    "blocked",
  );
});

it("accepts a supplied claim port for a genuinely fresh owner request", async () => {
  await transition("fresh");
  const sealed = await sealDrop({
    kind: "text",
    name: "Generated",
    text: TEXT,
  });
  dropSeams.createClaim = async () => ({
    claimId: "claim_generated",
    bearerToken: TOKEN,
    userCode: "generated code",
    verifyUrl: "https://generated.example.invalid/OpenSesame/",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const result = await createDropSession(sealed.manifest, 60_000);
  expect(result.bearerToken === TOKEN).toBe(true);
  expect(await openDrop(sealed.manifest, sealed.fragmentKey)).toEqual({
    kind: "text",
    name: "Generated",
    text: TEXT,
  });
});
