import {
  parseFragmentResponse,
  serializeAuthorizationRequest,
  verifySelfIssuedIdToken,
} from "@opensesame/siop-v2";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureLocalApplication } from "./local-applications.js";
import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";
import {
  type LocalDirectoryChange,
  LocalDirectoryError,
  changeLocalDirectory,
  readLocalDirectory,
} from "./local-directory.js";
import { bindLocalIamLockResets } from "./local-iam-lock-resets.js";
import { enrollLocalPasskey } from "./local-passkeys.js";
import { signInLocalIdentity } from "./local-sessions.js";
import {
  approveSiopAuthorization,
  bindSiopRequest,
  denySiopAuthorization,
  dynamicSiopIssuer,
  parsePagesSiopRequest,
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

  it("builds the dynamic issuer on the Pages identity/siop path", () => {
    expect(
      dynamicSiopIssuer("https://pages.example.test", "/OpenSesame/"),
    ).toBe("https://pages.example.test/OpenSesame/identity/siop");
    expect(dynamicSiopIssuer("https://pages.example.test", "/")).toBe(
      "https://pages.example.test/identity/siop",
    );
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
  });
});
