/**
 * A quorum request carried as an Interaction (ADR 0187, ADR 0086), against the
 * real interaction machine, the real digest function, the real wire schemas
 * and real ledger verdicts from a circle with virtual security keys. How the
 * interaction follows the ledger is in `interaction.settle.test.ts`.
 */
import {
  AuthorizationDetailSchema,
  CreateInteractionSchema,
} from "@opensesame/contracts";
import {
  type AuthorizationDetail,
  type Interaction,
  type JsonObject,
  assertAuthorizationDetails,
  deriveBindingMessage,
  interactionMachine,
  overlapCast,
} from "@opensesame/os-domain";
import { beforeAll, describe, expect, it } from "vitest";
import { toB64url } from "./bytes.js";
import { generateKeyPair } from "./hpke.js";
import { quorumDigestOf, requestToInteraction } from "./interaction.js";
import {
  type Harness,
  ZERO,
  codeOf,
  harness,
} from "./interaction.test-support.js";
import { PolicyError } from "./policy.js";
import { RequestError, createRequest, requestDigest } from "./request.js";
import { OPERATIONS } from "./types.js";
import { buildWorld } from "./world.test-support.js";

let h: Harness;

beforeAll(async () => {
  h = await harness();
});

describe("a request as an interaction", () => {
  it("fronts it: pending, the request's window, one detail that carries the quorum digest", () => {
    const { request, interaction } = h.open();
    expect(interaction).toMatchObject({
      kind: "authorization_request",
      status: "pending",
      version: 1,
      subject: {
        kind: "authorization_request",
        subjectId: `quorum:${request.requestId}`,
      },
      createdAt: new Date(request.createdAt),
      expiresAt: new Date(request.expiresAt),
      assuranceRequired: {
        subjectKind: "human",
        requirePhishingResistance: true,
        requireUserVerification: true,
      },
    });
    expect(interaction.approverPrincipalId).toBeUndefined();
    expect(interaction.approvalProof).toBeUndefined();
    expect(interaction.id).not.toContain(request.requestId);
    expect(quorumDigestOf(interaction)).toBe(requestDigest(request));
  });

  it("computes D_i over its own fields, and D_i is not D_q", () => {
    const { request, interaction } = h.open();
    expect(interaction.requestDigest).toBe(h.redigest(interaction));
    expect(interaction.requestDigest).not.toBe(requestDigest(request));
  });

  it("passes the real validators and wire schemas", () => {
    const { interaction: i } = h.open();
    const details: AuthorizationDetail[] = overlapCast(i.authorizationDetails);
    expect(() => assertAuthorizationDetails(details)).not.toThrow();
    expect(i.bindingMessage).toBe(deriveBindingMessage(details));
    expect(AuthorizationDetailSchema.parse(details[0])).toMatchObject({
      type: "quorum_request",
    });
    expect(h.wire(i).requestDigest).toBe(i.requestDigest);
    expect(() =>
      CreateInteractionSchema.parse({
        kind: i.kind,
        subject: i.subject,
        approverRef: `quorum-circle:${h.world.circleId}`,
        authorizationDetails: i.authorizationDetails,
        ttlSeconds: 3600,
      }),
    ).not.toThrow();
  });

  it.each(OPERATIONS)("fronts %s with its release rule stated", (operation) => {
    const { interaction } = h.open(operation);
    const rule =
      operation === "recover-collection"
        ? "guardian-devices-after-delay"
        : "none";
    expect(interaction.authorizationDetails[0]).toMatchObject({
      actions: [operation],
      releaseRule: rule,
    });
    expect(interaction.bindingMessage).toBe(`${operation} on Emergency`);
  });

  it("refuses a request that lies about its sentence, timings or circle", () => {
    const { request, signedPolicy } = h.open();
    const later = new Date(Date.parse(request.approveBy) + 1000).toISOString();
    const lies = [
      { summary: "Release nothing." },
      { approveBy: later },
      { circleId: "other" },
    ];
    for (const lie of lies) {
      expect(() =>
        requestToInteraction({ signedPolicy, request: { ...request, ...lie } }),
      ).toThrow(RequestError);
    }
  });

  it("states in the interaction whether the circle asks for user verification", async () => {
    const touch = await buildWorld({
      names: ["Ada"],
      groups: [{ id: "g", threshold: 1, members: ["Ada"] }],
      operations: ["export-items"],
      requireUserVerification: false,
    });
    const signedPolicy = touch.created.signedPolicy;
    const request = createRequest({
      signedPolicy,
      operation: "export-items",
      recipientPublicKey: toB64url(generateKeyPair().publicKey),
      recipientLabel: "Laptop",
      now: new Date(),
    });
    const { assuranceRequired } = requestToInteraction({
      signedPolicy,
      request,
    });
    expect(assuranceRequired).toMatchObject({ requireUserVerification: false });
  });

  it("refuses a policy the owner did not sign", () => {
    const { request, signedPolicy } = h.open();
    const flipped = signedPolicy.signature.replace(/^./, (c) =>
      c === "A" ? "B" : "A",
    );
    expect(() =>
      requestToInteraction({
        signedPolicy: { ...signedPolicy, signature: flipped },
        request,
      }),
    ).toThrow(PolicyError);
  });

  it("gives each interaction its own random id unless one is named", () => {
    const { request, signedPolicy } = h.open();
    const a = requestToInteraction({ signedPolicy, request });
    const b = requestToInteraction({ signedPolicy, request });
    expect(a.id).not.toBe(b.id);
    const named = requestToInteraction({ signedPolicy, request, id: "mine" });
    expect(named.id).toBe("mine");
  });
});

