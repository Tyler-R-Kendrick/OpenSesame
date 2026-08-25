import { ConflictError } from "@opensesame/database";
import type {
  AuditEvent,
  ExternalIdentity,
  Principal,
} from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";

/**
 * Atomic unit tests for the one function that decides whether an upstream
 * identity may attach to a principal.
 *
 * Both the hosted-login relying-party leg and the agent-facing
 * POST /v1/principals/link-identities route funnel through here, so a mistake
 * is a mistake on every federated surface at once. The route-level suites
 * exercise the happy path; these pin the branches that only appear when
 * something is already there — an identity bound to this principal, an
 * identity bound to *another* principal, and the race where two requests both
 * pass the lookup and one loses at the insert.
 *
 * The last one matters more than it looks: `findByTuple` and `create` are not
 * atomic together, so the unique index on (kind, issuer, tenant, subject) is
 * the real fence. If a ConflictError were allowed to escape as a 500, a
 * concurrent double sign-in would look like a server fault instead of the
 * collision it is.
 */

const NOW = new Date("2026-08-22T12:00:00.000Z");

type Fakes = {
  ctx: AppContext;
  identities: ExternalIdentity[];
  principals: Map<string, Principal>;
  audits: { eventType: string; outcome: string }[];
  auditEvents: AuditEvent[];
  created: ExternalIdentity[];
  updates: { id: string; patch: PrincipalPatch }[];
  createImpl: (identity: ExternalIdentity) => Promise<ExternalIdentity>;
};

/**
 * The verified-email index, resolved exactly as `ExternalIdentityRepository`
 * does (`packages/database`): only rows whose assurance is `verified` and
 * whose `emailVerified` is not explicitly false are candidates, and when
 * several match, the oldest owning principal wins with the principal id as the
 * tie-break. `email_normalized` is deliberately non-unique in the schema, so
 * that ordering is the contract rather than an accident of insertion (T32).
 */
function verifiedEmailOwner(
  state: Fakes,
  emailNormalized: string,
): ExternalIdentity | null {
  const candidates = state.identities
    .filter(
      (e) =>
        e.emailNormalized === emailNormalized &&
        e.assurance === "verified" &&
        e.emailVerified !== false,
    )
    .flatMap((row) => {
      const owner = state.principals.get(row.principalId);
      return owner ? [{ row, owner }] : [];
    })
    .sort((a, b) => {
      const byAge = a.owner.createdAt.getTime() - b.owner.createdAt.getTime();
      if (byAge !== 0) return byAge;
      return a.owner.id.localeCompare(b.owner.id);
    });
  return candidates[0]?.row ?? null;
}

type PrincipalPatch = Parameters<
  AppContext["repos"]["principals"]["update"]
>[1];

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: "prn_1",
    state: "provisional",
    assurance: "provisional",
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function identity(overrides: Partial<ExternalIdentity> = {}): ExternalIdentity {
  return {
    id: "xid_existing",
    principalId: "prn_1",
    kind: "oidc",
    issuer: "https://shoo.dev",
    subject: "sub-1",
    assurance: "verified",
    linkedAt: NOW,
    metadata: {},
    ...overrides,
  };
}

function makeFakes(): Fakes {
  const state: Fakes = {
    identities: [],
    principals: new Map([["prn_1", principal()]]),
    audits: [],
    auditEvents: [],
    created: [],
    updates: [],
    createImpl: async (record) => record,
    ctx: overlapCast({}),
  };

  state.ctx = overlapCast({
    clock: () => NOW,
    repos: {
      externalIdentities: {
        // Honours `kind` as the real repository does: the unique index is
        // (kind, issuer, tenant, subject), so a lookup that ignored the kind
        // would let an OIDC identity collide with a non-OIDC one that happens
        // to share an issuer and subject.
        findByTuple: async (q: {
          kind: string;
          issuer: string;
          subject: string;
        }) =>
          state.identities.find(
            (e) =>
              e.kind === q.kind &&
              e.issuer === q.issuer &&
              e.subject === q.subject,
          ) ?? null,
        listByEmailNormalized: async (email: string) =>
          state.identities.filter((e) => e.emailNormalized === email),
        findVerifiedByEmail: async (email: string) =>
          verifiedEmailOwner(state, email),
        create: async (record: ExternalIdentity) => {
          const stored = await state.createImpl(record);
          state.created.push(stored);
          state.identities.push(stored);
          return stored;
        },
      },
      principals: {
        getById: async (id: string) => state.principals.get(id) ?? null,
        update: async (id: string, patch: PrincipalPatch, _version: number) => {
          state.updates.push({ id, patch });
          return state.principals.get(id) ?? null;
        },
      },
      auditEvents: {
        append: async (event: AuditEvent) => {
          state.audits.push({
            eventType: event.eventType,
            outcome: event.outcome,
          });
          state.auditEvents.push(event);
          return event;
        },
      },
    },
  });

  return state;
}

