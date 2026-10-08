/** Credential results belong to the real realm that began their request. */
import { afterEach, beforeEach, expect, vi } from "vitest";
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

const RETIRED = "generated held-response retired credential";
const original = { ...identitySeams };
const releases: (() => void)[] = [];
const drains: Promise<unknown>[] = [];
export let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;

function bindFrontendSession(): void {
  const issuerOrigin = isDeviceIdentityMode()
    ? deviceIdentityOrigin()
    : new URL(identityBase()).origin;
  // Generated frontend context only. HTTP is a port double; this does not
  // claim a server-side bearer/authentication proof. Vault/root crypto is real.
  restoreSession({
    principalId: "prn_generated",
    accessToken: "generated transport context",
    issuerOrigin,
  });
  expect(currentSession()).not.toBeNull();
}

beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  await fixture.enroll(RETIRED, "synthetic_decoy");
  bindFrontendSession();
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
        Object.assign(identitySeams, original);
        vi.restoreAllMocks();
      }
    }
  }
});

export function heldResponse(json: string, status = 200) {
  let read = false;
  let emitted = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(next) {
        controller = next;
      },
      pull() {
        read = true;
      },
    },
    // No eager prefetch: this barrier proves the public consumer asked the
    // real Response.json() to read its body, after fetch headers completed.
    { highWaterMark: 0 },
  );
  const release = () => {
    if (emitted || !controller) return;
    emitted = true;
    controller.enqueue(new TextEncoder().encode(json));
    controller.close();
  };
  releases.push(release);
  return {
    response: new Response(stream, { status }),
    readStarted: () => read,
    release,
  };
}

export async function transition(mode: "synthetic" | "pending" | "fresh") {
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
}

export function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
export function observe<T>(promise: Promise<T>) {
  const pending = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  drains.push(pending);
  return pending;
}
export { PASSWORD };
