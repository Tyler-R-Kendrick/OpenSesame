import { createPkcePair } from "@opensesame/sdk-browser";
import type { LocalAuthorizationRequest } from "@opensesame/static-auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  consumeLocalAccessRequest,
  createLocalAccessRequest,
  decideLocalAccessRequest,
  listLocalAccessRequests,
  localRequestMemberMayDecide,
} from "./local-access-requests.js";
import {
  approveLocalApplication,
  redeemLocalApplicationCode,
  withLocalApplicationGrant,
} from "./local-authorization.js";
import { readLocalPasskeys, revokeLocalPasskey } from "./local-credentials.js";
import { withLocalDirectoryLock } from "./local-directory.js";
import {
  createLocalApplicationRequest,
  redeemLocalApplicationRequest,
} from "./local-request-authorization.js";
import { requireConsumedRequest } from "./local-request-issuance.js";
import { readLocalRequestRecords } from "./local-request-store.js";
import { localRequestFixture } from "./local-request.fixture.js";
import { signInLocalIdentity } from "./local-sessions.js";
import { vaultStore } from "./vault/store.js";
import { vfsSeams } from "./vfs.js";

let fixture: Awaited<ReturnType<typeof localRequestFixture>>;
let request: LocalAuthorizationRequest;
let verifier: string;
beforeEach(async () => {
  fixture = await localRequestFixture();
  const pkce = await createPkcePair();
  verifier = pkce.codeVerifier;
  request = {
    applicationId: fixture.applicationId,
    redirectUri: "https://rp.example.test/callback",
    scopes: ["openid"],
    state: pkce.state,
    nonce: pkce.nonce,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: "S256",
  };
});
afterEach(() => {
  vaultStore.lock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shares exact organization and self-consent eligibility with the approver selector", async () => {
  const { tomb, session, personId, organizationId } = fixture;
  const bound = await createLocalApplicationRequest(tomb, session, request);
  const member = {
    principalId: personId,
    organizationId,
    role: "member" as const,
  };
  expect(localRequestMemberMayDecide(bound, member)).toBe(true);
  expect(
    localRequestMemberMayDecide(
      { ...bound, authorizationDigest: undefined },
      member,
    ),
  ).toBe(false);
  expect(
    localRequestMemberMayDecide(bound, {
      ...member,
      principalId: "another-person",
    }),
  ).toBe(false);
  expect(
    localRequestMemberMayDecide(bound, {
      ...member,
      organizationId: "another-org",
      role: "owner",
    }),
  ).toBe(false);
  expect(
    localRequestMemberMayDecide(bound, {
      ...member,
      principalId: "another-person",
      role: "admin",
    }),
  ).toBe(true);
});

it("preserves member self-consent without allowing ordinary request administration", async () => {
  const { tomb, personId, organizationId, change } = fixture;
  const directory = await change({
    action: "create",
    kind: "person",
    name: "Other owner",
  });
  const owner = directory.entries.find((row) => row.name === "Other owner");
  if (!owner) throw new Error("Missing second owner");
  await change({
    action: "membership",
    principalId: owner.id,
    organizationId,
    role: "owner",
  });
  await change({
    action: "membership",
    principalId: personId,
    organizationId,
    role: "member",
  });
  fixture.session = await signInLocalIdentity(tomb, personId);
  const approved = await approve();
  await expect(
    redeemLocalApplicationRequest(
      tomb,
      { session: fixture.session },
      approved,
      request,
    ),
  ).resolves.toHaveProperty("code");
  const ordinary = await createLocalAccessRequest(tomb, fixture.session, {
    applicationId: request.applicationId,
    redirectUri: request.redirectUri,
    scopes: request.scopes,
    reason: "Ordinary access request",
  });
  await expect(
    decideLocalAccessRequest(tomb, {
      ...ordinary,
      principalId: personId,
      decision: "approve",
    }),
  ).rejects.toThrow();
});

it("refuses code issuance against a different registration revision", async () => {
  const approved = await approve();
  await expect(
    approveLocalApplication(fixture.tomb, fixture.session, request, {
      ...approved,
      applicationRevision: 2,
    }),
  ).rejects.toThrow();
});

