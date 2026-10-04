/**
 * A sign-in consent in the relying party's window (ADR 0162): while the
 * person's passkey is being asked it is not a request anyone else may decide,
 * hear about or see waiting, and a window that ends before it is decided takes
 * back what it raised.
 */

import { createPkcePair } from "@opensesame/sdk-browser";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { listInbox } from "./device-inbox.js";
import { listReceipts } from "./device-receipts.js";
import { listLocalAccessRequests } from "./local-access-requests.js";
import { configureLocalApplication } from "./local-applications.js";
import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";
import type { LocalAuthorizationRequest } from "./local-authorization.js";
import { changeLocalDirectory } from "./local-directory-admin.js";
import {
  type LocalDirectoryChange,
  readLocalDirectory,
} from "./local-directory.js";
import { bindLocalIamLockResets } from "./local-iam-lock-resets.js";
import { LocalIssuerChannel } from "./local-issuer-channel.js";
import { enrollLocalPasskey } from "./local-passkeys.js";
import { type LocalSession, signInLocalIdentity } from "./local-sessions.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

const opener = { closed: false, postMessage: vi.fn() };
let tomb: string;
let person: string;
let session: LocalSession;
let request: LocalAuthorizationRequest;
let issuer: LocalIssuerChannel;
let pipe: MessageChannel;
let browser: EventTarget;
let releasePasskey: () => void;
let unbindLockResets: () => void;
const status = vi.fn();

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

/** What the passkey does next: answer, wait for the test, or refuse. */
let gate: Promise<void> = Promise.resolve();
let refuse = false;
function hold() {
  gate = new Promise<void>((resolve) => {
    releasePasskey = resolve;
  });
}

async function steerablePasskey() {
  const real = await authenticator();
  return {
    credentials: {
      create: real.create.bind(real),
      get: async (options: CredentialRequestOptions) => {
        await gate;
        if (refuse) throw new Error("NotAllowedError");
        return real.get(options);
      },
    },
    locks: webLocksDouble(),
  };
}

beforeEach(async () => {
  unbindLockResets = bindLocalIamLockResets();
  vi.spyOn(Date, "now").mockReturnValue(1788998400000);
  tomb = `signin-window-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  gate = Promise.resolve();
  refuse = false;
  releasePasskey = () => undefined;
  vi.stubGlobal("navigator", await steerablePasskey());
  person = await create("person");
  const org = await create("organization");
  const app = await create("application");
  await change({
    action: "membership",
    organizationId: org,
    principalId: person,
    role: "owner",
  });
  const pkce = await createPkcePair();
  request = {
    applicationId: app,
    redirectUri: "https://rp.example.test/callback",
    scopes: ["openid"],
    state: pkce.state,
    nonce: pkce.nonce,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: "S256",
  };
  await configureLocalApplication(tomb, 0, app, {
    applicationId: app,
    organizationId: org,
    redirectUris: [request.redirectUri],
    scopes: ["openid"],
    scopeRoles: [{ scope: "openid", roles: ["owner" as const] }],
  });
  await enrollLocalPasskey(tomb, person);
  session = await signInLocalIdentity(tomb, person);
  browser = Object.assign(new EventTarget(), { opener });
  vi.stubGlobal("window", browser);
  issuer = new LocalIssuerChannel(tomb, request, status);
  pipe = new MessageChannel();
  browser.dispatchEvent(
    Object.assign(new Event("message"), {
      origin: "https://rp.example.test",
      source: opener,
      data: {
        type: "opensesame:local:connect",
        state: request.state,
        version: "1",
      },
      ports: [pipe.port2],
    }),
  );
});

afterEach(() => {
  releasePasskey();
  issuer.close();
  pipe.port1.close();
  pipe.port2.close();
  unbindLockResets();
  vaultStore.lock();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The approval, started and left waiting on the person's passkey. */
async function approvalWaitingOnPasskey() {
  hold();
  const approving = issuer.approve(session);
  approving.catch(() => undefined);
  await vi.waitFor(async () =>
    expect(await listLocalAccessRequests(tomb)).toHaveLength(1),
  );
  // Boxed: an async function that returned the promise itself would wait for it.
  return { approving };
}

it("is not in the inbox, and not offered to be decided, while the passkey is being asked", async () => {
  const { approving } = await approvalWaitingOnPasskey();
  const [row] = await listLocalAccessRequests(tomb);
  expect(row?.status).toBe("pending");
  expect(row?.authorizationDigest).toBeTruthy();
  expect(await listInbox(tomb)).toEqual([]);
  releasePasskey();
  await approving;
  expect(await listInbox(tomb)).toEqual([]);
});

it("takes back what it raised when the window ends before the person has decided", async () => {
  const { approving } = await approvalWaitingOnPasskey();
  issuer.close();
  await vi.waitFor(async () =>
    expect((await listLocalAccessRequests(tomb)).map((r) => r.status)).toEqual([
      "revoked",
    ]),
  );
  expect(await listInbox(tomb)).toEqual([]);
  releasePasskey();
  await expect(approving).rejects.toThrow();
  const kinds = (await listReceipts(tomb, 10)).map((row) => row.eventType);
  expect(kinds).toContain("access.request.withdrawn");
  expect(kinds).not.toContain("access.request.approved");
});

it("takes back what it raised when the passkey is refused", async () => {
  refuse = true;
  await expect(issuer.approve(session)).rejects.toThrow();
  expect((await listLocalAccessRequests(tomb)).map((r) => r.status)).toEqual([
    "revoked",
  ]);
});

it("refuses to approve while a refusal is being written, and approves nothing after it", async () => {
  const denying = issuer.deny();
  await expect(issuer.approve(session)).rejects.toThrow("channel_unavailable");
  await denying;
  await expect(issuer.approve(session)).rejects.toThrow("channel_unavailable");
  expect(await listLocalAccessRequests(tomb)).toEqual([]);
  expect((await listReceipts(tomb, 10)).map((row) => row.eventType)).toEqual([
    "access.sign_in.denied",
  ]);
});
