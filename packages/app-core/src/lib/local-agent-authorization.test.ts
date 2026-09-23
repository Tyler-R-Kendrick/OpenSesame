import type { OrganizationRole } from "@opensesame/os-domain";
import { createPkcePair } from "@opensesame/sdk-browser";
import { createLocalAgentKey } from "@opensesame/static-auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginLocalAgentAuthentication } from "./local-agent-auth.js";
import { verifyAgentApplicationChannel } from "./local-agent-channel.fixture.js";
import {
  readLocalAgentKeys,
  registerLocalAgentKey,
  revokeLocalAgentKey,
} from "./local-agent-keys.js";
import { configureLocalApplication } from "./local-applications.js";
import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";
import {
  type LocalAuthorizationRequest,
  approveLocalAgentApplication,
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
  readLocalGrantRecords,
  writeLocalGrantRecords,
} from "./local-grant-store.js";
import { enrollLocalPasskey } from "./local-passkeys.js";
import { consumedApplicationRequest } from "./local-request.fixture.js";
import {
  type LocalSession,
  revokeLocalIdentitySession,
  signInLocalAgent,
  signInLocalIdentity,
} from "./local-sessions.js";
import { mintVaultKey } from "./vault/crypto.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, unlockTomb, vfsSeams } from "./vfs.js";

