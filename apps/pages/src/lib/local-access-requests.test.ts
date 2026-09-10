import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  consumeLocalAccessRequest,
  createLocalAccessRequest,
  decideLocalAccessRequest,
  listLocalAccessRequests,
  removeSettledLocalAccessRequest,
  revokeLocalAccessRequest,
} from "./local-access-requests.js";
import { configureLocalApplication } from "./local-applications.js";
import { revokeLocalPasskey } from "./local-credentials.js";
import { readLocalRequestRecords } from "./local-request-store.js";
import { localRequestFixture } from "./local-request.fixture.js";
import {
  type LocalSession,
  revokeLocalIdentitySession,
} from "./local-sessions.js";
import { mintVaultKey } from "./vault/crypto.js";
import { vaultStore } from "./vault/store.js";
import { readFile, unlockTomb, vfsSeams, writeFile } from "./vfs.js";

let tomb: string;
let personId: string;
let applicationId: string;
let organizationId: string;
let session: LocalSession;
let device: Awaited<ReturnType<typeof localRequestFixture>>["device"];
function registration() {
  return {
    applicationId,
    organizationId,
    redirectUris: ["https://rp.example.test/callback"],
    scopes: ["openid"],
  };
}
function createRequest() {
  return createLocalAccessRequest(tomb, session, {
    applicationId,
    redirectUri: "https://rp.example.test/callback",
    scopes: ["openid"],
    reason: "Sign in to the test application",
  });
}

