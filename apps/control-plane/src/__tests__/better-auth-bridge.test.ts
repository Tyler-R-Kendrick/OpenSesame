import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExternalIdentity,
  type Principal,
  overlapCast,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { createControlPlane } from "../create-app.js";
import {
  BetterAuthBridgeError,
  emailIdentityIssuer,
  normalizeEmail,
  principalForBetterAuthSubject,
  upstreamAuthFor,
} from "../services/better-auth-bridge.js";

/**
 * The Better Auth bridge (C20 / D16 / T33).
 *
 * Everything below runs against a real control plane — real memory repositories
 * behind the same interfaces Postgres implements, a real Better Auth instance
 * with its own account store, and the real `attachVerifiedExternalIdentity`
 * chokepoint. The only thing constructed by hand is the Better Auth *subject*,
 * which is the bridge's declared input: `auth-upstream.test.ts` covers the leg
 * that produces one from a link that actually travelled through nodemailer.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** The one field of an npm manifest the import fence below reads. */
type PackageManifest = { dependencies?: Readonly<Record<string, string>> };

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

async function plane(): Promise<AppContext> {
  const { ctx } = createControlPlane({ config: testConfig() });
  await ctx.systemPrincipalReady;
  return ctx;
}

/** What `seedVerifiedPrincipal` needs to stand an existing account up. */
type SeedOptions = {
  email: string;
  issuer: string;
  /** Whether the seeded upstream vouched for the address, or merely carried it. */
  verified: boolean;
};

/**
 * A principal that already exists and already owns a verified email through a
 * different leg entirely — the precondition D15 exists for.
 */
async function seedVerifiedPrincipal(
  ctx: AppContext,
  options: SeedOptions,
): Promise<Principal> {
  const now = ctx.clock();
  const principal: Principal = {
    id: `prn_seed_${Buffer.from(options.email).toString("hex").slice(0, 12)}`,
    state: "active",
    assurance: "verified",
    createdAt: now,
    updatedAt: now,
    verifiedAt: now,
    version: 1,
  };
  await ctx.repos.principals.create(principal);
  const identity: ExternalIdentity = {
    id: `xid_seed_${principal.id}`,
    principalId: principal.id,
    kind: "oidc",
    issuer: options.issuer,
    subject: `upstream-subject-for-${options.email}`,
    assurance: options.verified ? "verified" : "self_asserted",
    linkedAt: now,
    emailNormalized: normalizeEmail(options.email),
    emailVerified: options.verified,
    metadata: {},
  };
  await ctx.repos.externalIdentities.create(identity);
  return principal;
}

describe("principalForBetterAuthSubject", () => {
  it("mints a canonical principal for an address nobody owns yet", async () => {
    const ctx = await plane();
    const email = "first@example.test";

    const session = await principalForBetterAuthSubject(ctx, {
      id: "ba_user_first",
      email,
      emailVerified: true,
    });

    expect(session.principalId).toMatch(/^prn_/);
    expect(session.accessToken).toMatch(/^pst_/);

    const principal = await ctx.repos.principals.getById(session.principalId);
    // Promoted in place by the admission chokepoint: the id a guest would have
    // kept is the id it signs in with.
    expect(principal?.state).toBe("active");
    expect(principal?.assurance).toBe("verified");

    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind: "email",
      issuer: emailIdentityIssuer(ctx),
      subject: email,
    });
    expect(identity?.principalId).toBe(session.principalId);
    expect(identity?.emailVerified).toBe(true);
  });

  it("returns the mapped principal for a Better Auth user it has seen", async () => {
    const ctx = await plane();
    const subject = {
      id: "ba_user_repeat",
      email: "repeat@example.test",
      emailVerified: true,
    };

    const first = await principalForBetterAuthSubject(ctx, subject);
    const second = await principalForBetterAuthSubject(ctx, subject);

    expect(second.principalId).toBe(first.principalId);
    // A fresh bearer each time; the principal is what is stable.
    expect(second.accessToken).not.toBe(first.accessToken);
  });

  it("re-finds the principal when Better Auth hands it a brand-new user id", async () => {
    // Better Auth's user store is an implementation detail and may be rebuilt
    // underneath a durable principal. The email identity tuple is what carries
    // the account across that, not the mapping row.
    const ctx = await plane();
    const email = "rebuilt@example.test";

    const first = await principalForBetterAuthSubject(ctx, {
      id: "ba_user_old",
      email,
      emailVerified: true,
    });
    const second = await principalForBetterAuthSubject(ctx, {
      id: "ba_user_new",
      email,
      emailVerified: true,
    });

    expect(second.principalId).toBe(first.principalId);
    expect(
      (
        await ctx.repos.betterAuthSubjects.getByBetterAuthUserId("ba_user_new")
      )?.principalId,
    ).toBe(first.principalId);
  });

  it("attaches to the principal that already owns the verified email (D15)", async () => {
    const ctx = await plane();
    const email = "shared@example.test";
    const owner = await seedVerifiedPrincipal(ctx, {
      email,
      issuer: "https://upstream.example",
      verified: true,
    });

    const session = await principalForBetterAuthSubject(ctx, {
      id: "ba_user_shared",
      email,
      emailVerified: true,
    });

    // The whole point: no duplicate account for the same human.
    expect(session.principalId).toBe(owner.id);
    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind: "email",
      issuer: emailIdentityIssuer(ctx),
      subject: email,
    });
    expect(identity?.principalId).toBe(owner.id);
    // The bearer names the principal that owns the address, never the throwaway
    // that was minted a moment earlier on the way here.
    const sessionId = ctx.stores.provisionalTokens.get(session.accessToken);
    expect(
      sessionId && ctx.stores.provisionalSessions.get(sessionId)?.principalId,
    ).toBe(owner.id);
  });

  it("does not attach to a principal whose email is merely asserted", async () => {
    const ctx = await plane();
    const email = "unverified-owner@example.test";
    const owner = await seedVerifiedPrincipal(ctx, {
      email,
      issuer: "https://upstream.example",
      verified: false,
    });

    const session = await principalForBetterAuthSubject(ctx, {
      id: "ba_user_unverified_owner",
      email,
      emailVerified: true,
    });

    expect(session.principalId).not.toBe(owner.id);
  });

  it("refuses a subject that carries no verified address", async () => {
    const ctx = await plane();

    await expect(
      principalForBetterAuthSubject(ctx, {
        id: "ba_user_unverified",
        email: "typed-in@example.test",
        emailVerified: false,
      }),
    ).rejects.toMatchObject({ code: "unverified_email" });

    await expect(
      principalForBetterAuthSubject(ctx, { id: "ba_user_anonymous" }),
    ).rejects.toBeInstanceOf(BetterAuthBridgeError);

    // Nothing was minted on the way to the refusal.
    expect(
      await ctx.repos.externalIdentities.findByTuple({
        kind: "email",
        issuer: emailIdentityIssuer(ctx),
        subject: "typed-in@example.test",
      }),
    ).toBeNull();
  });

  it("refuses to sign in a principal that is not active", async () => {
    const ctx = await plane();
    const subject = {
      id: "ba_user_suspended",
      email: "suspended@example.test",
      emailVerified: true,
    };
    const first = await principalForBetterAuthSubject(ctx, subject);
    const principal = await ctx.repos.principals.getById(first.principalId);
    await ctx.repos.principals.update(
      first.principalId,
      { state: "suspended", updatedAt: ctx.clock() },
      principal?.version ?? 1,
    );

    await expect(
      principalForBetterAuthSubject(ctx, subject),
    ).rejects.toMatchObject({ code: "principal_unavailable" });
  });

  it("normalizes the address it matches and stores on", async () => {
    const ctx = await plane();

    const first = await principalForBetterAuthSubject(ctx, {
      id: "ba_case_a",
      email: "Mixed.Case@Example.Test",
      emailVerified: true,
    });
    const second = await principalForBetterAuthSubject(ctx, {
      id: "ba_case_b",
      email: "  mixed.case@example.test  ",
      emailVerified: true,
    });

    expect(second.principalId).toBe(first.principalId);
  });
});

