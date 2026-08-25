/**
 * Durable consent reuse (`loadExistingGrant`): the session grant still wins,
 * `prompt=consent` always prompts, a widened scope request falls through to
 * the consent page, and only a full subset match materialises a grant.
 */

import { describe, expect, it, vi } from "vitest";
import { createLoadExistingGrant } from "./create-provider.js";

type FakeGrant = {
  accountId: string;
  clientId: string;
  scopes: string[];
  claims: string[];
  saved: boolean;
};

function fakeCtx(options: {
  scope?: string;
  accountId?: string;
  clientId?: string;
  sessionGrantId?: string;
  prompts?: string[];
}) {
  const created: FakeGrant[] = [];
  class Grant {
    accountId: string;
    clientId: string;
    scopes: string[] = [];
    claims: string[] = [];
    saved = false;
    constructor(args: { accountId: string; clientId: string }) {
      this.accountId = args.accountId;
      this.clientId = args.clientId;
      created.push(this as unknown as FakeGrant);
    }
    addOIDCScope(scope: string) {
      this.scopes.push(scope);
    }
    addOIDCClaims(claims: string[]) {
      this.claims.push(...claims);
    }
    async save() {
      this.saved = true;
      return "grant-id";
    }
    static found = { fromSession: true };
    static async find(_id: string) {
      return Grant.found;
    }
  }
  const prompts = new Set(options.prompts ?? []);
  const ctx = {
    oidc: {
      session: {
        accountId: options.accountId ?? "prn_1",
        grantIdFor: () => options.sessionGrantId,
      },
      client: { clientId: options.clientId ?? "app-1" },
      params: { scope: options.scope ?? "openid profile" },
      prompts: { has: (name: string) => prompts.has(name) },
      provider: { Grant },
    },
  };
  return { ctx, created, Grant };
}

describe("createLoadExistingGrant", () => {
  it("prefers the session's own grant, untouched", async () => {
    const lookup = vi.fn();
    const { ctx, Grant } = fakeCtx({ sessionGrantId: "g-1" });

    const grant = await createLoadExistingGrant(lookup)(ctx);

    expect(grant).toBe(Grant.found);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("materialises a grant from a stored consent that covers the request", async () => {
    const lookup = vi.fn(async () => ({
      scopes: ["openid", "profile"],
      claims: ["email_verified"],
    }));
    const { ctx, created } = fakeCtx({ scope: "openid profile" });

    const grant = await createLoadExistingGrant(lookup)(ctx);

    expect(lookup).toHaveBeenCalledWith("prn_1", "app-1");
    expect(grant).toBeTruthy();
    expect(created[0]).toMatchObject({
      accountId: "prn_1",
      clientId: "app-1",
      scopes: ["openid profile"],
      claims: ["email_verified"],
      saved: true,
    });
  });

  it("falls through when the request asks for a scope outside the stored set", async () => {
    const lookup = vi.fn(async () => ({ scopes: ["openid"], claims: [] }));
    const { ctx, created } = fakeCtx({ scope: "openid offline_access" });

    expect(await createLoadExistingGrant(lookup)(ctx)).toBeUndefined();
    expect(created).toHaveLength(0);
  });

  it("always prompts on an explicit prompt=consent", async () => {
    const lookup = vi.fn(async () => ({
      scopes: ["openid", "profile"],
      claims: [],
    }));
    const { ctx } = fakeCtx({ prompts: ["consent"] });

    expect(await createLoadExistingGrant(lookup)(ctx)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("falls through when no consent is stored", async () => {
    const lookup = vi.fn(async () => null);
    const { ctx, created } = fakeCtx({});

    expect(await createLoadExistingGrant(lookup)(ctx)).toBeUndefined();
    expect(created).toHaveLength(0);
  });
});
