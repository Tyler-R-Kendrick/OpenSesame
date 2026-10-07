import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { expect, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { defaultCapabilityConnectors } from "../capabilities.js";
import {
  assertNotDecoySession,
  requiresFreshOwnerAuthentication,
} from "../decoy-session.js";
import { resetDeviceIdentitySessionsForTests } from "../device-identity-host.js";
import { identityPlaneRequest } from "../device-identity.js";
import { clearActivePresentation } from "../duress/compartment/presentation-runtime.js";
import { makeOpfs } from "../duress/wipe/fake-opfs.test-support.js";
import { kvFileName, kvFlush, kvGet, kvRefresh } from "../kv.js";
import { retiredCredentialStorageSeams } from "../retired-credentials/index.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import { unlockWithRetiredCredentialGate } from "../retired-credentials/unlock.js";
import { loadSettings, saveSettings } from "../settings.js";
import { sealDrop } from "./drop.js";
import {
  localDropClaimSeams,
  resetLocalDropClaimsForTests,
} from "./local-drop-claims.js";

export const STORE_KEY = "opensesame.local-drop-claims.v1";
const RETIRED = "selected old claim-owner password";
export type WireClaim = {
  claimId: string;
  claimToken: string;
  userCode: string;
};

async function beginClaimFixture() {
  await kvFlush();
  const settings = loadSettings();
  const originalBase = localDropClaimSeams.claimBase;
  const root = makeOpfs();
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => root },
    locks: webLocksDouble(),
  });
  configureHost(createTestHost());
  const fixture = await createRetiredCredentialFixture();
  // The shared fixture binds its owner predicate to this actual unlocked store.
  // Retain the production bounded refresher over the in-memory OPFS API double.
  retiredCredentialStorageSeams.refresh = kvRefresh;
  saveSettings({
    hostApi: "",
    identityApi: "",
    daemonApi: "",
    capabilityConnectors: defaultCapabilityConnectors(),
  });
  resetDeviceIdentitySessionsForTests();
  resetLocalDropClaimsForTests();
  localDropClaimSeams.claimBase = () => "https://claims.example.test";
  await kvFlush();
  await fixture.enroll(RETIRED, "synthetic_decoy");
  return { fixture, root, settings, originalBase };
}

function claimLifecycle(
  context: Awaited<ReturnType<typeof beginClaimFixture>>,
) {
  const { fixture, settings, originalBase } = context;
  return {
    async synthetic() {
      fixture.store.lock();
      await expect(
        unlockWithRetiredCredentialGate(fixture.store, RETIRED),
      ).resolves.toBe("retired_credential_session");
      expect(fixture.store.getSnapshot()).toMatchObject({
        status: "unlocked",
        guest: true,
        decoy: true,
      });
      expect(() => assertNotDecoySession()).toThrow(/authenticate again/);
    },
    async freshOwner() {
      fixture.store.lock();
      expect(requiresFreshOwnerAuthentication()).toBe(true);
      await fixture.store.unlock(PASSWORD);
      expect(requiresFreshOwnerAuthentication()).toBe(false);
      expect(fixture.store.getSnapshot()).toMatchObject({
        status: "unlocked",
        guest: false,
        decoy: false,
      });
      assertNotDecoySession();
    },
    async restore() {
      vi.restoreAllMocks();
      clearActivePresentation();
      fixture.restore();
      resetDeviceIdentitySessionsForTests();
      resetLocalDropClaimsForTests();
      localDropClaimSeams.claimBase = originalBase;
      saveSettings(settings);
      await kvFlush();
      vi.unstubAllGlobals();
      configureHost(createTestHost());
    },
  };
}

/** Production KV/encryption over an in-memory OPFS API double; real owner proof. */
export async function createClaimAuthorityFixture() {
  const context = await beginClaimFixture();
  const { fixture, root } = context;
  const sealed = await sealDrop({
    kind: "text",
    name: "Owner drop",
    text: "owner claim payload",
  });
  const minted = await identityPlaneRequest("/v1/principals/provisional", {
    method: "POST",
    body: "{}",
  });
  expect(minted.status).toBe(201);
  const session = overlapCast(await minted.json());
  const headers = {
    authorization: `Bearer ${requiredClaimString(session, "accessToken")}`,
  };
  const create = () =>
    identityPlaneRequest("/v1/claims", {
      method: "POST",
      headers,
      body: JSON.stringify({
        targetManifest: sealed.manifest,
        ttlSeconds: 600,
      }),
    });
  const created = await create();
  expect(created.status).toBe(201);
  const rawClaim = overlapCast(await created.json());
  const claim: WireClaim = {
    claimId: requiredClaimString(rawClaim, "claimId"),
    claimToken: requiredClaimString(rawClaim, "claimToken"),
    userCode: requiredClaimString(rawClaim, "userCode"),
  };
  await kvFlush();
  expect(root.files.get(kvFileName(STORE_KEY))).toBeTruthy();
  expect(root.files.get(kvFileName(STORE_KEY))).not.toContain(claim.claimToken);
  const poll = () =>
    identityPlaneRequest(
      `/v1/claims/${encodeURIComponent(claim.claimId)}/poll`,
      {
        headers: { "x-claim-token": claim.claimToken },
      },
    );
  const present = (code = claim.userCode) =>
    identityPlaneRequest("/v1/claims/present", {
      method: "POST",
      body: JSON.stringify({ token: claim.claimToken, userCode: code }),
    });
  return {
    ...claimLifecycle(context),
    fixture,
    root,
    claim,
    sealed,
    create,
    poll,
    present,
    async state() {
      await kvFlush();
      return {
        memory: kvGet(STORE_KEY),
        sealed: root.files.get(kvFileName(STORE_KEY)),
      };
    },
  };
}

/** Hold a genuine completed WebCrypto result, never substitute a digest/verdict. */
export function holdClaimDigest(kind: "token" | "code") {
  let started = () => {};
  let release = () => {};
  let held = false;
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(async (algorithm, data) => {
      const actual = await original(algorithm, data);
      const parts = new TextDecoder().decode(data).split("\0");
      if (
        !held &&
        parts[1] === kind &&
        parts[2]?.startsWith(kind === "token" ? "osc_clm_" : "clm_")
      ) {
        held = true;
        started();
        await blocked;
      }
      return actual;
    });
  return { reached, release, restore: () => spy.mockRestore() };
}

export async function claimBody(response: Response): Promise<JsonObject> {
  return overlapCast(await response.json());
}

function requiredClaimString(body: JsonObject, name: string): string {
  const value = body[name];
  if (!isString(value) || value.length === 0)
    throw new Error(`Expected nonempty claim response field ${name}`);
  return value;
}
