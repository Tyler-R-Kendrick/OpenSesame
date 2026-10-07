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
import { MemoryRepositories } from "../src/repos/memory.js";
import { makePrincipal } from "./factories.js";
import { createPgTestContext } from "./pg-harness-full.js";

describe.each(["memory", "postgres"])("%s authentication expiry", (name) => {
  const now = new Date("2026-08-26T12:00:00Z");
  let stores: AuthenticationServiceStores;
  let application: AuthenticationApplication;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const pg = name === "postgres" ? await createPgTestContext() : undefined;
    const repos = pg?.repos ?? new MemoryRepositories();
    stores = pg
      ? createPostgresAuthenticationServiceStores(pg.db)
      : createMemoryAuthenticationServiceStores();
    close = async () => {
      await pg?.client.close();
    };
    const owner = await repos.principals.create(makePrincipal());
    application = await stores.applications.create({
      id: randomUUID(),
      ownerPrincipalId: owner.id,
      displayName: "Expiry application",
      rpId: "example.com",
      origins: ["https://login.example.com"],
      secretHash: "synthetic-test-hash",
      secretPrefix: "synthetic-test-prefix",
      apiKeys: [],
      configurations: [],
      manualTokensEnabled: false,
      magicLinksEnabled: false,
      state: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
  afterAll(async () => close());

  it("refuses expired one-time material and cleans it before replacement issuance", async () => {
    await stores.users.put(
      {
        applicationId: application.id,
        userId: "user-1",
        userName: "Ada",
        displayName: "Ada",
        createdAt: now,
        updatedAt: now,
      },
      [],
    );
    const tokenHash = `expired-${randomUUID()}`;
    const expired = {
      tokenHash,
      applicationId: application.id,
      userId: "user-1",
      userName: "Ada",
      displayName: "Ada",
      aliases: ["ada@example.com"],
      aliasHashing: true,
      userVerification: "discouraged" as const,
      authenticatorAttachment: "cross-platform" as const,
      expiresAt: now,
    };
    await stores.oneTime.registration.create(expired);
    expect(await stores.oneTime.registration.get(tokenHash)).toMatchObject(
      expired,
    );
    expect(
      await stores.oneTime.registration.consume(tokenHash, now),
    ).toBeUndefined();
    await stores.oneTime.registration.create(
      { ...expired, expiresAt: new Date(now.getTime() + 60_000) },
      now,
    );
    expect(
      await stores.oneTime.registration.consume(tokenHash, now),
    ).toMatchObject({ consumedAt: now });
    expect(
      await stores.oneTime.registration.consume(tokenHash, now),
    ).toBeUndefined();
    const challenge = {
      challenge: tokenHash,
      applicationId: application.id,
      purpose: "registration" as const,
      origin: "https://login.example.com",
      requireUserVerification: false,
      registrationTokenHash: tokenHash,
      expiresAt: now,
    };
    await stores.oneTime.challenges.create(challenge);
    await expect(stores.oneTime.challenges.create(challenge)).rejects.toThrow();
    expect(
      await stores.oneTime.challenges.consume(tokenHash, now),
    ).toBeUndefined();
    await stores.oneTime.challenges.create(
      { ...challenge, expiresAt: new Date(now.getTime() + 60_000) },
      now,
    );
    expect(
      await stores.oneTime.challenges.consume(tokenHash, now),
    ).toMatchObject({ purpose: "registration" });
    const signin = {
      tokenHash,
      applicationId: application.id,
      userId: "user-1",
      purpose: "reauth",
      type: "manual" as const,
      expiresAt: now,
    };
    await stores.oneTime.signin.create(signin);
    await expect(stores.oneTime.signin.create(signin)).rejects.toThrow();
    expect(await stores.oneTime.signin.consume(tokenHash, now)).toBeUndefined();
    await stores.oneTime.signin.create(
      { ...signin, expiresAt: new Date(now.getTime() + 60_000) },
      now,
    );
    expect(await stores.oneTime.signin.consume(tokenHash, now)).toMatchObject({
      type: "manual",
      consumedAt: now,
    });
    expect(await stores.oneTime.signin.consume(tokenHash, now)).toBeUndefined();
  });
});
