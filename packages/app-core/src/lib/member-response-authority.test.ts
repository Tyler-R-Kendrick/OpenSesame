import { channelCapabilities } from "@opensesame/os-domain";
/** Credential results belong to the real realm that began their request. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { approvalClient } from "./approvals.js";
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
import { interactionClient } from "./interactions.js";
import { routingClient } from "./notification-routing/transport.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "./retired-credentials/test-support.js";
import { unlockWithRetiredCredentialGate } from "./retired-credentials/unlock.js";

const RETIRED = "generated held-response retired credential";
const GENERATED = "generated request-bound response value";
const original = { ...identitySeams };
const releases: (() => void)[] = [];
const drains: Promise<unknown>[] = [];
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;

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

function heldResponse(json: string, status = 200) {
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
}

// PRIVATE UNEXECUTED draft intended for app-core/src/lib/. HTTP port fixtures
// do not prove server authentication; actual vault/retired realm crypto is real.
const REF = "i_AbCdEfGhIjKlMnOpQr.0123456789abcdef";
const ASSERTION = {
  credentialId: "generated_credential",
  clientDataJSON: "generated_client_data",
  authenticatorData: "generated_authenticator_data",
  signature: "generated_signature",
};
const CHANNELS = [
  {
    kind: "telegram" as const,
    name: "Telegram",
    configured: true,
    bindable: true,
    sentence: "",
    capabilities: channelCapabilities("telegram"),
  },
];
const cases = [
  {
    name: "notification binding nonce",
    path: "/v1/notification-channels/bindings",
    body: {
      challengeId: "generated_challenge",
      nonce: GENERATED,
      expiresAt: "2030-01-01T00:00:00.000Z",
      authorizeUrl: "https://generated.example.invalid/authorize",
    },
    call: () => routingClient().beginBinding("telegram", CHANNELS),
    expected: {
      challengeId: "generated_challenge",
      nonce: GENERATED,
      expiresAt: "2030-01-01T00:00:00.000Z",
      authorizeUrl: "https://generated.example.invalid/authorize",
    },
  },
  {
    name: "interaction request-bound activation handle",
    path: `/v1/interactions/${REF}/activation/complete`,
    body: { activationId: GENERATED, state: "activated" },
    call: () =>
      interactionClient().completeInteractionActivation(REF, {
        activationId: GENERATED,
        ...ASSERTION,
      }),
    expected: { activationId: GENERATED, state: "activated" },
  },
  {
    name: "approval request-bound activation handle",
    path: "/v1/authorization-requests/areq_generated/activation/complete",
    body: { activationId: GENERATED },
    call: () =>
      approvalClient().completeActivation(
        "areq_generated",
        GENERATED,
        ASSERTION,
      ),
    expected: GENERATED,
  },
];

for (const scenario of cases) {
  it.each(["synthetic", "pending", "fresh"] as const)(
    `withholds held ${scenario.name} after originating realm becomes %s`,
    async (mode) => {
      const body = heldResponse(JSON.stringify(scenario.body));
      const fetch = vi.fn(async () => body.response);
      identitySeams.identityFetch = fetch;
      const pending = scenario.call().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      drains.push(pending);
      try {
        await vi.waitFor(() => expect(body.readStarted()).toBe(true), {
          timeout: 1000,
          interval: 10,
        });
        expect(fetch).toHaveBeenCalledWith(scenario.path, expect.any(Object));
        await transition(mode);
      } finally {
        body.release();
      }
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error).toMatchObject({
          message: expect.stringMatching(/authenticate again/),
        });
      }
    },
  );
  it(`returns the exact current-owner ${scenario.name}`, async () => {
    identitySeams.identityFetch = vi.fn(
      async () =>
        new Response(JSON.stringify(scenario.body), {
          headers: { "content-type": "application/json" },
        }),
    );
    // Objects may contain authored display words, never remove credential equality.
    const value = await scenario.call();
    if (typeof scenario.expected === "string")
      expect(value).toBe(scenario.expected);
    else expect(value).toMatchObject(scenario.expected);
  });
  it(`dispatches no ${scenario.name} request from synthetic`, async () => {
    await transition("synthetic");
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(scenario.body)),
    );
    identitySeams.identityFetch = fetch;
    await expect(scenario.call()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
}
