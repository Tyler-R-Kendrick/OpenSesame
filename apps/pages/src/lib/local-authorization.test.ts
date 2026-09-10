import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { createPkcePair } from "@opensesame/sdk-browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureLocalApplication } from "./local-applications.js";
import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";
import {
  type LocalAuthorizationRequest,
  approveLocalApplication,
  listLocalApplicationGrants,
  redeemLocalApplicationCode,
  revokeLocalApplicationGrant,
  withLocalApplicationGrant,
} from "./local-authorization.js";
import {
  type LocalDirectoryChange,
  changeLocalDirectory,
  readLocalDirectory,
} from "./local-directory.js";
import {
  listRecordedLocalGrants,
  revokeRecordedLocalGrant,
} from "./local-grant-admin.js";
import { enrollLocalPasskey } from "./local-passkeys.js";
import { consumedApplicationRequest } from "./local-request.fixture.js";
import {
  type LocalSession,
  revokeLocalIdentitySession,
  signInLocalIdentity,
} from "./local-sessions.js";
import { mintVaultKey } from "./vault/crypto.js";
import { vaultStore } from "./vault/store.js";
import {
  lockAllTombs,
  readFile,
  unlockTomb,
  vfsSeams,
  writeFile,
} from "./vfs.js";

let tomb: string;
let person: string;
let app: string;
let org: string;
let session: LocalSession;
let request: LocalAuthorizationRequest;
let verifier: string;
async function change(command: LocalDirectoryChange) {
  return changeLocalDirectory(
    tomb,
    (await readLocalDirectory(tomb)).revision,
    command,
  );
}
async function create(
  kind: "person" | "application" | "organization",
  name: string = kind,
) {
  const next = await change({ action: "create", kind, name });
  const entry = next.entries.find((row) => row.name === name);
  if (!entry) throw new Error("Missing test identity");
  return entry.id;
}
function configuration() {
  return {
    applicationId: app,
    organizationId: org,
    redirectUris: [request.redirectUri],
    scopes: ["openid", "resource:read", "resource:write"],
    scopeRoles: ["openid", "resource:read", "resource:write"].map((scope) => ({
      scope,
      roles: ["owner" as const],
    })),
  };
}
async function approve() {
  return approveLocalApplication(
    tomb,
    session,
    request,
    await consumedApplicationRequest(tomb, session, request),
  );
}
function redeem(code: string, codeVerifier = verifier) {
  return redeemLocalApplicationCode(tomb, {
    code,
    codeVerifier,
    applicationId: app,
    redirectUri: request.redirectUri,
  });
}
beforeEach(async () => {
  // Real crypto/timers run, but VM wall-clock corrections must not invalidate fixtures.
  vi.spyOn(Date, "now").mockReturnValue(1788998400000);
  tomb = `authorization-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  vi.stubGlobal("navigator", {
    credentials: await authenticator(),
    locks: {
      request: <T>(_name: string, action: () => Promise<T>) => {
        const next = queue.then(action);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  person = await create("person");
  org = await create("organization");
  app = await create("application");
  await change({
    action: "membership",
    organizationId: org,
    principalId: person,
    role: "owner",
  });
  const backupOwner = await create("person", "Backup owner");
  await change({
    action: "membership",
    organizationId: org,
    principalId: backupOwner,
    role: "owner",
  });
  const pkce = await createPkcePair();
  verifier = pkce.codeVerifier;
  request = {
    applicationId: app,
    redirectUri: "https://rp.example.test/callback",
    scopes: ["openid", "resource:read"],
    state: pkce.state,
    nonce: pkce.nonce,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: "S256",
  };
  await configureLocalApplication(tomb, 0, app, configuration());
  await enrollLocalPasskey(tomb, person);
  session = await signInLocalIdentity(tomb, person);
});
afterEach(() => {
  vaultStore.lock();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("redeems consent once and enforces the exact app and approved scopes", async () => {
  const approved = await approve();
  expect(approved.state).toBe(request.state);
  const grant = await redeem(approved.code);
  expect(Object.keys(grant).sort()).toEqual([
    "applicationId",
    "expiresAt",
    "id",
  ]);
  expect(
    await withLocalApplicationGrant(
      tomb,
      grant,
      app,
      ["resource:read"],
      async (identity) => identity.principalId,
    ),
  ).toBe(person);
  const action = vi.fn(async () => "forbidden");
  await expect(
    withLocalApplicationGrant(tomb, grant, app, ["resource:write"], action),
  ).rejects.toThrow();
  await expect(
    withLocalApplicationGrant(
      tomb,
      { ...grant },
      app,
      ["resource:read"],
      action,
    ),
  ).rejects.toThrow();
  await expect(
    withLocalApplicationGrant(
      tomb,
      grant,
      "other-app",
      ["resource:read"],
      action,
    ),
  ).rejects.toThrow();
  expect(action).not.toHaveBeenCalled();
  await expect(redeem(approved.code)).rejects.toThrow();
  const stored = new TextDecoder().decode(
    await readFile(tomb, "config/identity-grants"),
  );
  expect(stored).not.toContain(approved.code);
  expect(stored).not.toContain(verifier);
});

it("refuses interception without the verifier and exact callback/client", async () => {
  const { code } = await approve();
  await expect(redeem(code, "x".repeat(43))).rejects.toThrow();
  await expect(
    redeemLocalApplicationCode(tomb, {
      code,
      codeVerifier: verifier,
      applicationId: app,
      redirectUri: `${request.redirectUri}?changed=1`,
    }),
  ).rejects.toThrow();
  await expect(
    redeemLocalApplicationCode(tomb, {
      code,
      codeVerifier: verifier,
      applicationId: "other-app",
      redirectUri: request.redirectUri,
    }),
  ).rejects.toThrow();
  expect((await redeem(code)).applicationId).toBe(app);
});

it("has a single winner for concurrent redemption", async () => {
  const { code } = await approve();
  const results = await Promise.allSettled([redeem(code), redeem(code)]);
  expect(results.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(await listLocalApplicationGrants(tomb, session)).toHaveLength(1);
});

it("a scope-policy change invalidates pending codes and active grants before effects", async () => {
  const { code } = await approve();
  const grant = await redeem(code);
  const pending = await approve();
  const changed = configuration();
  changed.scopeRoles = changed.scopeRoles.map((row) => ({ ...row, roles: [] }));
  await configureLocalApplication(tomb, 1, app, changed);
  await expect(redeem(pending.code)).rejects.toThrow();
  const action = vi.fn(async () => true);
  await expect(
    withLocalApplicationGrant(tomb, grant, app, ["openid"], action),
  ).rejects.toThrow();
  expect(action).not.toHaveBeenCalled();
});

it("revokes grants independently without revoking the person session", async () => {
  const grant = await redeem((await approve()).code);
  await revokeLocalApplicationGrant(tomb, session, grant.id);
  expect(await listLocalApplicationGrants(tomb, session)).toEqual([]);
  await expect(
    withLocalApplicationGrant(tomb, grant, app, ["openid"], async () => true),
  ).rejects.toThrow();
  expect(await approve()).toHaveProperty("code");
});

it("custodian revocation invalidates an actual issued grant without the subject's presentation", async () => {
  const grant = await redeem((await approve()).code);
  expect(await listRecordedLocalGrants(tomb)).toContainEqual(
    expect.objectContaining({ id: grant.id, principalId: person }),
  );
  await revokeRecordedLocalGrant(tomb, grant.id);
  const action = vi.fn();
  await expect(
    withLocalApplicationGrant(tomb, grant, app, ["openid"], action),
  ).rejects.toThrow();
  expect(action).not.toHaveBeenCalled();
  expect(await approve()).toHaveProperty("code");
});

it.each(["lock", "session-revoke", "person-disable", "application-disable"])(
  "refuses pending and issued authority after %s",
  async (fault) => {
    const grant = await redeem((await approve()).code);
    const pending = await approve();
    if (fault === "lock") vaultStore.lock();
    if (fault === "session-revoke")
      await revokeLocalIdentitySession(tomb, session.id);
    if (fault === "person-disable")
      await change({
        action: "update",
        id: person,
        name: "person",
        enabled: false,
      });
    if (fault === "application-disable")
      await change({
        action: "update",
        id: app,
        name: "application",
        enabled: false,
      });
    await expect(redeem(pending.code)).rejects.toThrow();
    await expect(
      withLocalApplicationGrant(tomb, grant, app, ["openid"], async () => true),
    ).rejects.toThrow();
  },
);

it.each(["expired", "clock-rollback"])(
  "rejects a code after %s",
  async (fault) => {
    const before = Date.now();
    const result = await approve();
    vi.spyOn(Date, "now").mockReturnValue(
      fault === "expired" ? result.expiresAt : before - 1,
    );
    await expect(redeem(result.code)).rejects.toThrow();
  },
);

it("burns a code if grant storage fails, requiring fresh consent", async () => {
  const { code } = await approve();
  const write = vi
    .spyOn(vfsSeams, "writeRaw")
    .mockRejectedValue(new Error("Storage failed"));
  await expect(redeem(code)).rejects.toThrow("Storage failed");
  write.mockRestore();
  await expect(redeem(code)).rejects.toThrow();
  expect(await listLocalApplicationGrants(tomb, session)).toEqual([]);
});

it("checks vault liveness again after asynchronous policy reads", async () => {
  const grant = await redeem((await approve()).code);
  const open = vfsSeams.open;
  let sawApplication = false;
  let lockedDuringPolicy = false;
  vi.spyOn(vfsSeams, "open").mockImplementation(async (key, bytes) => {
    const result = await open(key, bytes);
    const envelope = overlapCast(result);
    if (isJsonObject(envelope) && isString(envelope.dataB64)) {
      const json = atob(envelope.dataB64);
      if (json.includes('"applications":')) sawApplication = true;
      if (sawApplication && json.includes('"memberships":')) {
        lockedDuringPolicy = true;
        vaultStore.lock();
      }
    }
    return result;
  });
  const action = vi.fn(async () => true);
  await expect(
    withLocalApplicationGrant(tomb, grant, app, ["openid"], action),
  ).rejects.toThrow("session is unavailable");
  expect(lockedDuringPolicy).toBe(true);
  expect(action).not.toHaveBeenCalled();
});

it("rejects malformed state, nonce and challenge instead of treating structure as proof", async () => {
  const consumed = await consumedApplicationRequest(tomb, session, request);
  for (const patch of [
    { state: "short" },
    { nonce: "short" },
    { codeChallenge: "invalid" },
    { scopes: Array.from({ length: 33 }, () => "openid") },
    { scopes: ["openid", "x".repeat(65)] },
    { redirectUri: "x".repeat(2049) },
  ])
    await expect(
      approveLocalApplication(
        tomb,
        session,
        { ...request, ...patch },
        consumed,
      ),
    ).rejects.toThrow();
  expect(await listLocalApplicationGrants(tomb, session)).toEqual([]);
});

it("bounds pending consent codes and reclaims only expired requests", async () => {
  for (let index = 0; index < 128; index++) await approve();
  await expect(approve()).rejects.toThrow("Too many pending authorizations");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
  expect(await approve()).toHaveProperty("code");
}, 30_000);

it("does not overwrite a corrupt grant ledger during redemption", async () => {
  const { code } = await approve();
  const bytes = new TextEncoder().encode(
    '{"version":1,"grants":[{"id":"invalid"}]}',
  );
  await writeFile(tomb, "config/identity-grants", bytes);
  await expect(redeem(code)).rejects.toThrow("grant storage is invalid");
  expect(await readFile(tomb, "config/identity-grants")).toEqual(bytes);
  await expect(redeem(code)).rejects.toThrow("authorization is unavailable");
});