const INPUT = {
  issuer: "https://shoo.dev",
  subject: "sub-1",
  correlationId: "corr-1",
};

let f: Fakes;

beforeEach(() => {
  f = makeFakes();
});

describe("attaching an identity nobody holds yet", () => {
  it("links it and promotes a provisional principal in place", async () => {
    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);

    expect(result).toMatchObject({ ok: true, alreadyLinked: false });
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({
      kind: "oidc",
      issuer: "https://shoo.dev",
      subject: "sub-1",
      assurance: "verified",
      principalId: "prn_1",
    });
    // Promoted in place — the id the guest already had is the id they keep.
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]?.id).toBe("prn_1");
    expect(f.updates[0]?.patch).toMatchObject({
      state: "active",
      assurance: "verified",
    });
  });

  it("leaves an already-active principal's state alone", async () => {
    f.principals.set(
      "prn_1",
      principal({ state: "active", assurance: "verified" }),
    );

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);

    expect(result.ok).toBe(true);
    // Nothing to promote; re-writing state here would churn the version column
    // and could clobber a concurrent update.
    expect(f.updates).toHaveLength(0);
  });

  it("records the display claims it was given", async () => {
    await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      displayHint: "Test Person",
      emailNormalized: "person@example.com",
      emailVerified: true,
    });

    expect(f.created[0]).toMatchObject({
      displayHint: "Test Person",
      emailNormalized: "person@example.com",
      emailVerified: true,
    });
  });
});

describe("attaching an identity that already exists", () => {
  it("is idempotent when this principal already owns it", async () => {
    f.identities.push(identity({ principalId: "prn_1" }));

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);

    expect(result).toMatchObject({ ok: true, alreadyLinked: true });
    // No second row, and no principal churn.
    expect(f.created).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it("refuses when another principal owns it", async () => {
    f.identities.push(identity({ principalId: "prn_someone_else" }));

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toBe("identity_collision");
    expect(f.created).toHaveLength(0);
  });

  it("does not name the principal that holds it", async () => {
    // Echoing the owning principal id would let any caller enumerate which
    // principal owns an upstream identity, one guess at a time.
    f.identities.push(identity({ principalId: "prn_someone_else" }));

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);

    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).not.toContain("prn_someone_else");
  });
});

describe("losing the insert race", () => {
  it("reports a collision rather than a server fault", async () => {
    // findByTuple and create are not atomic together, so the unique index is
    // the real fence: two concurrent sign-ins can both pass the lookup.
    f.createImpl = async () => {
      throw new ConflictError("external identity already exists");
    };

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toBe("identity_collision");
    // The principal must not have been promoted on a link that never landed.
    expect(f.updates).toHaveLength(0);
  });

  it("lets an unrelated storage failure escape", async () => {
    // A dead database is not a collision. Swallowing it here would report
    // "that account is already taken" for an outage.
    f.createImpl = async () => {
      throw new Error("connection terminated");
    };

    await expect(
      attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT),
    ).rejects.toThrow(/connection terminated/);
  });
});

