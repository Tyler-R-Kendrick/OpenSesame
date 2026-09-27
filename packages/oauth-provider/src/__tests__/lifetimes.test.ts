/**
 * The lifetimes and token policies this provider decided on are the ones
 * oidc-provider's defaults gave, now written down (lifetimes.ts).
 */
import { overlapCast } from "@opensesame/os-domain";
import type { KoaContext } from "oidc-provider";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_LIFETIMES,
  introspectionAllowed,
  revocationAllowed,
} from "../lifetimes.js";

const koa = <T>(value: T): KoaContext => overlapCast(value);
const HOUR = 3600;
const DAY = 24 * HOUR;

describe("ARTIFACT_LIFETIMES", () => {
  it("keeps the lifetimes the library defaulted to", () => {
    expect(ARTIFACT_LIFETIMES.AuthorizationCode).toBe(60);
    expect(ARTIFACT_LIFETIMES.DeviceCode).toBe(600);
    expect(ARTIFACT_LIFETIMES.IdToken).toBe(HOUR);
    expect(ARTIFACT_LIFETIMES.Interaction).toBe(HOUR);
    expect(ARTIFACT_LIFETIMES.Session).toBe(14 * DAY);
    expect(ARTIFACT_LIFETIMES.Grant).toBe(14 * DAY);
  });

  it("gives an access token an hour, or its resource server's own lifetime", () => {
    expect(ARTIFACT_LIFETIMES.AccessToken(koa({}), koa({}))).toBe(HOUR);
    expect(
      ARTIFACT_LIFETIMES.AccessToken(
        koa({}),
        koa({ resourceServer: { accessTokenTTL: 300 } }),
      ),
    ).toBe(300);
  });

  it("never lets an unbound browser refresh token outlive the one it rotated", () => {
    const rotated = koa({
      oidc: { entities: { RotatedRefreshToken: { remainingTTL: 42 } } },
    });
    const browser = koa({ applicationType: "web", clientAuthMethod: "none" });
    const unbound = koa({ isSenderConstrained: () => false });
    const bound = koa({ isSenderConstrained: () => true });

    expect(ARTIFACT_LIFETIMES.RefreshToken(rotated, unbound, browser)).toBe(42);
    expect(ARTIFACT_LIFETIMES.RefreshToken(rotated, bound, browser)).toBe(
      14 * DAY,
    );
    expect(ARTIFACT_LIFETIMES.RefreshToken(koa({}), unbound, browser)).toBe(
      14 * DAY,
    );
  });
});

describe("introspectionAllowed", () => {
  const publicClient = koa({ clientId: "spa", clientAuthMethod: "none" });
  const confidential = koa({
    clientId: "api",
    clientAuthMethod: "client_secret_basic",
  });

  it("lets a public client read only its own tokens", async () => {
    await expect(
      introspectionAllowed(koa({}), publicClient, koa({ clientId: "spa" })),
    ).resolves.toBe(true);
    await expect(
      introspectionAllowed(koa({}), publicClient, koa({ clientId: "other" })),
    ).resolves.toBe(false);
  });

  it("lets a client that authenticates read any token", async () => {
    await expect(
      introspectionAllowed(koa({}), confidential, koa({ clientId: "other" })),
    ).resolves.toBe(true);
  });
});

describe("revocationAllowed", () => {
  it("revokes a client's own token", async () => {
    await expect(
      revocationAllowed(
        koa({}),
        koa({ clientId: "spa", clientAuthMethod: "none" }),
        koa({ clientId: "spa" }),
      ),
    ).resolves.toBe(true);
  });

  it("answers a public client's guess as if it worked, and revokes nothing", async () => {
    await expect(
      revocationAllowed(
        koa({}),
        koa({ clientId: "spa", clientAuthMethod: "none" }),
        koa({ clientId: "other" }),
      ),
    ).resolves.toBe(false);
  });

  it("refuses a client that authenticates outright", async () => {
    await expect(
      revocationAllowed(
        koa({}),
        koa({ clientId: "api", clientAuthMethod: "private_key_jwt" }),
        koa({ clientId: "other" }),
      ),
    ).rejects.toMatchObject({
      message: "invalid_request",
      error_description:
        "client is not authorized to revoke the presented token",
    });
  });
});