beforeEach(async () => {
  ({ tomb, personId, applicationId, organizationId, session, device } =
    await localRequestFixture());
});
afterEach(() => {
  vaultStore.lock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("persists a real request, verifies bound consent, and consumes its effect once", async () => {
  const pending = await createRequest();
  expect((await listLocalAccessRequests(tomb))[0]).toEqual(pending);
  const approved = await decideLocalAccessRequest(tomb, {
    ...pending,
    principalId: personId,
    decision: "approve",
  });
  expect(approved.status).toBe("approved");
  expect(JSON.stringify(approved)).not.toContain("publicKeyB64");
  const effect = vi.fn(async () => "completed");
  const results = await Promise.allSettled([
    consumeLocalAccessRequest(tomb, session, approved, effect),
    consumeLocalAccessRequest(tomb, session, approved, effect),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(effect).toHaveBeenCalledOnce();
  expect((await readLocalRequestRecords(tomb))[0]?.status).toBe("consumed");
});

it("denial is terminal and never invokes an effect", async () => {
  const pending = await createRequest();
  const denied = await decideLocalAccessRequest(tomb, {
    ...pending,
    principalId: personId,
    decision: "deny",
  });
  const effect = vi.fn(async () => undefined);
  await expect(
    consumeLocalAccessRequest(tomb, session, denied, effect),
  ).rejects.toThrow();
  await expect(
    decideLocalAccessRequest(tomb, {
      ...denied,
      principalId: personId,
      decision: "approve",
    }),
  ).rejects.toThrow();
  expect(effect).not.toHaveBeenCalled();
  await removeSettledLocalAccessRequest(tomb, denied);
  expect(await listLocalAccessRequests(tomb)).toEqual([]);
});

it("rejects stale/swapped request references before opening the authenticator", async () => {
  const first = await createRequest();
  const second = await createRequest();
  const get = vi.spyOn(device, "get");
  await expect(
    decideLocalAccessRequest(tomb, {
      ...first,
      requestDigest: second.requestDigest,
      principalId: personId,
      decision: "approve",
    }),
  ).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
  await expect(removeSettledLocalAccessRequest(tomb, first)).rejects.toThrow();
});

it("rejects a forged requester session and cross-vault references", async () => {
  const pending = await createRequest();
  const approved = await decideLocalAccessRequest(tomb, {
    ...pending,
    principalId: personId,
    decision: "approve",
  });
  await expect(
    consumeLocalAccessRequest(
      tomb,
      { ...session },
      approved,
      async () => undefined,
    ),
  ).rejects.toThrow();
  const other = `other-${crypto.randomUUID()}`;
  unlockTomb(other, (await mintVaultKey()).vaultKey);
  await expect(revokeLocalAccessRequest(other, approved)).rejects.toThrow();
});

it.each(["key", "policy"] as const)(
  "refuses a changed %s before consumption",
  async (fault) => {
    const pending = await createRequest();
    const approved = await decideLocalAccessRequest(tomb, {
      ...pending,
      principalId: personId,
      decision: "approve",
    });
    const effect = vi.fn(async () => undefined);
    if (fault === "policy")
      await configureLocalApplication(tomb, 1, applicationId, registration());
    else {
      const key = (await readLocalRequestRecords(tomb))[0]?.approval;
      if (!key) throw new Error("Missing approval key");
      await revokeLocalPasskey(tomb, personId, key.credentialId);
    }
    await expect(
      consumeLocalAccessRequest(tomb, session, approved, effect),
    ).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
  },
);

it("withdrawal wins while the approver is touching the authenticator", async () => {
  const pending = await createRequest();
  const get = device.get.bind(device);
  vi.spyOn(device, "get").mockImplementation(async (options) => {
    const response = await get(options);
    await revokeLocalAccessRequest(tomb, pending);
    return response;
  });
  await expect(
    decideLocalAccessRequest(tomb, {
      ...pending,
      principalId: personId,
      decision: "approve",
    }),
  ).rejects.toThrow();
  expect((await listLocalAccessRequests(tomb))[0]?.status).toBe("revoked");
});

it("revoking the requester session prevents an approved effect", async () => {
  const pending = await createRequest();
  const approved = await decideLocalAccessRequest(tomb, {
    ...pending,
    principalId: personId,
    decision: "approve",
  });
  await revokeLocalIdentitySession(tomb, session.id);
  const effect = vi.fn(async () => undefined);
  await expect(
    consumeLocalAccessRequest(tomb, session, approved, effect),
  ).rejects.toThrow();
  expect(effect).not.toHaveBeenCalled();
});

it("an owner cannot request a scope that its application policy denies", async () => {
  await configureLocalApplication(tomb, 1, applicationId, {
    ...registration(),
    scopeRoles: [{ scope: "openid", roles: [] }],
  });
  await expect(createRequest()).rejects.toThrow();
  expect(await listLocalAccessRequests(tomb)).toEqual([]);
});

it("concurrent approvers cannot settle the same version twice", async () => {
  const pending = await createRequest();
  const results = await Promise.allSettled([
    decideLocalAccessRequest(tomb, {
      ...pending,
      principalId: personId,
      decision: "approve",
    }),
    decideLocalAccessRequest(tomb, {
      ...pending,
      principalId: personId,
      decision: "deny",
    }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(["approved", "denied"]).toContain(
    (await listLocalAccessRequests(tomb))[0]?.status,
  );
});

it("retains consumed state after an effect fails instead of replaying it", async () => {
  const pending = await createRequest();
  const approved = await decideLocalAccessRequest(tomb, {
    ...pending,
    principalId: personId,
    decision: "approve",
  });
  await expect(
    consumeLocalAccessRequest(tomb, session, approved, async () => {
      throw new Error("Effect failed");
    }),
  ).rejects.toThrow("Effect failed");
  expect((await listLocalAccessRequests(tomb))[0]?.status).toBe("consumed");
  await expect(
    consumeLocalAccessRequest(tomb, session, approved, async () => undefined),
  ).rejects.toThrow();
});

it("fails before effects on storage error and refuses corrupted bindings", async () => {
  const pending = await createRequest();
  const approved = await decideLocalAccessRequest(tomb, {
    ...pending,
    principalId: personId,
    decision: "approve",
  });
  const effect = vi.fn(async () => undefined);
  const write = vi
    .spyOn(vfsSeams, "writeRaw")
    .mockRejectedValueOnce(new Error("Disk failed"));
  await expect(
    consumeLocalAccessRequest(tomb, session, approved, effect),
  ).rejects.toThrow();
  expect(effect).not.toHaveBeenCalled();
  write.mockRestore();
  const contents = new TextDecoder().decode(
    await readFile(tomb, "config/identity-requests"),
  );
  await writeFile(
    tomb,
    "config/identity-requests",
    new TextEncoder().encode(
      contents.replace("Sign in to the test application", "Altered request"),
    ),
  );
  await expect(listLocalAccessRequests(tomb)).rejects.toThrow(
    "binding is invalid",
  );
});

it("projects expiry and permits deleting expired history without approval", async () => {
  const pending = await createRequest();
  vi.spyOn(Date, "now").mockReturnValue(pending.expiresAt);
  const expired = (await listLocalAccessRequests(tomb))[0];
  expect(expired.status).toBe("expired");
  await expect(
    decideLocalAccessRequest(tomb, {
      ...expired,
      principalId: personId,
      decision: "approve",
    }),
  ).rejects.toThrow();
  await removeSettledLocalAccessRequest(tomb, expired);
  expect(await listLocalAccessRequests(tomb)).toEqual([]);
});