describe("an approval as a proof", () => {
  it("maps an accepted approval to a record bound to D_i, naming the guardian", async () => {
    const o = h.open();
    const approval = await h.approveOne(o, "Ada");
    const proof = h.proofOf(o, o.interaction, approval);
    expect(proof).toEqual({
      mechanism: "webauthn",
      boundDigest: o.interaction.requestDigest,
      credentialRef: expect.stringMatching(/^g-ada\/[0-9a-f]{16}$/),
      assurance: "phishing_resistant",
      verifiedAt: o.at.date(),
    });
    expect(proof.boundDigest).not.toBe(approval.requestDigest);
  });

  it("cannot turn an approval for request A into a proof for interaction B", async () => {
    const a = h.open();
    const b = h.open();
    const forA = await h.approveOne(a, "Ada");
    await h.approveOne(b, "Ada");
    expect(codeOf(() => h.proofOf(b, b.interaction, forA))).toBe("digest");
    const vA = a.ledger.verdict();
    expect(codeOf(() => h.proofOf(b, b.interaction, forA, vA))).toBe("verdict");
    expect(codeOf(() => h.proofOf(a, b.interaction, forA))).toBe("request");
    expect(codeOf(() => h.settle(b, b.interaction, vA))).toBe("verdict");
  });

  it("refuses an approval the ledger did not accept, forged fields, and non-approvals", async () => {
    const o = h.open();
    const unsubmitted = await h.approveOne(o, "Ben", false);
    expect(codeOf(() => h.proofOf(o, o.interaction, unsubmitted))).toBe(
      "not_accepted",
    );
    const accepted = await h.approveOne(o, "Ada");
    const forged = [
      { boundDigest: o.interaction.requestDigest },
      { assurance: "phishing_resistant" },
      { mechanism: "webauthn" },
    ];
    for (const extra of forged) {
      const approval = { ...accepted, ...extra };
      expect(codeOf(() => h.proofOf(o, o.interaction, approval))).toBe(
        "approval",
      );
    }
    expect(codeOf(() => h.proofOf(o, o.interaction, {}))).toBe("approval");
  });

  it("is not a sealed proof, so one guardian's approval cannot approve the interaction", async () => {
    const o = h.open();
    const proof = h.proofOf(o, o.interaction, await h.approveOne(o, "Ada"));
    const misuse = () =>
      interactionMachine.approve(o.interaction, {
        approverPrincipalId: "quorum-circle:x",
        now: o.at.date(),
        // @ts-expect-error a recorded approval is not a SealedApprovalProof
        proof,
      });
    expect(misuse).toBeInstanceOf(Function);
  });
});

