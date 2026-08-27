import { randomUUID } from "node:crypto";
import type {
  AuthenticationApplication,
  AuthenticationServiceStores,
} from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMemoryAuthenticationServiceStores,
  createPostgresAuthenticationServiceStores,
} from "../src/authentication-service-store.js";
import type { Repositories } from "../src/repos/interfaces.js";
import { MemoryRepositories } from "../src/repos/memory.js";
import { makePrincipal } from "./factories.js";
import { createPgTestContext } from "./pg-harness-full.js";

type Backend = {
  repos: Repositories;
  stores: AuthenticationServiceStores;
  restart(): AuthenticationServiceStores;
  close(): Promise<void>;
};

async function memoryBackend(): Promise<Backend> {
  const stores = createMemoryAuthenticationServiceStores();
  return {
    repos: new MemoryRepositories(),
    stores,
    restart: () => stores,
    close: async () => {},
  };
}

async function postgresBackend(): Promise<Backend> {
  const ctx = await createPgTestContext();
  return {
    repos: ctx.repos,
    stores: createPostgresAuthenticationServiceStores(ctx.db),
    restart: () => createPostgresAuthenticationServiceStores(ctx.db),
    close: () => ctx.client.close(),
  };
}

describe.each([
  { name: "memory", create: memoryBackend },
  { name: "postgres", create: postgresBackend },
])("$name authentication service storage", ({ create }) => {
  let backend: Backend;
  let application: AuthenticationApplication;
  const now = new Date("2026-08-26T12:00:00.000Z");

  beforeAll(async () => {
    backend = await create();
    const owner = makePrincipal({ id: `prn_auth_${randomUUID()}` });
    await backend.repos.principals.create(owner);
    application = {
      id: `authapp_${randomUUID()}`,
      ownerPrincipalId: owner.id,
      displayName: "Example",
      rpId: "example.com",
      origins: ["https://login.example.com"],
      secretHash: "secret-hash",
      secretPrefix: "osa_example",
      apiKeys: [],
      configurations: [],
      manualTokensEnabled: false,
      magicLinksEnabled: false,
      state: "active",
      createdAt: now,
      updatedAt: now,
    };
    await backend.stores.applications.create(application);
  }, 60_000);

  afterAll(async () => backend.close());

  it("atomically completes registration and survives a store restart", async () => {
    const tokenHash = `registration-${randomUUID()}`;
    await backend.stores.oneTime.registration.create({
      tokenHash,
      applicationId: application.id,
      userId: "user-1",
      userName: "Ada",
      displayName: "Ada Lovelace",
      aliases: ["ada@example.com"],
      aliasHashing: false,
      userVerification: "required",
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const completed = await backend.stores.completeRegistration({
      tokenHash,
      now,
      user: {
        applicationId: application.id,
        userId: "user-1",
        userName: "Ada",
        displayName: "Ada Lovelace",
        createdAt: now,
        updatedAt: now,
      },
      aliases: ["ada@example.com"],
      credential: {
        applicationId: application.id,
        credentialId: "credential-1",
        userId: "user-1",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 1,
        transports: ["internal"],
        createdAt: now,
        updatedAt: now,
      },
    });
    expect(completed).toBe(true);
    expect(
      await backend.stores.completeRegistration({
        tokenHash,
        now,
        user: {
          applicationId: application.id,
          userId: "user-1",
          userName: "Ada",
          displayName: "Ada Lovelace",
          createdAt: now,
          updatedAt: now,
        },
        aliases: ["ada@example.com"],
        credential: {
          applicationId: application.id,
          credentialId: "credential-replay",
          userId: "user-1",
          publicKey: new Uint8Array([9]),
          counter: 0,
          transports: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    ).toBe(false);

    const restarted = backend.restart();
    expect(await restarted.applications.get(application.id)).toMatchObject({
      id: application.id,
      rpId: "example.com",
    });
    expect(
      await restarted.users.findByAlias(application.id, "ada@example.com"),
    ).toMatchObject({ userId: "user-1" });
    expect(
      await restarted.credentials.get(application.id, "credential-1"),
    ).toMatchObject({ counter: 1, transports: ["internal"] });
  });

  it("consumes challenges and sign-in tokens exactly once", async () => {
    const challenge = `challenge-${randomUUID()}`;
    await backend.stores.oneTime.challenges.create({
      challenge,
      applicationId: application.id,
      purpose: "authentication",
      origin: "https://login.example.com",
      userId: "user-1",
      requireUserVerification: true,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const challenges = await Promise.all(
      Array.from({ length: 8 }, () =>
        backend.stores.oneTime.challenges.consume(challenge, now),
      ),
    );
    expect(challenges.filter(Boolean)).toHaveLength(1);

    const tokenHash = `signin-${randomUUID()}`;
    await backend.stores.oneTime.signin.create({
      tokenHash,
      applicationId: application.id,
      userId: "user-1",
      purpose: "sign-in",
      type: "passkey",
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () =>
        backend.stores.oneTime.signin.consume(tokenHash, now),
      ),
    );
    expect(tokens.filter(Boolean)).toHaveLength(1);
  });

  it("advances signature counters with compare-and-swap", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        backend.stores.credentials.recordUse(
          application.id,
          "credential-1",
          1,
          2,
          new Date(now.getTime() + 1_000),
        ),
      ),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(
      await backend.stores.credentials.get(application.id, "credential-1"),
    ).toMatchObject({ counter: 2 });
  });
});