it("rechecks the approval key after consumption and before issuance", async () => {
  const { tomb, session, personId } = fixture;
  const approved = await approve();
  const consumed = await consumeLocalAccessRequest(
    tomb,
    session,
    approved,
    async (row) => row,
  );
  const check = () =>
    withLocalDirectoryLock(tomb, () =>
      requireConsumedRequest(tomb, consumed, { session }, request),
    );
  await expect(check()).resolves.toMatchObject({ id: consumed.id });
  const key = (await readLocalPasskeys(tomb))[0];
  if (!key) throw new Error("Missing enrolled approval key");
  await revokeLocalPasskey(tomb, personId, key.credentialId);
  await expect(check()).rejects.toThrow();
});

it.each(["nonce", "state", "codeChallenge"] as const)(
  "refuses a substituted %s at final code issuance",
  async (field) => {
    const { tomb, session } = fixture;
    const consumed = await consumeLocalAccessRequest(
      tomb,
      session,
      await approve(),
      async (row) => row,
    );
    await expect(
      approveLocalApplication(
        tomb,
        session,
        { ...request, [field]: "x".repeat(43) },
        consumed,
      ),
    ).rejects.toThrow();
  },
);
async function approve() {
  const { tomb, session, personId } = fixture;
  const pending = await createLocalApplicationRequest(tomb, session, request);
  return decideLocalAccessRequest(tomb, {
    ...pending,
    principalId: personId,
    decision: "approve",
  });
}

it("requires a bound consumed approval even with a valid authenticated session", async () => {
  const { tomb, session } = fixture;
  await expect(
    approveLocalApplication(tomb, session, request),
  ).rejects.toThrow();
});

it("allows only one code issuance from a consumed approval", async () => {
  const { tomb, session } = fixture;
  const consumed = await consumeLocalAccessRequest(
    tomb,
    session,
    await approve(),
    async (row) => row,
  );
  const results = await Promise.allSettled([
    approveLocalApplication(tomb, session, request, consumed),
    approveLocalApplication(tomb, session, request, consumed),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect((await readLocalRequestRecords(tomb))[0]?.codeIssuedAt).toBe(
    Date.now(),
  );
  const refreshed = (await listLocalAccessRequests(tomb))[0];
  if (!refreshed) throw new Error("Missing persisted request");
  await expect(
    approveLocalApplication(tomb, session, request, refreshed),
  ).rejects.toThrow("already issued");
});

it("does not reopen issuance after an interrupted durable claim", async () => {
  const { tomb, session } = fixture;
  const consumed = await consumeLocalAccessRequest(
    tomb,
    session,
    await approve(),
    async (row) => row,
  );
  const write = vfsSeams.writeRaw;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementationOnce(async (...args) => {
    await write(...args);
    throw new Error("Interrupted after persistence");
  });
  await expect(
    approveLocalApplication(tomb, session, request, consumed),
  ).rejects.toThrow("Interrupted after persistence");
  await expect(
    approveLocalApplication(tomb, session, request, consumed),
  ).rejects.toThrow("already issued");
});

it("spends a request into a real PKCE grant exactly once", async () => {
  const { tomb, session, applicationId, personId } = fixture;
  const approved = await approve();
  const code = await redeemLocalApplicationRequest(
    tomb,
    { session },
    approved,
    request,
  );
  const grant = await redeemLocalApplicationCode(tomb, {
    code: code.code,
    codeVerifier: verifier,
    applicationId,
    redirectUri: request.redirectUri,
  });
  expect(
    await withLocalApplicationGrant(
      tomb,
      grant,
      applicationId,
      ["openid"],
      async (row) => row.principalId,
    ),
  ).toBe(personId);
  await expect(
    redeemLocalApplicationRequest(tomb, { session }, approved, request),
  ).rejects.toThrow();
  expect((await listLocalAccessRequests(tomb))[0]?.status).toBe("consumed");
});

it.each(["nonce", "state", "codeChallenge"] as const)(
  "refuses a substituted %s and never permits replay",
  async (field) => {
    const { tomb, session } = fixture;
    const approved = await approve();
    await expect(
      redeemLocalApplicationRequest(tomb, { session }, approved, {
        ...request,
        [field]: "x".repeat(43),
      }),
    ).rejects.toThrow();
    await expect(
      redeemLocalApplicationRequest(tomb, { session }, approved, request),
    ).rejects.toThrow();
    expect((await listLocalAccessRequests(tomb))[0]?.status).toBe("consumed");
  },
);