const detailWith = (i: Interaction, patch: JsonObject): Interaction => ({
  ...i,
  authorizationDetails: [{ ...i.authorizationDetails[0], ...patch }],
});

const protoKey: JsonObject = overlapCast(JSON.parse('{"__proto__":{"x":1}}'));

type Alteration = [name: string, alter: (i: Interaction) => Interaction];

const ALTERATIONS: Alteration[] = [
  [
    "the carried quorum digest",
    (i) => detailWith(i, { quorumRequestDigest: ZERO }),
  ],
  [
    "the sentence",
    (i) => detailWith(i, { summary: "Release nothing at all." }),
  ],
  ["the circle", (i) => detailWith(i, { circleId: "other" })],
  [
    "the delay",
    (i) => detailWith(i, { releaseNotBefore: i.createdAt.toISOString() }),
  ],
  ["an added detail key", (i) => detailWith(i, { note: "x" })],
  [
    "a second detail",
    (i) => ({
      ...i,
      authorizationDetails: [...i.authorizationDetails, { type: "x" }],
    }),
  ],
  [
    "the window",
    (i) => ({ ...i, expiresAt: new Date(i.expiresAt.getTime() + 1000) }),
  ],
  ["the requester", (i) => ({ ...i, requesterRef: "quorum-recipient:aaaa" })],
  [
    "the binding message",
    (i) => ({ ...i, bindingMessage: "approve a payment" }),
  ],
  ["the digest", (i) => ({ ...i, requestDigest: ZERO })],
  ["the digest, removed", (i) => ({ ...i, requestDigest: undefined })],
  ["the resource", (i) => ({ ...i, resourceRef: "vault" })],
  ["the kind", (i) => ({ ...i, kind: "transaction_authorization" })],
  [
    "the subject",
    (i) => ({ ...i, subject: { ...i.subject, subjectId: "quorum:other" } }),
  ],
];

describe("an interaction is checked, not trusted", () => {
  it.each(ALTERATIONS)("refuses one whose %s was altered", (_name, alter) => {
    const altered = alter(h.open().interaction);
    expect(["shape", "digest"]).toContain(
      codeOf(() => quorumDigestOf(altered)),
    );
  });

  // An attacker who recomputes D_i over the altered fields gets an envelope
  // that is consistent with itself; it still is not what the request makes.
  it.each(ALTERATIONS.filter(([name]) => !name.startsWith("the digest")))(
    "refuses one whose %s was altered and whose digest was recomputed",
    (_name, alter) => {
      const o = h.open();
      const altered = alter(o.interaction);
      const forged = { ...altered, requestDigest: h.redigest(altered) };
      expect(["shape", "digest", "request"]).toContain(
        codeOf(() => h.settle(o, forged)),
      );
    },
  );

  it("sees a recomputed digest over an altered sentence, subject or detail shape for what it is", () => {
    const o = h.open();
    const cases: [Interaction, string][] = [
      [{ ...o.interaction, bindingMessage: "approve a payment" }, "digest"],
      [
        {
          ...o.interaction,
          subject: { ...o.interaction.subject, subjectId: "quorum:other" },
        },
        "shape",
      ],
      [detailWith(o.interaction, { note: "x" }), "shape"],
      // The key a browser `canonicalize` would drop from the hash while a
      // reader still sees it: the closed detail has no room for it.
      [detailWith(o.interaction, protoKey), "shape"],
      [
        {
          ...o.interaction,
          authorizationDetails: [
            ...o.interaction.authorizationDetails,
            { type: "x" },
          ],
        },
        "shape",
      ],
    ];
    for (const [altered, code] of cases) {
      const forged = { ...altered, requestDigest: h.redigest(altered) };
      expect(codeOf(() => quorumDigestOf(forged))).toBe(code);
    }
  });

  it("refuses a self-consistent envelope that shows another sentence over the real digest", () => {
    const o = h.open();
    const shown = detailWith(o.interaction, { summary: "Export nothing." });
    const forged: Interaction = {
      ...shown,
      requestDigest: h.redigest(shown),
    };
    expect(quorumDigestOf(forged)).toBe(requestDigest(o.request));
    expect(codeOf(() => h.settle(o, forged))).toBe("request");
  });
});
