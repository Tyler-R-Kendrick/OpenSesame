import { webLocksDouble } from "./__tests__/web-locks-double.js";
/**
 * What an application's sign-in writes to the receipts (ADR 0162): a line when
 * it signs in and a line when that ends, ids only, and none when redemption
 * fails.
 */

import { createPkcePair } from "@opensesame/sdk-browser";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listReceipts } from "./device-receipts.js";
import { configureLocalApplication } from "./local-applications.js";
import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";
import {
  type LocalAuthorizationRequest,
  approveLocalApplication,
  redeemLocalApplicationCode,
  revokeLocalApplicationGrant,
} from "./local-authorization.js";
import { changeLocalDirectory } from "./local-directory-admin.js";
import {
  type LocalDirectoryChange,
  readLocalDirectory,
} from "./local-directory.js";
import { bindLocalIamLockResets } from "./local-iam-lock-resets.js";
import { enrollLocalPasskey } from "./local-passkeys.js";
import { consumedApplicationRequest } from "./local-request.fixture.js";
import {
  type LocalSession,
  revokeLocalIdentitySession,
  signInLocalIdentity,
} from "./local-sessions.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

let tomb: string;
let person: string;
let app: string;
let org: string;
let session: LocalSession;
let request: LocalAuthorizationRequest;
let verifier: string;
let unbindLockResets: () => void;

async function change(command: LocalDirectoryChange) {
  return changeLocalDirectory(
    tomb,
    (await readLocalDirectory(tomb)).revision,
    command,
  );
}

async function create(kind: "person" | "application" | "organization") {
  const next = await change({ action: "create", kind, name: kind });
  const entry = next.entries.find((row) => row.name === kind);
  if (!entry) throw new Error("Missing test identity");
  return entry.id;
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
  unbindLockResets = bindLocalIamLockResets();
  vi.spyOn(Date, "now").mockReturnValue(1788998400000);
  tomb = `authorization-receipts-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  vi.stubGlobal("navigator", {
    credentials: await authenticator(),
    locks: webLocksDouble(),
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
  await configureLocalApplication(tomb, 0, app, {
    applicationId: app,
    organizationId: org,
    redirectUris: [request.redirectUri],
    scopes: ["openid", "resource:read"],
    scopeRoles: ["openid", "resource:read"].map((scope) => ({
      scope,
      roles: ["owner" as const],
    })),
  });
  await enrollLocalPasskey(tomb, person);
  session = await signInLocalIdentity(tomb, person);
});
afterEach(() => {
  unbindLockResets();
  vaultStore.lock();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("writes a receipt when an application signs in and when that ends, and not when redemption fails", async () => {
  const { code } = await approve();
  await expect(redeem(code, `${verifier}x`)).rejects.toThrow();
  expect(
    (await listReceipts(tomb, 10)).filter((row) =>
      row.eventType.startsWith("access.sign_in"),
    ),
  ).toEqual([]);
  const grant = await redeem(code);
  await revokeLocalApplicationGrant(tomb, session, grant.id);
  const receipts = (await listReceipts(tomb, 10)).filter((row) =>
    row.eventType.startsWith("access.sign_in"),
  );
  expect(receipts.map((row) => row.eventType)).toEqual([
    "access.sign_in.revoked",
    "access.sign_in.granted",
  ]);
  for (const receipt of receipts)
    expect(receipt.metadata).toMatchObject({
      targetType: "application",
      targetId: app,
      subject: person,
      organizationId: org,
    });
  // The grant's id is a handle to the application's session, not the trail's.
  expect(JSON.stringify(receipts)).not.toContain(grant.id);
});

it("writes a receipt when a session is ended, for the person it was for", async () => {
  await revokeLocalIdentitySession(tomb, session.id);
  const [receipt] = await listReceipts(tomb, 5);
  expect(receipt?.eventType).toBe("access.session.revoked");
  expect(receipt?.metadata).toMatchObject({
    subject: person,
    targetType: "principal",
    targetId: person,
  });
  // The session's id is a handle to this tab's session, not the trail's.
  expect(JSON.stringify(receipt)).not.toContain(session.id);
});
