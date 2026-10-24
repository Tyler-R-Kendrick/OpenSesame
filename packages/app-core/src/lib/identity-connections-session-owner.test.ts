import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { configureHost } from "../host.js";
import { createMemoryStorage } from "../memory-storage.js";
import { createTestHost } from "../test-host.js";
import { loopbackProfileEligible } from "./__tests__/loopback-profile.js";
import { fenceLocalSignOut } from "./ambient-auth/generation.js";
import { readFederationSessionJson } from "./federation-session-store.js";
import { clearSession, loadSession } from "./federation.js";
import { guestAuthSeams } from "./guest-auth.js";
import {
  betterAuthFixture,
  email,
  password,
  supabaseFixture,
} from "./identity-connections-session.test-support.js";
import {
  getIdentityConnectionRuntime,
  writeIdentityConnection,
} from "./identity-connections-store.js";
import {
  beginIdentityConnectionSignIn,
  identityConnectionDraft,
  saveIdentityConnection,
} from "./identity-connections.js";
import { identitySeams } from "./identity.js";
import { kvFlush, kvForgetAll } from "./kv.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";

const directFetch = globalThis.fetch;
const cleanups: (() => Promise<void>)[] = [];

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(async () => {
  vi.spyOn(localNetworkFetchSeams, "eligible").mockImplementation(
    loopbackProfileEligible,
  );
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  kvForgetAll();
  configureHost(
    createTestHost({
      storage: { local: createMemoryStorage(), session: createMemoryStorage() },
    }),
  );
  vaultStore.loadActiveProjectScope();
  clearSession();
  vi.spyOn(guestAuthSeams, "adoptFederatedIdentity").mockResolvedValue({
    kind: "local",
  });
  vi.spyOn(guestAuthSeams, "openVaultAfterSignIn").mockResolvedValue(true);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  configureHost(createTestHost());
});

/** Real loopback HTTP transports the existing real Better Auth/JWT fixtures.
 * The Better Auth fixture owns its explicit cookie jar; this is not browser
 * third-party-cookie or production provider acceptance evidence. */
async function provider(protocol: "better-auth" | "supabase") {
  const fixture =
    protocol === "better-auth"
      ? await betterAuthFixture()
      : await supabaseFixture();
  const providerFetch = globalThis.fetch;
  const origin = "baseURL" in fixture ? fixture.baseURL : fixture.draft.baseUrl;
  const upstreamDraft =
    "draft" in fixture
      ? fixture.draft
      : {
          ...identityConnectionDraft("better-auth"),
          baseUrl: `${origin}/api/auth`,
          issuer: origin,
          audience: origin,
        };
  const reached = gate();
  const resume = gate();
  let held = false;
  const server = createServer(async (request, response) => {
    try {
      const path = request.url ?? "/";
      if (held && /\/jwks(?:\.json)?$/.test(path)) {
        reached.release();
        await resume.promise;
      }
      request.setEncoding("utf8");
      let body = "";
      for await (const part of request) body += String(part);
      const init: RequestInit = {
        method: request.method ?? "GET",
        headers: { "Content-Type": "application/json" },
        credentials: protocol === "better-auth" ? "include" : "omit",
      };
      if (body) init.body = body;
      const result = await providerFetch(`${origin}${path}`, init);
      response.writeHead(result.status, {
        "Content-Type": "application/json",
      });
      response.end(await result.text());
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    resume.release();
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  });
  const { port } = z
    .object({ port: z.number().int().positive().max(65535) })
    .parse(server.address());
  const base = `http://127.0.0.1:${port}`;
  const suffix = protocol === "better-auth" ? "/api/auth" : "";
  const draft = {
    ...upstreamDraft,
    baseUrl: `${base}${suffix}`,
    issuer: protocol === "better-auth" ? origin : `${origin}/auth/v1`,
    audience: protocol === "better-auth" ? origin : "authenticated",
    jwksUri: `${base}${suffix || "/auth/v1"}/${
      protocol === "better-auth" ? "jwks" : ".well-known/jwks.json"
    }`,
  };
  // Restore the real network: only the provider server calls the fixture handler.
  vi.stubGlobal("fetch", directFetch);
  const saved = await saveIdentityConnection(draft);
  return {
    saved,
    draft,
    hold: () => {
      held = true;
    },
    reached: reached.promise,
    resume: resume.release,
    requests: fixture.requests,
  };
}

for (const protocol of ["better-auth", "supabase"] as const) {
  it(`${protocol} admits a live-user verified JWT over real HTTP under its original owner`, async () => {
    const current = await provider(protocol);
    await beginIdentityConnectionSignIn(current.saved.connectionId, {
      credentials: { email, password },
    });
    const identity = loadSession();
    expect(identity).toMatchObject({
      upstreamId: `identity:${current.saved.connectionId}`,
      email,
      issuer: current.draft.issuer,
      audience: current.draft.audience,
    });
    expect(identity?.idToken.split(".")).toHaveLength(3);
    expect(guestAuthSeams.adoptFederatedIdentity).toHaveBeenCalledWith(
      identity?.idToken,
    );
    expect(
      current.requests.some((request) =>
        /\/user|get-session/.test(request.url),
      ),
    ).toBe(true);
    expect(readFederationSessionJson()).not.toBeNull();
  });

  for (const transition of [
    "sign-out",
    "actor",
    "lock",
    "new-vault",
    "identical-configuration",
  ] as const) {
    it(`${protocol} refuses a held real HTTP completion after ${transition}`, async () => {
      const current = await provider(protocol);
      const original = getIdentityConnectionRuntime(current.saved.connectionId);
      current.hold();
      const pending = beginIdentityConnectionSignIn(
        current.saved.connectionId,
        { credentials: { email, password } },
      );
      // Attach the rejection assertion before releasing any held server response.
      const refused = expect(pending).rejects.toThrow(/changed|owner/);
      try {
        await current.reached;
        if (transition === "sign-out") {
          fenceLocalSignOut();
          clearSession();
        } else if (transition === "actor") {
          vi.spyOn(identitySeams, "currentSession").mockReturnValue({
            principalId: "different-actor",
            accessToken: "public-synthetic-session-token",
            issuerOrigin: "https://identity.example.test",
          });
        } else if (transition === "lock") {
          vaultStore.lock();
        } else if (transition === "new-vault") {
          await vaultStore.createGuest();
        } else {
          await writeIdentityConnection(
            current.draft,
            current.saved.connectionId,
          );
        }
        if (transition !== "new-vault")
          expect(
            getIdentityConnectionRuntime(current.saved.connectionId),
          ).toEqual(original);
      } finally {
        current.resume();
      }
      await refused;
      expect(loadSession()).toBeNull();
      expect(readFederationSessionJson()).toBeNull();
      expect(guestAuthSeams.adoptFederatedIdentity).not.toHaveBeenCalled();
      expect(guestAuthSeams.openVaultAfterSignIn).not.toHaveBeenCalled();
    });
  }
}