describe("email is evidence, never a join key", () => {
  it("audits a same-email peer on another principal, and links anyway", async () => {
    f.identities.push(
      identity({
        id: "xid_other",
        principalId: "prn_someone_else",
        subject: "a-different-subject",
        emailNormalized: "person@example.com",
      }),
    );

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: "person@example.com",
    });

    // Linked by (issuer, subject) regardless — an upstream asserting an email
    // it does not control must never take over an existing principal.
    expect(result.ok).toBe(true);
    expect(f.created).toHaveLength(1);
    // ...but a human can see it happened.
    expect(f.audits).toContainEqual({
      eventType: "principal.identity_link_email_collision",
      outcome: "denied",
    });
  });

  it("does not audit when the same principal already used that email", async () => {
    f.identities.push(
      identity({
        id: "xid_mine",
        principalId: "prn_1",
        subject: "a-different-subject",
        emailNormalized: "person@example.com",
      }),
    );

    await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: "person@example.com",
    });

    expect(
      f.audits.filter(
        (a) => a.eventType === "principal.identity_link_email_collision",
      ),
    ).toHaveLength(0);
  });

  it("does not look for peers when no email was supplied", async () => {
    const spy = vi.spyOn(
      f.ctx.repos.externalIdentities,
      "listByEmailNormalized",
    );

    await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);

    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * The audit trail is evidence, and evidence is only useful if its content is
 * exact. These pin the event type, outcome, target and metadata that a human
 * or a compliance export will actually read — a linked identity whose audit
 * row says nothing in particular is an unexplained privilege change.
 */
describe("what the audit trail records", () => {
  it("records a successful link with the fields an investigator needs", async () => {
    f.audits = [];
    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);
    if (!result.ok) throw new Error("expected a link");

    expect(f.auditEvents).toHaveLength(1);
    expect(f.auditEvents[0]).toMatchObject({
      eventType: "principal.identity_linked",
      outcome: "succeeded",
      principalId: "prn_1",
      targetType: "external_identity",
      targetId: result.identity.id,
      correlationId: "corr-1",
      metadata: {
        action: "principal.link_identity",
        kind: "oidc",
        issuer: "https://shoo.dev",
        via: "id_token",
      },
    });
  });

  it("records the email collision as denied, and says why it was ignored", async () => {
    f.identities.push(
      identity({
        id: "xid_other",
        principalId: "prn_someone_else",
        subject: "another-subject",
        emailNormalized: "person@example.com",
      }),
    );
    f.auditEvents = [];

    await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: "person@example.com",
    });

    const denied = f.auditEvents.find((e) => e.outcome === "denied");
    expect(denied).toMatchObject({
      eventType: "principal.identity_link_email_collision",
      outcome: "denied",
      principalId: "prn_1",
      correlationId: "corr-1",
      metadata: {
        action: "principal.link_identity",
        note: "email_not_used_for_link",
      },
    });
  });
});

describe("the shape of the row that gets written", () => {
  it("writes kind oidc, not some other scheme", async () => {
    await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);
    expect(f.created[0]?.kind).toBe("oidc");
  });

  it("omits display fields entirely rather than storing undefined", async () => {
    // A conditional spread forced always-on would write `displayHint:
    // undefined`, which reads back as a column that was set to nothing rather
    // than one that was never supplied.
    await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);
    const keys = Object.keys(f.created[0] ?? {});
    expect(keys).not.toContain("displayHint");
    expect(keys).not.toContain("emailNormalized");
    expect(keys).not.toContain("emailVerified");
  });

  it("keeps each display field independent of the others", async () => {
    await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: "person@example.com",
    });
    const keys = Object.keys(f.created[0] ?? {});
    expect(keys).toContain("emailNormalized");
    expect(keys).not.toContain("displayHint");
    expect(keys).not.toContain("emailVerified");
  });

  it("names the collision in words a user can act on", async () => {
    f.identities.push(identity({ principalId: "prn_someone_else" }));
    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toBe(
      "External identity already bound to another principal; merge requires dual authentication",
    );
  });
});

describe("which principals get promoted", () => {
  it.each([
    ["assurance and state both provisional", "provisional", "provisional"],
    ["only the assurance still provisional", "provisional", "active"],
    ["only the state still provisional", "verified", "provisional"],
  ] as const)("promotes when %s", async (_label, assurance, state) => {
    // Either half being provisional means the principal is not yet durable.
    // Requiring both would strand a half-migrated record as permanently
    // unpromotable.
    f.principals.set("prn_1", principal({ assurance, state }));

    await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);

    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]?.patch).toMatchObject({
      state: "active",
      assurance: "verified",
    });
  });

  it("leaves a principal that is durable on both counts untouched", async () => {
    f.principals.set(
      "prn_1",
      principal({ assurance: "verified", state: "active" }),
    );
    await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);
    expect(f.updates).toHaveLength(0);
  });

  it("tolerates a principal that has vanished between lookup and promotion", async () => {
    f.principals.clear();
    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);
    expect(result.ok).toBe(true);
    expect(f.updates).toHaveLength(0);
  });
});

describe("the lookup is scoped by identity kind", () => {
  it("does not treat a different-kind identity as the same one", async () => {
    // The unique index is (kind, issuer, tenant, subject). A SAML assertion
    // from the same issuer naming the same subject is a different identity,
    // and must not be mistaken for a collision with the OIDC one.
    f.identities.push(
      identity({
        id: "xid_saml",
        principalId: "prn_someone_else",
        kind: "saml",
      }),
    );

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);

    expect(result.ok).toBe(true);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]?.kind).toBe("oidc");
  });
});