let tomb: string;
let human: string;
let agent: string;
let org: string;
let app: string;
let humanSession: LocalSession;
let agentSession: LocalSession;
let key: Awaited<ReturnType<typeof createLocalAgentKey>>;
let credentialId: string;
let request: LocalAuthorizationRequest;
let verifier: string;
async function change(input: LocalDirectoryChange) {
  return changeLocalDirectory(
    tomb,
    (await readLocalDirectory(tomb)).revision,
    input,
  );
}
async function create(
  kind: "person" | "agent" | "organization" | "application",
  name: string = kind,
) {
  const next = await change({ action: "create", kind, name });
  const entry = next.entries.find((row) => row.name === name);
  if (!entry) throw new Error("Missing test identity");
  return entry.id;
}
async function signInAgent() {
  const challenge = await beginLocalAgentAuthentication(
    tomb,
    agent,
    credentialId,
  );
  return signInLocalAgent(
    tomb,
    challenge.nonce,
    await key.signChallenge(challenge, origin, agent),
  );
}
function redeem(code: string) {
  return redeemLocalApplicationCode(tomb, {
    code,
    applicationId: app,
    redirectUri: request.redirectUri,
    codeVerifier: verifier,
  });
}
async function grant() {
  const code = await approve();
  return redeem(code.code);
}
async function approve() {
  return approveLocalAgentApplication(
    tomb,
    humanSession,
    agentSession,
    request,
    await consumedApplicationRequest(tomb, agentSession, request, human),
  );
}
beforeEach(async () => {
  // Wall-clock rollback is intentionally refused. Keep happy-path crypto tests
  // independent of VM clock corrections; real timers still run.
  vi.spyOn(Date, "now").mockReturnValue(1788998400000);
  tomb = `agent-authorization-${crypto.randomUUID()}`;
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
  human = await create("person");
  const backup = await create("person", "backup");
  agent = await create("agent");
  org = await create("organization");
  app = await create("application");
  for (const principalId of [human, backup])
    await change({
      action: "membership",
      organizationId: org,
      principalId,
      role: "owner",
    });
  await change({
    action: "membership",
    organizationId: org,
    principalId: agent,
    role: "member",
  });
  const pkce = await createPkcePair();
  verifier = pkce.codeVerifier;
  request = {
    applicationId: app,
    redirectUri: "https://agent.example.test/callback",
    scopes: ["openid", "records:read"],
    state: pkce.state,
    nonce: pkce.nonce,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: "S256",
  };
  const roles: OrganizationRole[] = ["owner", "admin", "member"];
  await configureLocalApplication(tomb, 0, app, {
    applicationId: app,
    organizationId: org,
    redirectUris: [request.redirectUri],
    scopes: ["openid", "records:read", "records:write"],
    scopeRoles: ["openid", "records:read", "records:write"].map((scope) => ({
      scope,
      roles,
    })),
  });
  await enrollLocalPasskey(tomb, human);
  key = await createLocalAgentKey();
  await registerLocalAgentKey(tomb, agent, key.publicKey);
  const enrolled = (await readLocalAgentKeys(tomb))[0];
  if (!enrolled) throw new Error("Missing test agent key");
  credentialId = enrolled.credentialId;
  humanSession = await signInLocalIdentity(tomb, human);
  agentSession = await signInAgent();
});
afterEach(() => {
  vaultStore.lock();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("binds human consent to the agent, application and scopes with actual dual authentication", async () => {
  const approved = await grant();
  const identity = await withLocalApplicationGrant(
    tomb,
    approved,
    app,
    ["records:read"],
    async (value) => value,
  );
  expect(identity.principalId).toBe(agent);
  expect(identity.approval).toEqual({
    principalId: human,
    sessionId: humanSession.id,
  });
  expect(await listLocalApplicationGrants(tomb, humanSession)).toContainEqual(
    identity,
  );
  expect(approved.expiresAt).toBeLessThanOrEqual(humanSession.expiresAt);
  expect(approved.expiresAt).toBeLessThanOrEqual(agentSession.expiresAt);
  const action = vi.fn();
  await expect(
    withLocalApplicationGrant(tomb, approved, app, ["records:write"], action),
  ).rejects.toThrow();
  await expect(
    withLocalApplicationGrant(tomb, approved, "other-app", ["openid"], action),
  ).rejects.toThrow();
  await expect(
    withLocalApplicationGrant(tomb, { ...approved }, app, ["openid"], action),
  ).rejects.toThrow();
  expect(action).not.toHaveBeenCalled();
});

it("refuses self-approval, copied human handles, and person-as-agent substitution", async () => {
  const consumed = await consumedApplicationRequest(
    tomb,
    agentSession,
    request,
    human,
  );
  await expect(
    approveLocalApplication(tomb, agentSession, request, consumed),
  ).rejects.toThrow();
  await expect(
    approveLocalAgentApplication(
      tomb,
      agentSession,
      agentSession,
      request,
      consumed,
    ),
  ).rejects.toThrow();
  await expect(
    approveLocalAgentApplication(
      tomb,
      { ...humanSession },
      agentSession,
      request,
      consumed,
    ),
  ).rejects.toThrow();
  await expect(
    approveLocalAgentApplication(
      tomb,
      humanSession,
      humanSession,
      request,
      consumed,
    ),
  ).rejects.toThrow();
});

it("refuses agent issuance without a bound approval despite valid dual authentication", async () => {
  await expect(
    approveLocalAgentApplication(tomb, humanSession, agentSession, request),
  ).rejects.toThrow();
});

it.each(["organization", "approval", "scope"])(
  "refuses a stored grant whose %s no longer matches consent",
  async (field) => {
    const approved = await grant();
    const records = await readLocalGrantRecords(tomb);
    const record = records.find((row) => row.id === approved.id);
    if (!record) throw new Error("Missing test grant");
    if (field === "organization") record.organizationId = crypto.randomUUID();
    if (field === "approval") record.approval = undefined;
    if (field === "scope") record.scopes.push("records:write");
    await writeLocalGrantRecords(tomb, records);
    const action = vi.fn();
    await expect(
      withLocalApplicationGrant(tomb, approved, app, ["openid"], action),
    ).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  },
);

it("requires an authorized human administrator and current agent membership", async () => {
  await change({
    action: "membership",
    organizationId: org,
    principalId: human,
    role: "member",
  });
  humanSession = await signInLocalIdentity(tomb, human);
  agentSession = await signInAgent();
  await expect(grant()).rejects.toThrow();
});

it("cannot substitute a person approval or another enrolled key for a requested agent", async () => {
  const bound = { ...request, agent: { principalId: agent, keyId: key.keyId } };
  const consumed = await consumedApplicationRequest(
    tomb,
    agentSession,
    bound,
    human,
  );
  await expect(
    approveLocalApplication(tomb, humanSession, bound, consumed),
  ).rejects.toThrow();
  await expect(
    approveLocalAgentApplication(
      tomb,
      humanSession,
      agentSession,
      {
        ...bound,
        agent: { principalId: human, keyId: key.keyId },
      },
      consumed,
    ),
  ).rejects.toThrow();
  await expect(
    approveLocalAgentApplication(
      tomb,
      humanSession,
      agentSession,
      {
        ...bound,
        agent: { principalId: agent, keyId: "k".repeat(43) },
      },
      consumed,
    ),
  ).rejects.toThrow();
});

it.each(["human", "agent", "key", "grant", "human-grant", "membership"])(
  "refuses every use after %s revocation",
  async (target) => {
    const approved = await grant();
    if (target === "human")
      await revokeLocalIdentitySession(tomb, humanSession.id);
    if (target === "agent")
      await revokeLocalIdentitySession(tomb, agentSession.id);
    if (target === "key") await revokeLocalAgentKey(tomb, agent, credentialId);
    if (target === "grant")
      await revokeLocalApplicationGrant(tomb, agentSession, approved.id);
    if (target === "human-grant")
      await revokeLocalApplicationGrant(tomb, humanSession, approved.id);
    if (target === "membership")
      await change({
        action: "membership",
        organizationId: org,
        principalId: agent,
        role: null,
      });
    const action = vi.fn();
    await expect(
      withLocalApplicationGrant(tomb, approved, app, ["records:read"], action),
    ).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  },
);

it("revalidates human authority at redemption and admits only one code winner", async () => {
  const first = await approve();
  const winners = await Promise.allSettled([
    redeem(first.code),
    redeem(first.code),
  ]);
  expect(winners.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  const second = await approve();
  await revokeLocalIdentitySession(tomb, humanSession.id);
  await expect(redeem(second.code)).rejects.toThrow();
});

it("burns a code on failed persistence and refuses stale human approval", async () => {
  const code = await approve();
  vi.spyOn(vfsSeams, "writeRaw").mockRejectedValueOnce(
    new Error("Unavailable storage"),
  );
  await expect(redeem(code.code)).rejects.toThrow();
  await expect(redeem(code.code)).rejects.toThrow();
  vi.spyOn(Date, "now").mockReturnValue(humanSession.authTime + 300_000);
  await expect(grant()).rejects.toThrow();
});

it("exchanges a real agent proof on the exact channel before explicit human consent", async () => {
  await verifyAgentApplicationChannel({
    tomb,
    request,
    key,
    humanSession,
    agent,
    app,
    verifier,
    origin,
  });
});
