import { createLocalAgentKey } from "@opensesame/static-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginLocalAgentAuthentication } from "./local-agent-auth.js";
import {
  readLocalAgentKeys,
  registerLocalAgentKey,
  revokeLocalAgentKey,
} from "./local-agent-keys.js";
import { approveLocalApplication } from "./local-authorization.js";
import {
  type LocalDirectoryChange,
  changeLocalDirectory,
  readLocalDirectory,
} from "./local-directory.js";
import {
  changeLocalOrganizationMembership,
  readLocalOrganization,
} from "./local-organizations.js";
import {
  currentLocalIdentitySession,
  revokeLocalIdentitySession,
  signInLocalAgent,
  withLocalIdentitySession,
} from "./local-sessions.js";
import { mintVaultKey } from "./vault/crypto.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, readFile, unlockTomb, vfsSeams } from "./vfs.js";

const origin = "https://iam.example.test";
let tomb: string;
let agent: string;
let owner: string;
let organization: string;
let credentialId: string;
let key: Awaited<ReturnType<typeof createLocalAgentKey>>;
async function change(command: LocalDirectoryChange) {
  return changeLocalDirectory(
    tomb,
    (await readLocalDirectory(tomb)).revision,
    command,
  );
}
async function create(kind: "agent" | "person" | "organization") {
  const directory = await change({ action: "create", kind, name: kind });
  const entry = directory.entries.find((row) => row.kind === kind);
  if (!entry) throw new Error("Missing fixture identity");
  return entry.id;
}
async function signedChallenge() {
  const challenge = await beginLocalAgentAuthentication(
    tomb,
    agent,
    credentialId,
  );
  return {
    challenge,
    proof: await key.signChallenge(challenge, origin, agent),
  };
}
async function signIn() {
  const { challenge, proof } = await signedChallenge();
  return signInLocalAgent(tomb, challenge.nonce, proof);
}
beforeEach(async () => {
  tomb = `agents-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("location", { origin });
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(_name: string, run: () => Promise<T>) => {
        const next = queue.then(run);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  agent = await create("agent");
  owner = await create("person");
  organization = await create("organization");
  await change({
    action: "membership",
    organizationId: organization,
    principalId: owner,
    role: "owner",
  });
  await change({
    action: "membership",
    organizationId: organization,
    principalId: agent,
    role: "member",
  });
  key = await createLocalAgentKey();
  await registerLocalAgentKey(tomb, agent, key.publicKey);
  const enrolled = (await readLocalAgentKeys(tomb))[0];
  if (!enrolled) throw new Error("Missing fixture key");
  credentialId = enrolled.credentialId;
});
afterEach(() => {
  vaultStore.lock();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("vault-local agent authentication", () => {
  it("authenticates an enrolled key and enforces live organization membership", async () => {
    const session = await signIn();
    expect(session.authentication).toBe("agent_key");
    expect(await currentLocalIdentitySession(tomb, agent)).toBe(session);
    expect(
      await readLocalOrganization(tomb, session, organization),
    ).toMatchObject({ id: organization, role: "member" });
    await expect(
      readLocalOrganization(tomb, session, "unrelated"),
    ).rejects.toThrow("unavailable");
    await expect(
      changeLocalOrganizationMembership(
        tomb,
        session,
        organization,
        owner,
        null,
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      approveLocalApplication(tomb, session, {
        applicationId: "local_00000000-0000-4000-8000-000000000001",
        redirectUri: `${origin}/callback`,
        scopes: ["openid"],
        state: "s".repeat(43),
        nonce: "n".repeat(43),
        codeChallenge: "c".repeat(43),
        codeChallengeMethod: "S256",
      }),
    ).rejects.toThrow("unavailable");
    await change({
      action: "membership",
      organizationId: organization,
      principalId: agent,
      role: null,
    });
    await expect(
      readLocalOrganization(tomb, session, organization),
    ).rejects.toThrow("unavailable");
  });

  it("admits one winner for concurrent signatures and refuses copied session handles", async () => {
    const { challenge, proof } = await signedChallenge();
    const results = await Promise.allSettled([
      signInLocalAgent(tomb, challenge.nonce, proof),
      signInLocalAgent(tomb, challenge.nonce, proof),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const result = results.find((row) => row.status === "fulfilled");
    if (!result || result.status !== "fulfilled")
      throw new Error("Missing winning session");
    const action = vi.fn(async () => true);
    await expect(
      withLocalIdentitySession(tomb, { ...result.value }, action),
    ).rejects.toThrow("unavailable");
    expect(action).not.toHaveBeenCalled();
  });

  it("burns an invalid proof attempt without accepting the later valid signature", async () => {
    const { challenge, proof } = await signedChallenge();
    await expect(
      signInLocalAgent(tomb, challenge.nonce, "invalid.signature"),
    ).rejects.toThrow("unavailable");
    await expect(
      signInLocalAgent(tomb, challenge.nonce, proof),
    ).rejects.toThrow("unavailable");
  });

  it.each(["expired", "origin", "disabled", "revoked", "lock"])(
    "refuses a %s challenge",
    async (fault) => {
      const { challenge, proof } = await signedChallenge();
      if (fault === "expired")
        vi.spyOn(Date, "now").mockReturnValue(challenge.expiresAt);
      if (fault === "origin")
        vi.stubGlobal("location", { origin: "https://other.example.test" });
      if (fault === "disabled")
        await change({
          action: "update",
          id: agent,
          name: "agent",
          enabled: false,
        });
      if (fault === "revoked")
        await revokeLocalAgentKey(tomb, agent, credentialId);
      if (fault === "lock") vaultStore.lock();
      await expect(
        signInLocalAgent(tomb, challenge.nonce, proof),
      ).rejects.toThrow();
    },
  );

  it("never resurrects a revoked key's session when the same public key is enrolled again", async () => {
    const session = await signIn();
    await revokeLocalAgentKey(tomb, agent, credentialId);
    await registerLocalAgentKey(tomb, agent, key.publicKey);
    expect((await readLocalAgentKeys(tomb))[0]?.credentialId).not.toBe(
      credentialId,
    );
    await expect(
      withLocalIdentitySession(tomb, session, async () => true),
    ).rejects.toThrow("unavailable");
  });

  it("revokes an agent session and refuses failed session persistence", async () => {
    const session = await signIn();
    await revokeLocalIdentitySession(tomb, session.id);
    expect(await currentLocalIdentitySession(tomb, agent)).toBeNull();
    const { challenge, proof } = await signedChallenge();
    vi.spyOn(vfsSeams, "seal").mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
    await expect(
      signInLocalAgent(tomb, challenge.nonce, proof),
    ).rejects.toThrow("storage unavailable");
    await expect(
      signInLocalAgent(tomb, challenge.nonce, proof),
    ).rejects.toThrow("unavailable");
  });

  it("stores public keys only and refuses enrolling a key for a person or two agents", async () => {
    const stored = new TextDecoder().decode(
      await readFile(tomb, "config/identity-agent-keys"),
    );
    expect(stored).not.toMatch(/private|signChallenge|"d":/);
    await expect(
      registerLocalAgentKey(tomb, owner, key.publicKey),
    ).rejects.toThrow("unavailable");
    await expect(
      registerLocalAgentKey(tomb, agent, key.publicKey),
    ).rejects.toThrow("already enrolled");
    await expect(
      registerLocalAgentKey(tomb, agent, {
        ...key.publicKey,
        d: "private sentinel",
      }),
    ).rejects.toThrow("never a private key");
  });
});
