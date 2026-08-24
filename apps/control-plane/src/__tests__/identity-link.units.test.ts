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
