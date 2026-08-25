import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { appendAuditEvent } from "@opensesame/audit";
import { OrgEmailDomainConflictError } from "@opensesame/database";
import type { Organization } from "@opensesame/os-domain";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";

/**
 * Organization email domains — the storage half of home-realm discovery
 * (C16, D12, ADR 0056).
 *
 * An organization claims `acme.example`, proves it owns the name, and from
 * then on `someone@acme.example` typed into the "work email" field routes to
 * that tenant's sign-in. Claiming is therefore an authority grant over
 * everyone with that address, which is why an unverified claim routes
 * precisely nothing.
 *
 * Proof is a DNS TXT record and **only** a DNS TXT record. The obvious
 * alternative — fetch `https://<domain>/.well-known/…` — would hand an
 * organization owner a server-side request to an arbitrary host, i.e. the SSRF
 * gadget this codebase spends `assertSafeMetadataUrl` avoiding elsewhere (T28).
 * `node:dns/promises` resolves names and dereferences nothing.
 */

/** The TXT record an owner publishes to prove control of a domain. */
export const DOMAIN_VERIFICATION_PREFIX = "opensesame-domain-verify=";

/**
 * The DNS collaborator, isolated so a suite can serve deterministic zones.
 *
 * `*Dependencies` per the repo's seam convention: it holds an imported
 * collaborator, not a wrapper around this module's own exports. There is no
 * "real server" alternative here the way there is for HTTP — the counterparty
 * is the public DNS hierarchy, and a test that resolved a live name would
 * assert on somebody else's zone file.
 */
export const orgDomainDependencies = { resolveTxt };

const ClaimDomainRequestSchema = z.object({
  domain: z.string().min(3).max(253),
});

/** The uniform answer for every failed proof — see {@link verifyDomain}. */
const VERIFICATION_FAILED =
  "The expected TXT record was not found for that domain.";

/**
 * Normalize a claimed domain to the form the store keys on: lowercased, IDNA
 * (punycode) encoded, no trailing dot.
 *
 * `new URL` does the IDNA conversion the WHATWG way, so `münchen.example` and
 * `xn--mnchen-3ya.example` are one domain rather than two claims that never
 * meet. Anything carrying userinfo, a port, a path or a wildcard is not a
 * domain name and is refused rather than silently trimmed into one.
 */