/**
 * `kind` widened from a hardcoded "oidc" to an input (C5), because every
 * admission leg now lands here. It is load-bearing twice over: the unique
 * index is (kind, issuer, tenant, subject), so the lookup kind decides what
 * counts as the same identity, and the stored kind is what a later sign-in
 * through the same leg will look itself up by. A default that drifted from the
 * stored value would make a returning user look brand new.
 */
describe("which identity kind is used", () => {
  it("looks the tuple up under the kind it was given", async () => {
    const spy = vi.spyOn(f.ctx.repos.externalIdentities, "findByTuple");

    await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      kind: "oauth2",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "oauth2" }),
    );
    expect(f.created[0]?.kind).toBe("oauth2");
  });

  it("looks the tuple up as oidc when no kind is given", async () => {
    const spy = vi.spyOn(f.ctx.repos.externalIdentities, "findByTuple");

    await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ kind: "oidc" }));
    expect(f.created[0]?.kind).toBe("oidc");
  });

  it("does not collide an oauth2 subject with the oidc row of the same name", async () => {
    // GitHub's numeric id and an OIDC `sub` are different namespaces even when
    // the issuer string matches; treating them as one identity would hand one
    // user's account to another.
    f.identities.push(identity({ principalId: "prn_someone_else" }));

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      kind: "oauth2",
    });

    expect(result.ok).toBe(true);
    expect(f.created[0]?.kind).toBe("oauth2");
  });

  it.each([
    [undefined, "id_token"],
    ["oidc", "id_token"],
    ["oauth2", "userinfo"],
    ["saml", "saml_assertion"],
    ["ldap", "ldap_bind"],
    ["email", "email_magic_link"],
  ] as const)("records via %s as %s in the audit trail", async (kind, via) => {
    // What vouched for the subject is the difference between a verified
    // admission and a self-asserted one, and it is not reconstructable later.
    await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      ...(kind !== undefined ? { kind } : undefined),
    });

    const linked = f.auditEvents.find(
      (e) => e.eventType === "principal.identity_linked",
    );
    expect(linked?.metadata).toMatchObject({ via });
  });
});

describe("provenance metadata on the identity row", () => {
  it("stores what the leg supplied", async () => {
    await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      kind: "saml",
      metadata: { nameIdFormat: "persistent" },
    });

    expect(f.created[0]?.metadata).toEqual({ nameIdFormat: "persistent" });
  });

  it("stores an empty object when the leg supplied none", async () => {
    await attachVerifiedExternalIdentity(f.ctx, "prn_1", INPUT);
    expect(f.created[0]?.metadata).toEqual({});
  });
});

/**
 * The verified-email auto-link (D15 / ADR 0057).
 *
 * This is the branch that can hand one human's principal to another, so each
 * case below is a security case, not a convenience case. The rule: a match is
 * consulted ONLY when this sign-in itself asserts the email as verified, and
 * only against identities the store already holds as verified.
 */