describe("canonical identity never leaks a Better Auth user id (T33)", () => {
  it("keeps the Better Auth id in the mapping table and nowhere else", async () => {
    const ctx = await plane();
    const betterAuthUserId = "ba_user_leak_probe";
    const email = "leak-probe@example.test";

    const session = await principalForBetterAuthSubject(ctx, {
      id: betterAuthUserId,
      email,
      emailVerified: true,
    });

    // The mapping is the bridge...
    expect(
      (
        await ctx.repos.betterAuthSubjects.getByBetterAuthUserId(
          betterAuthUserId,
        )
      )?.principalId,
    ).toBe(session.principalId);
    // ...and the id itself is not the principal, not the session, and not on
    // the identity row that admission wrote.
    expect(session.principalId).not.toBe(betterAuthUserId);
    expect(session.accessToken).not.toContain(betterAuthUserId);
    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind: "email",
      issuer: emailIdentityIssuer(ctx),
      subject: email,
    });
    expect(JSON.stringify(identity)).not.toContain(betterAuthUserId);

    // Nor is it anywhere in the audit trail this admission produced.
    const events = await ctx.repos.auditEvents.list({ limit: 200 });
    expect(JSON.stringify(events)).not.toContain(betterAuthUserId);
    expect(
      events.some(
        (event) =>
          event.eventType === "principal.identity_linked" &&
          event.metadata?.via === "email_magic_link",
      ),
    ).toBe(true);
  });

  it("keeps os-domain free of Better Auth", () => {
    // The import fence in AGENTS.md, checked rather than assumed:
    // `packages/auth-upstream` is the only importer, so os-domain — which every
    // plane depends on — cannot acquire Better Auth's types or its user model.
    const domainRoot = join(here, "../../../../packages/os-domain");
    // SAFETY: an npm manifest; only its optional `dependencies` map is read.
    const manifest: PackageManifest = overlapCast(
      JSON.parse(readFileSync(join(domainRoot, "package.json"), "utf8")),
    );
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(
      "better-auth",
    );

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = readFileSync(full, "utf8");
        if (/from\s+["']better-auth/.test(source)) offenders.push(full);
      }
    };
    walk(join(domainRoot, "src"));
    expect(offenders).toEqual([]);
  });
});

describe("the Better Auth mount is one instance per control plane", () => {
  it("memoizes the bundle so a requested link can be verified", async () => {
    const ctx = await plane();
    expect(upstreamAuthFor(ctx)).toBe(upstreamAuthFor(ctx));
    expect(upstreamAuthFor(ctx).signInMethods).toEqual(["magic-link"]);
    // Social is not merely unconfigured here — it is not expressible: the
    // registry owns social because Better Auth drops secret-less brokers (T22).
    expect(upstreamAuthFor(ctx).auth.options.socialProviders ?? {}).toEqual({});
    expect(upstreamAuthFor(ctx).auth.options.emailAndPassword?.enabled).toBe(
      false,
    );
  });

  it("gives two control planes two account stores", async () => {
    const a = await plane();
    const b = await plane();
    expect(upstreamAuthFor(a)).not.toBe(upstreamAuthFor(b));
  });
});