export function normalizeEmailDomain(input: string): string | undefined {
  const candidate = input.trim().toLowerCase().replace(/\.$/, "");
  if (!candidate || candidate.length > 253) return undefined;
  if (/[@/\\:?#\s*]/.test(candidate)) return undefined;
  let hostname: string;
  try {
    hostname = new URL(`https://${candidate}`).hostname;
  } catch {
    return undefined;
  }
  // A single label is a TLD or a hostname on the local search domain; neither
  // is an email domain an organization can own.
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(hostname)) return undefined;
  return hostname;
}

/**
 * Constant-time compare of a published record against the expected one.
 *
 * Digested first so the compare is over fixed-length buffers whatever the
 * zone returned: the token is a secret until it is published, and a length- or
 * prefix-dependent compare would leak it one byte at a time to whoever can ask
 * us to re-check a domain.
 */
function recordMatches(published: string, expected: string): boolean {
  const left = createHash("sha256").update(published).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

async function requireOwner(
  c: Context<{ Variables: Variables }>,
): Promise<
  | { ctx: AppContext; organization: Organization; principalId: string }
  | Response
> {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId") ?? "";
  const organization = await ctx.stores.organizations.get(
    c.req.param("organizationId") ?? "",
  );
  const membership =
    organization &&
    (await ctx.stores.organizationMemberships.find(
      organization.id,
      principalId,
    ));
  if (!organization || organization.state === "deleted" || !membership) {
    return c.json({ error: "not_found" }, 404);
  }
  if (membership.role !== "owner") {
    return c.json({ error: "owner_required" }, 403);
  }
  return { ctx, organization, principalId };
}

function domainResponse(record: {
  domain: string;
  verificationToken: string;
  verifiedAt?: Date;
}) {
  return {
    domain: record.domain,
    txtRecord: `${DOMAIN_VERIFICATION_PREFIX}${record.verificationToken}`,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
  };
}

export function createOrgDomainRoutes(): Hono<{ Variables: Variables }> {
  const routes = new Hono<{ Variables: Variables }>();

  routes.get("/:organizationId/domains", requirePrincipal(), async (c) => {
    const gate = await requireOwner(c);
    if (gate instanceof Response) return gate;
    const { ctx, organization } = gate;
    const domains =
      await ctx.stores.orgFederation.emailDomains.listByOrganization(
        organization.id,
      );
    return c.json({ domains: domains.map(domainResponse) });
  });

  routes.post("/:organizationId/domains", requirePrincipal(), async (c) => {
    const gate = await requireOwner(c);
    if (gate instanceof Response) return gate;
    const { ctx, organization, principalId } = gate;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "validation_error" }, 400);
    }
    const parsed = ClaimDomainRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const domain = normalizeEmailDomain(parsed.data.domain);
    if (!domain) {
      return c.json(
        { error: "validation_error", message: "Not an email domain." },
        400,
      );
    }

    // Re-claiming your own domain re-rolls the token: an owner who lost the
    // value has no other way back, and the old record stops proving anything
    // the moment it is replaced.
    let claimed: Awaited<
      ReturnType<typeof ctx.stores.orgFederation.emailDomains.claim>
    >;
    try {
      claimed = await ctx.stores.orgFederation.emailDomains.claim({
        organizationId: organization.id,
        domain,
        verificationToken: randomBytes(24).toString("base64url"),
      });
    } catch (error) {
      if (error instanceof OrgEmailDomainConflictError) {
        // Deliberately does not name the holder: this route is owner-fenced
        // for the claimant, not for the incumbent.
        return c.json(
          {
            error: "domain_taken",
            message: "That domain is already claimed by another organization.",
          },
          409,
        );
      }
      throw error;
    }

    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.domain_claimed",
      outcome: "succeeded",
      principalId,
      organizationId: organization.id,
      correlationId: c.get("correlationId"),
      targetType: "email_domain",
      targetId: claimed.domain,
      metadata: { action: "organization.domain.claim" },
    });
    return c.json(domainResponse(claimed), 201);
  });

  /**
   * Check the published TXT records for the expected challenge.
   *
   * Every failure — no such record, a record for a different organization's
   * token, a domain with no TXT at all, a resolver error — answers the same
   * 422 with the same sentence. The difference between "you published the
   * wrong token" and "somebody else's token is published here" is exactly the
   * fact this route must not leak.
   */
  routes.post(
    "/:organizationId/domains/:domain/verify",
    requirePrincipal(),
    async (c) => {
      const gate = await requireOwner(c);
      if (gate instanceof Response) return gate;
      const { ctx, organization, principalId } = gate;

      const domain = normalizeEmailDomain(
        decodeURIComponent(c.req.param("domain") ?? ""),
      );
      const record = domain
        ? await ctx.stores.orgFederation.emailDomains.get(domain)
        : null;
      if (!domain || !record || record.organizationId !== organization.id) {
        return c.json({ error: "not_found" }, 404);
      }

      const expected = `${DOMAIN_VERIFICATION_PREFIX}${record.verificationToken}`;
      let published: string[][];
      try {
        published = await orgDomainDependencies.resolveTxt(domain);
      } catch {
        // NXDOMAIN, no TXT records, SERVFAIL: from here they are all "not
        // proven yet".
        return c.json(
          { error: "verification_failed", message: VERIFICATION_FAILED },
          422,
        );
      }
      // A TXT record longer than 255 bytes arrives as multiple chunks that the
      // resolver hands back unjoined; joining is what the DNS spec says the
      // value is.
      const matched = published
        .map((chunks) => chunks.join("").trim())
        .some((value) => recordMatches(value, expected));
      if (!matched) {
        return c.json(
          { error: "verification_failed", message: VERIFICATION_FAILED },
          422,
        );
      }

      const verified = await ctx.stores.orgFederation.emailDomains.markVerified(
        domain,
        ctx.clock(),
      );
      if (!verified) return c.json({ error: "not_found" }, 404);
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "organization.domain_verified",
        outcome: "succeeded",
        principalId,
        organizationId: organization.id,
        correlationId: c.get("correlationId"),
        targetType: "email_domain",
        targetId: verified.domain,
        metadata: { action: "organization.domain.verify" },
      });
      return c.json(domainResponse(verified));
    },
  );

  routes.delete(
    "/:organizationId/domains/:domain",
    requirePrincipal(),
    async (c) => {
      const gate = await requireOwner(c);
      if (gate instanceof Response) return gate;
      const { ctx, organization, principalId } = gate;

      const domain = normalizeEmailDomain(
        decodeURIComponent(c.req.param("domain") ?? ""),
      );
      const removed =
        domain !== undefined &&
        (await ctx.stores.orgFederation.emailDomains.remove(
          organization.id,
          domain,
        ));
      if (!removed) return c.json({ error: "not_found" }, 404);
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "organization.domain_released",
        outcome: "succeeded",
        principalId,
        organizationId: organization.id,
        correlationId: c.get("correlationId"),
        targetType: "email_domain",
        targetId: domain,
        metadata: { action: "organization.domain.release" },
      });
      return c.body(null, 204);
    },
  );

  return routes;
}