describe("linking by a verified email", () => {
  const OWNER = "prn_owner";
  const EMAIL = "person@example.com";

  function seedOwner(overrides: Partial<Principal> = {}): void {
    f.principals.set(
      OWNER,
      principal({
        id: OWNER,
        state: "active",
        assurance: "verified",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        ...overrides,
      }),
    );
    f.identities.push(
      identity({
        id: "xid_owner",
        principalId: OWNER,
        issuer: "https://accounts.google.com",
        subject: "google-sub",
        emailNormalized: EMAIL,
        emailVerified: true,
      }),
    );
  }

  it("attaches the new identity to the principal that already owns the address", async () => {
    seedOwner();

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      kind: "oauth2",
      emailNormalized: EMAIL,
      emailVerified: true,
    });

    if (!result.ok) throw new Error("expected a link");
    // The caller passed prn_1; the row belongs to the human who was already here.
    expect(result.identity.principalId).toBe(OWNER);
    expect(f.created[0]?.principalId).toBe(OWNER);
  });

  it("refuses to link an email this sign-in did not verify", async () => {
    // The whole takeover path: an upstream that lets a user type any address.
    seedOwner();

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: EMAIL,
      emailVerified: false,
    });

    if (!result.ok) throw new Error("expected a link");
    expect(result.identity.principalId).toBe("prn_1");
    expect(
      f.audits.filter((a) => a.eventType === "principal.identity_email_linked"),
    ).toHaveLength(0);
    // Unchanged from before ADR 0057: audited as evidence, ignored as a key.
    expect(f.audits).toContainEqual({
      eventType: "principal.identity_link_email_collision",
      outcome: "denied",
    });
  });

  it("refuses to link an email whose verification nobody asserted", async () => {
    seedOwner();

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: EMAIL,
    });

    if (!result.ok) throw new Error("expected a link");
    expect(result.identity.principalId).toBe("prn_1");
  });

  it("mints against the caller when no principal owns the address", async () => {
    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: "nobody@example.com",
      emailVerified: true,
    });

    if (!result.ok) throw new Error("expected a link");
    expect(result.identity.principalId).toBe("prn_1");
  });

  it("never asks the index when there is no address to ask about", async () => {
    const spy = vi.spyOn(f.ctx.repos.externalIdentities, "findVerifiedByEmail");

    await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailVerified: true,
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it("is not a link when the caller already owns the address", async () => {
    f.identities.push(
      identity({
        id: "xid_mine",
        principalId: "prn_1",
        subject: "an-earlier-subject",
        emailNormalized: EMAIL,
        emailVerified: true,
      }),
    );

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      subject: "a-newer-subject",
      emailNormalized: EMAIL,
      emailVerified: true,
    });

    if (!result.ok) throw new Error("expected a link");
    expect(result.identity.principalId).toBe("prn_1");
    // Nothing moved, so there is nothing to explain.
    expect(
      f.audits.filter((a) => a.eventType === "principal.identity_email_linked"),
    ).toHaveLength(0);
  });

  it("skips the email-collision audit when the address did the linking", async () => {
    // The old event says "email_not_used_for_link". Emitting it on a sign-in
    // that linked BY email would make the trail say the opposite of what
    // happened.
    seedOwner();

    await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: EMAIL,
      emailVerified: true,
    });

    expect(
      f.audits.filter(
        (a) => a.eventType === "principal.identity_link_email_collision",
      ),
    ).toHaveLength(0);
  });

  it("promotes the owning principal when it is still provisional", async () => {
    seedOwner({ state: "provisional", assurance: "provisional" });

    await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: EMAIL,
      emailVerified: true,
    });

    expect(f.updates).toHaveLength(1);
    // The owner is promoted; the caller's own principal is left alone.
    expect(f.updates[0]?.id).toBe(OWNER);
    expect(f.updates[0]?.patch).toMatchObject({
      state: "active",
      assurance: "verified",
    });
  });

  it("takes the owner the index names when several principals share the address", async () => {
    // `email_normalized` is deliberately non-unique, so duplicates are a real
    // pre-existing state; the answer must be the same one every time.
    f.principals.set(
      "prn_newer",
      principal({
        id: "prn_newer",
        state: "active",
        assurance: "verified",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );
    f.identities.push(
      identity({
        id: "xid_newer",
        principalId: "prn_newer",
        issuer: "https://later.example",
        subject: "later-sub",
        emailNormalized: EMAIL,
        emailVerified: true,
      }),
    );
    seedOwner();

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: EMAIL,
      emailVerified: true,
    });

    if (!result.ok) throw new Error("expected a link");
    expect(result.identity.principalId).toBe(OWNER);
  });

  it("audits both ends of the join under one correlation id", async () => {
    seedOwner();

    await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      kind: "oauth2",
      emailNormalized: EMAIL,
      emailVerified: true,
    });

    const emailLinked = f.auditEvents.find(
      (e) => e.eventType === "principal.identity_email_linked",
    );
    expect(emailLinked).toMatchObject({
      outcome: "succeeded",
      principalId: OWNER,
      targetType: "external_identity",
      targetId: f.created[0]?.id,
      correlationId: "corr-1",
      metadata: {
        action: "principal.link_identity",
        // The identity that ALREADY held the address...
        kind: "oidc",
        issuer: "https://accounts.google.com",
        via: "userinfo",
        note: "matched_verified_email",
      },
    });

    const linked = f.auditEvents.find(
      (e) => e.eventType === "principal.identity_linked",
    );
    // ...and the one that just arrived, on the same correlation id.
    expect(linked).toMatchObject({
      principalId: OWNER,
      correlationId: "corr-1",
      metadata: { kind: "oauth2", issuer: "https://shoo.dev", via: "userinfo" },
    });
  });
});
