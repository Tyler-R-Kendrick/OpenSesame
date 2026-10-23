import {
  parseFragmentResponse,
  serializeAuthorizationRequest,
  verifySelfIssuedIdToken,
} from "@opensesame/siop-v2";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listReceipts } from "./device-receipts.js";
import { configureLocalApplication } from "./local-applications.js";
import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";
import { changeLocalDirectory } from "./local-directory-admin.js";
import {
  type LocalDirectoryChange,
  LocalDirectoryError,
  readLocalDirectory,
} from "./local-directory.js";
import { bindLocalIamLockResets } from "./local-iam-lock-resets.js";
import { enrollLocalPasskey } from "./local-passkeys.js";
import { signInLocalIdentity } from "./local-sessions.js";
import {
  approveSiopAuthorization,
  approveSiopAuthorizationWithSocial,
  bindSiopRequest,
  denySiopAuthorization,
  parsePagesSiopRequest,
  recordSiopDenial,
  siopIssuerProfile,
} from "./siop-authority.js";
import { ensureSiopKey } from "./siop-keys.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

describe("siop-authority", () => {
  let tomb: string;
  let person: string;
  let org: string;
  let app: string;
  const redirect = "https://rp.example.test/callback";
  const fixedNow = 1_788_998_400;

  async function change(command: LocalDirectoryChange) {
    return changeLocalDirectory(
      tomb,
      (await readLocalDirectory(tomb)).revision,
      command,
    );
  }

  async function create(
    kind: "person" | "application" | "organization",
    name: string,
  ) {
    const directory = await change({ action: "create", kind, name });
    const entry = directory.entries.find((row) => row.name === name);
    if (!entry) throw new Error("Missing fixture identity");
    return entry.id;
  }

  function siopSearch() {
    return `?${serializeAuthorizationRequest({
      clientId: app,
      redirectUri: redirect,
      nonce: "n-0S6_WzA2Mj",
      scope: "openid",
      responseType: "id_token",
      responseMode: "fragment",
      state: "state-1",
    })}`;
  }

  /**
   * The lock resets local IAM's evidence depends on are bound by
   * `identity.local-iam`'s `activate`, not at module load (ownership.md §4.3).
   * This suite binds the same ones the capability does, so a lock drops
   * unspent evidence here exactly as it does with the capability approved.
   */
  let unbindLockResets: () => void;
  beforeEach(async () => {
    unbindLockResets = bindLocalIamLockResets();
    vi.spyOn(Date, "now").mockReturnValue(fixedNow * 1000);
    tomb = `siop-authority-${crypto.randomUUID()}`;
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    const tails = new Map<string, Promise<void>>();
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("location", { origin, hostname: rpID });
    vi.stubGlobal("navigator", {
      credentials: await authenticator(),
      locks: {
        request: async <T>(name: string, run: () => Promise<T>) => {
          // Per-name queues: nested distinct locks must not deadlock (Web Locks).
          const previous = tails.get(name) ?? Promise.resolve();
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          tails.set(
            name,
            previous
              .then(() => gate)
              .then(
                () => undefined,
                () => undefined,
              ),
          );
          await previous;
          try {
            return await run();
          } finally {
            release();
          }
        },
      },
    });
    person = await create("person", "Owner");
    org = await create("organization", "Organization");
    app = await create("application", "Application");
    await change({
      action: "membership",
      principalId: person,
      organizationId: org,
      role: "owner",
    });
    await configureLocalApplication(tomb, 0, app, {
      applicationId: app,
      organizationId: org,
      redirectUris: [redirect],
      scopes: ["openid"],
    });
    await enrollLocalPasskey(tomb, person);
  });

  afterEach(() => {
    unbindLockResets();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    lockAllTombs();
  });

  it("binds SIOP requests to registered local applications", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    const bound = await bindSiopRequest(tomb, request);
    expect(bound.application.applicationId).toBe(app);
    expect(bound.request.clientId).toBe(app);
    await expect(
      bindSiopRequest(tomb, {
        ...request,
        redirectUri: "https://rp.example.test/other",
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it("approves with passkey session and returns a verifiable fragment redirect", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    const session = await signInLocalIdentity(tomb, person);
    let admissions = 0;
    const { redirectUrl, identity } = await approveSiopAuthorization(
      tomb,
      session,
      request,
      {
        nowSeconds: () => fixedNow,
        requireAdmission: async (...args) => {
          admissions += 1;
          const { requireLocalApplicationAdmission } = await import(
            "./local-applications.js"
          );
          return requireLocalApplicationAdmission(...args);
        },
      },
    );
    expect(admissions).toBe(2);
    expect(identity.applicationId).toBe(app);
    expect(identity.subjectId).toBe(person);
    // Egress: redirect fragment must never carry private JWK material.
    expect(redirectUrl).not.toMatch(/"d"\s*:/);
    expect(redirectUrl).not.toContain("privateJwk");
    expect(JSON.stringify(identity)).not.toMatch(/"d"\s*:/);

    const parsed = parseFragmentResponse(redirectUrl);
    expect(parsed.kind).toBe("success");
    if (parsed.kind !== "success") return;
    expect(parsed.idToken).not.toMatch(/"d"\s*:/);
    const verified = await verifySelfIssuedIdToken({
      idToken: parsed.idToken,
      expectedAudience: app,
      expectedNonce: request.nonce,
      profile: siopIssuerProfile(),
      nowSeconds: fixedNow + 5,
    });
    expect(verified.sub).toBe(identity.keyId);
    expect(parsed.state).toBe("state-1");
  });

  it("approves a hosted identity provider social proof without a passkey", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    // The social leg is additional evidence for the person this tab has
    // already authenticated; it never selects a different local person.
    await signInLocalIdentity(tomb, person);
    const proof = {
      source: "identity" as const,
      providerId: "github",
      label: "GitHub",
      personId: person,
      at: fixedNow * 1000,
      upstreamId: "broker:github",
    };
    const { identity } = await approveSiopAuthorizationWithSocial(
      tomb,
      proof,
      request,
      {
        nowSeconds: () => fixedNow,
        socialSession: () => ({
          upstreamId: "broker:github",
          expiresAt: fixedNow * 1000 + 60_000,
        }),
      },
    );
    expect(identity.subjectId).toBe(person);
    expect(identity.applicationId).toBe(app);
    expect((await listReceipts(tomb, 10))[0]?.eventType).toBe(
      "access.siop.approved",
    );
  });

  it("approves an active configured connection social proof", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    await signInLocalIdentity(tomb, person);
    const proof = {
      source: "connection" as const,
      providerId: "github",
      label: "GitHub · owner",
      personId: person,
      at: fixedNow * 1000,
      connectionId: "conn_github",
    };
    const { identity } = await approveSiopAuthorizationWithSocial(
      tomb,
      proof,
      request,
      {
        nowSeconds: () => fixedNow,
        socialConnection: async () => ({
          providerId: "github",
          status: "active",
        }),
      },
    );
    expect(identity.subjectId).toBe(person);
  });

  it("refuses a social proof for another person or an expired upstream", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    await signInLocalIdentity(tomb, person);
    const proof = {
      source: "identity" as const,
      providerId: "github",
      label: "GitHub",
      personId: person,
      at: fixedNow * 1000,
      upstreamId: "broker:github",
    };
    await expect(
      approveSiopAuthorizationWithSocial(
        tomb,
        { ...proof, personId: "someone-else" },
        request,
        {
          socialSession: () => ({
            upstreamId: "broker:github",
            expiresAt: fixedNow * 1000 + 60_000,
          }),
        },
      ),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      approveSiopAuthorizationWithSocial(tomb, proof, request, {
        socialSession: () => ({
          upstreamId: "broker:github",
          expiresAt: fixedNow * 1000 - 1,
        }),
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it("refuses social proof when the selected person has no live local session", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    const proof = {
      source: "identity" as const,
      providerId: "github",
      label: "GitHub",
      personId: person,
      at: fixedNow * 1000,
      upstreamId: "broker:github",
    };
    await expect(
      approveSiopAuthorizationWithSocial(tomb, proof, request, {
        socialSession: () => ({
          upstreamId: "broker:github",
          expiresAt: fixedNow * 1000 + 60_000,
        }),
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it("refuses social proof for a person other than the tab's actor", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    const other = await create("person", "Other");
    const proof = {
      source: "connection" as const,
      providerId: "github",
      label: "GitHub · owner",
      personId: other,
      at: fixedNow * 1000,
      connectionId: "conn_github",
    };
    await signInLocalIdentity(tomb, person);
    await expect(
      approveSiopAuthorizationWithSocial(tomb, proof, request, {
        socialConnection: async () => ({
          providerId: "github",
          status: "active",
        }),
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it("refuses non-passkey sessions and denies with an OAuth error fragment", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    const session = await signInLocalIdentity(tomb, person);
    await expect(
      approveSiopAuthorization(
        tomb,
        { ...session, authentication: "agent_key" },
        request,
      ),
    ).rejects.toThrow(/unavailable/i);

    const url = denySiopAuthorization(request);
    const parsed = parseFragmentResponse(url);
    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") {
      expect(parsed.error).toBe("access_denied");
      expect(parsed.state).toBe("state-1");
    }
  });

  it("accepts an ensureKey seam without private material leakage", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    const session = await signInLocalIdentity(tomb, person);
    const seeded = await ensureSiopKey(tomb, person, app);
    let ensureCalls = 0;
    const { identity } = await approveSiopAuthorization(
      tomb,
      session,
      request,
      {
        nowSeconds: () => fixedNow,
        ensureKey: async (...args) => {
          ensureCalls += 1;
          const { ensureSiopKeyInDirectoryFence } = await import(
            "./siop-keys.js"
          );
          const next = await ensureSiopKeyInDirectoryFence(...args);
          expect(JSON.stringify(next)).not.toMatch(/"d"/);
          return next;
        },
      },
    );
    expect(ensureCalls).toBe(1);
    expect(identity.keyId).toBe(seeded.keyId);
  });

  it("refuses approval when the vault locks mid-ceremony", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    const session = await signInLocalIdentity(tomb, person);
    await expect(
      approveSiopAuthorization(tomb, session, request, {
        ensureKey: async (...args) => {
          const { ensureSiopKeyInDirectoryFence } = await import(
            "./siop-keys.js"
          );
          const next = await ensureSiopKeyInDirectoryFence(...args);
          vaultStore.lock();
          return next;
        },
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it("refuses when admission fails on the pre-mint revalidation", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    const session = await signInLocalIdentity(tomb, person);
    let admissionCalls = 0;
    await expect(
      approveSiopAuthorization(tomb, session, request, {
        requireAdmission: async (...args) => {
          admissionCalls += 1;
          if (admissionCalls >= 2) {
            throw new LocalDirectoryError("Admission no longer holds.");
          }
          const { requireLocalApplicationAdmission } = await import(
            "./local-applications.js"
          );
          return requireLocalApplicationAdmission(...args);
        },
      }),
    ).rejects.toThrow(/Admission no longer holds|unavailable/i);
    expect(admissionCalls).toBeGreaterThanOrEqual(2);
    // A sign-in that was refused by the ceremony left no approval receipt.
    expect(await listReceipts(tomb, 10)).toEqual([]);
  });

  it("writes a receipt for an approval and for a refusal, naming ids only", async () => {
    const request = parsePagesSiopRequest(siopSearch());
    const session = await signInLocalIdentity(tomb, person);
    await approveSiopAuthorization(tomb, session, request, {
      nowSeconds: () => fixedNow,
    });
    await recordSiopDenial(tomb, request);
    const receipts = await listReceipts(tomb, 10);
    expect(receipts.map((row) => [row.eventType, row.outcome])).toEqual([
      ["access.siop.denied", "denied"],
      ["access.siop.approved", "succeeded"],
    ]);
    const approved = receipts[1];
    expect(approved?.metadata).toMatchObject({
      targetType: "application",
      targetId: app,
      subject: person,
    });
    // The callback, the nonce and the state belong to the relying party's
    // request, not to the trail.
    expect(JSON.stringify(receipts)).not.toContain(redirect);
    expect(JSON.stringify(receipts)).not.toContain("state-1");
  });
});
