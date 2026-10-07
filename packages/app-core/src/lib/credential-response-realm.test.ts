/** Credential results belong to the real realm that began their request. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginAccountTotp } from "./account-factors.js";
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
import { type OrgSignInOrganization, orgSignInClient } from "./org-signin.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "./retired-credentials/test-support.js";
import { unlockWithRetiredCredentialGate } from "./retired-credentials/unlock.js";
import { DropError, dropSeams, shareOnce } from "./vault/drop.js";

const RETIRED = "generated held-response retired credential";
const GENERATED = "generated response credential";
const OTP = "otpauth://totp/Generated?secret=ONSWKZA&issuer=Generated";
const original = { ...identitySeams };
const originalDrop = { ...dropSeams };
const releases: (() => void)[] = [];
const drains: Promise<unknown>[] = [];
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;

const ORG: OrgSignInOrganization = {
  id: "org_generated",
  slug: "generated",
  displayName: "Generated organization",
  role: "owner",
  owner: true,
  secretStored: false,
  upstream: {
    ssoIssuer: "",
    ssoClientId: "",
    ssoClientSecret: "",
    samlIssuer: "",
    samlMetadataUrl: "",
  },
};

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
        Object.assign(dropSeams, originalDrop);
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

const orgClient = orgSignInClient();

const cases = [
  {
    name: "account TOTP seed",
    path: "/v1/mfa/totp/enroll",
    json: JSON.stringify({ otpauthUrl: OTP }),
    call: () => beginAccountTotp(),
    includesCredential: (value: unknown) => value === OTP,
  },
  {
    name: "organization SCIM token",
    path: "/v1/organizations/org_generated/scim/tokens",
    json: JSON.stringify({ id: "scim_generated", token: GENERATED }),
    call: () => orgClient.mintToken(ORG),
    includesCredential: (value: unknown) =>
      JSON.stringify(value).includes(GENERATED),
  },
  {
    name: "drop bearer and encryption link",
    path: "/v1/claims",
    json: JSON.stringify({
      claimId: "claim_generated",
      claimToken: GENERATED,
      userCode: "generated code",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    call: () =>
      shareOnce({
        name: "Generated",
        text: "generated drop data",
        ttlMs: 60_000,
      }),
    includesCredential: (value: unknown) => {
      if (typeof value !== "object" || value === null || !("link" in value))
        return false;
      if (typeof value.link !== "string") return false;
      const fragment = new URLSearchParams(new URL(value.link).hash.slice(1));
      return (
        fragment.get("token") === GENERATED &&
        fragment.get("key")?.length === 43
      );
    },
  },
];

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

type RefusalKind =
  | "blocked"
  | "missing_page_origin"
  | "drop_error"
  | "api_error";

function refusalKind(error: Error): RefusalKind {
  if (/authenticate again/.test(error.message)) return "blocked";
  if (error instanceof DropError) {
    if (
      error.message ===
      "This page has no origin, so a drop link cannot be minted here."
    ) {
      return "missing_page_origin";
    }
    return "drop_error";
  }
  return "api_error";
}

for (const scenario of cases) {
  it.each(["synthetic", "pending", "fresh"] as const)(
    `withholds held ${scenario.name} body after original realm becomes %s`,
    async (mode) => {
      const body = heldResponse(scenario.json);
      const fetch = vi.fn(async () => body.response);
      identitySeams.identityFetch = fetch;
      const pending = scenario.call().then(
        (value) => ({ ok: true as const, value }),
        (error: Error) => ({ ok: false as const, error }),
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
      const observation = result.ok
        ? {
            kind: "accepted",
            credential: scenario.includesCredential(result.value),
          }
        : {
            kind: refusalKind(result.error),
            credential: false,
          };
      expect(observation).toEqual({ kind: "blocked", credential: false });
    },
  );
  it(`refuses a stale ${scenario.name} error body under its original realm`, async () => {
    const body = heldResponse(
      JSON.stringify({
        error: "validation_error",
        message: "Generated refusal",
        hint: "Generated refusal",
      }),
      403,
    );
    identitySeams.identityFetch = vi.fn(async () => body.response);
    const pending = scenario.call().then(
      () => ({ ok: true as const }),
      (error: Error) => ({ ok: false as const, error }),
    );
    drains.push(pending);
    try {
      await vi.waitFor(() => expect(body.readStarted()).toBe(true), {
        timeout: 1000,
        interval: 10,
      });
      await transition("fresh");
    } finally {
      body.release();
    }
    const result = await pending;
    expect(result.ok ? "accepted" : refusalKind(result.error)).toBe("blocked");
  });
  it(`returns ${scenario.name} for a genuinely fresh owner request`, async () => {
    await transition("fresh");
    bindFrontendSession();
    const body = heldResponse(scenario.json);
    identitySeams.identityFetch = vi.fn(async () => body.response);
    const pending = scenario.call().then(
      (value) => ({ ok: true as const, value }),
      (error: Error) => ({ ok: false as const, error }),
    );
    drains.push(pending);
    try {
      await vi.waitFor(() => expect(body.readStarted()).toBe(true), {
        timeout: 1000,
        interval: 10,
      });
    } finally {
      body.release();
    }
    const result = await pending;
    expect(result.ok ? "accepted" : refusalKind(result.error)).toBe("accepted");
    if (result.ok) expect(scenario.includesCredential(result.value)).toBe(true);
  });
}
