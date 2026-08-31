import { describe, expect, it } from "vitest";
import {
  type ApprovalPolicy,
  type ApprovalRiskClass,
  CHANNEL_CAPABILITIES,
  type ExternalChannelBinding,
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
  type NotificationPreference,
  bindingMatchesProviderIdentity,
  channelAuthenticationCeiling,
  channelCapabilities,
  defaultApprovalPolicy,
  evaluateDirectSettlement,
  interactionRank,
  isBindingUsable,
  narrowInteractionMode,
  normalizeApprovalPolicy,
  planNotificationRoute,
} from "../notifications.js";

const NOW = new Date("2026-08-31T12:00:00Z");

/**
 * The channel set is eight members, so these sweep it exhaustively rather
 * than sampling. For a table this size a property that holds for every
 * member is worth more than a generator that probably reaches most of them.
 */
const EVERY_KIND: readonly NotificationChannelKind[] =
  NOTIFICATION_CHANNEL_KINDS;
const EVERY_RISK: readonly ApprovalRiskClass[] = [
  "low",
  "moderate",
  "high",
  "critical",
];

function binding(
  overrides: Partial<ExternalChannelBinding> = {},
): ExternalChannelBinding {
  return {
    id: "cb_1",
    principalId: "prn_owner",
    kind: "slack",
    providerId: "slack",
    providerTenantId: "T_WORKSPACE",
    providerSubjectId: "U_PERSON",
    state: "active",
    verification: "provider_oauth_install",
    createdAt: NOW,
    verifiedAt: NOW,
    metadata: {},
    version: 1,
    ...overrides,
  };
}

function preference(
  channels: NotificationChannelKind[],
  fanOut = false,
): NotificationPreference {
  return { channels, fanOut };
}

describe("channel capabilities", () => {
  it("property: no channel but the in-app ceremony claims phishing resistance", () => {
    // The claim this whole design rests on. An out-of-band message is not a
    // credential bound to an origin, and a preference cannot make it one.
    for (const kind of EVERY_KIND) {
      const caps = channelCapabilities(kind);
      expect(
        caps.canSatisfyPhishingResistance,
        `${kind} must not claim phishing resistance`,
      ).toBe(kind === "in_app");
    }
  });

  it("property: a capability set never claims more than its interaction ceiling", () => {
    for (const kind of EVERY_KIND) {
      const caps = channelCapabilities(kind);
      if (interactionRank(caps.maximumInteractionMode) < interactionRank("interactive")) {
        // Below `interactive` the channel must not advertise the pieces that
        // only an interactive channel can honour.
        expect(caps.canRenderDecisionActions, `${kind}`).toBe(false);
      }
      if (!caps.canReceiveAuthenticatedCallback) {
        expect(caps.supportsTransactionBinding, `${kind}`).toBe(false);
      }
    }
  });

  it("property: the authentication ceiling never exceeds the capability record", () => {
    for (const kind of EVERY_KIND) {
      const caps = channelCapabilities(kind);
      const facts = channelAuthenticationCeiling(kind, NOW);
      expect(facts.phishingResistant).toBe(caps.canSatisfyPhishingResistance);
      expect(facts.userVerification).toBe(caps.maximumUserVerification);
      expect(facts.deviceBinding).toBe(caps.maximumDeviceBinding);
      expect(facts.keyProtection).toBe(caps.maximumKeyProtection);
      // A channel that cannot verify its user must never look verifier-bound.
      expect(facts.verifierNameBound).toBe(false);
    }
  });

  it("contract: narrowing only ever moves down the interaction ladder", () => {
    for (const a of ["none", "notify", "rendezvous", "interactive"] as const) {
      for (const b of ["none", "notify", "rendezvous", "interactive"] as const) {
        const result = narrowInteractionMode(a, b);
        expect(interactionRank(result)).toBeLessThanOrEqual(interactionRank(a));
        expect(interactionRank(result)).toBeLessThanOrEqual(interactionRank(b));
      }
    }
  });

  it("adversarial: the catalogue is frozen against a channel quietly gaining power", () => {
    // A regression fence. If somebody flips one of these, the diff has to say
    // so out loud rather than sliding through as "adapter improvements".
    expect(CHANNEL_CAPABILITIES.sms.canReceiveAuthenticatedCallback).toBe(false);
    expect(CHANNEL_CAPABILITIES.teams.canRenderDecisionActions).toBe(false);
    expect(CHANNEL_CAPABILITIES.wechat.canRenderDecisionActions).toBe(false);
    expect(CHANNEL_CAPABILITIES.native_push.canRenderDecisionActions).toBe(false);
    expect(CHANNEL_CAPABILITIES.webhook.bindsExternalIdentity).toBe(false);
    expect(CHANNEL_CAPABILITIES.webhook.maximumInteractionMode).toBe("notify");
  });
});

describe("policy normalization", () => {
  it("property: direct settlement is never permitted on a channel that cannot settle", () => {
    for (const kind of EVERY_KIND) {
      const policy = normalizeApprovalPolicy({
        ...defaultApprovalPolicy("low"),
        // A hand-written policy that permits everything, everywhere.
        allowedChannels: [...EVERY_KIND],
        directApprovalChannels: [...EVERY_KIND],
        directDenialChannels: [...EVERY_KIND],
      });
      const caps = channelCapabilities(kind);
      const settleable =
        caps.canReceiveAuthenticatedCallback &&
        caps.canRenderDecisionActions &&
        caps.bindsExternalIdentity &&
        caps.supportsTransactionBinding &&
        caps.maximumInteractionMode === "interactive";
      expect(policy.directApprovalChannels.includes(kind), kind).toBe(settleable);
      expect(policy.directDenialChannels.includes(kind), kind).toBe(settleable);
    }
  });

  it("adversarial: a channel not allowed to be notified cannot be allowed to settle", () => {
    const policy = normalizeApprovalPolicy({
      ...defaultApprovalPolicy("low"),
      allowedChannels: ["in_app"],
      directApprovalChannels: ["slack"],
      directDenialChannels: ["slack"],
    });
    expect(policy.directApprovalChannels).toEqual([]);
    expect(policy.directDenialChannels).toEqual([]);
  });

  it("contract: every default policy denies direct external approval", () => {
    for (const risk of EVERY_RISK) {
      const policy = normalizeApprovalPolicy(defaultApprovalPolicy(risk));
      expect(policy.directApprovalChannels, risk).toEqual([]);
      expect(policy.directDenialChannels, risk).toEqual([]);
    }
  });

  it("contract: high and critical demand a transaction-bound activation", () => {
    for (const risk of ["high", "critical"] as const) {
      const policy = defaultApprovalPolicy(risk);
      expect(policy.requireTransactionBoundActivation).toBe(true);
      expect(policy.requiredAssurance.requirePhishingResistance).toBe(true);
    }
    expect(defaultApprovalPolicy("critical").requireComparison).toBe(true);
  });
});

describe("routing", () => {
  it("property: a preference can never widen the policy's channel set", () => {
    // The load-bearing invariant. Ask for every channel under a policy that
    // allows one, and the plan must still contain only that one (plus the
    // in-app inbox, which is not a preference at all).
    for (const allowed of EVERY_KIND) {
      const plan = planNotificationRoute({
        policy: { ...defaultApprovalPolicy("low"), allowedChannels: [allowed] },
        preference: preference([...EVERY_KIND], true),
        bindings: EVERY_KIND.map((kind, i) =>
          binding({ id: `cb_${i}`, kind }),
        ),
        availableChannels: EVERY_KIND,
        now: NOW,
      });
      for (const step of plan.steps) {
        expect(
          step.kind === allowed || step.kind === "in_app",
          `${allowed} policy admitted ${step.kind}`,
        ).toBe(true);
      }
    }
  });

  it("property: adding a channel never raises the confidentiality of another step", () => {
    const base = planNotificationRoute({
      policy: defaultApprovalPolicy("high"),
      preference: preference(["slack"]),
      bindings: [binding()],
      availableChannels: ["slack"],
      now: NOW,
    });
    const widened = planNotificationRoute({
      policy: defaultApprovalPolicy("high"),
      preference: preference(["slack", "telegram", "sms"]),
      bindings: [
        binding(),
        binding({ id: "cb_2", kind: "telegram", providerId: "telegram" }),
        binding({ id: "cb_3", kind: "sms", providerId: "sms" }),
      ],
      availableChannels: ["slack", "telegram", "sms"],
      now: NOW,
    });
    const slackBase = base.steps.find((s) => s.kind === "slack");
    const slackWide = widened.steps.find((s) => s.kind === "slack");
    expect(slackWide?.confidentiality).toBe(slackBase?.confidentiality);
    expect(slackWide?.mode).toBe(slackBase?.mode);
  });

  it("contract: the in-app inbox is always the last resort and always present", () => {
    const plan = planNotificationRoute({
      policy: { ...defaultApprovalPolicy("high"), allowedChannels: [] },
      preference: preference([]),
      bindings: [],
      availableChannels: [],
      now: NOW,
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.kind).toBe("in_app");
    expect(plan.steps[0]?.mode).toBe("interactive");
  });

  it("adversarial: an unconfigured adapter is excluded and says so", () => {
    const plan = planNotificationRoute({
      policy: defaultApprovalPolicy("moderate"),
      preference: preference(["sms", "slack"]),
      bindings: [binding({ id: "cb_sms", kind: "sms", providerId: "sms" })],
      // The operator never configured an SMS bridge.
      availableChannels: ["slack"],
      now: NOW,
    });
    expect(plan.steps.map((s) => s.kind)).not.toContain("sms");
    expect(plan.excluded).toContainEqual({
      kind: "sms",
      reason: "adapter_unavailable",
    });
  });

  it("adversarial: a revoked binding is not a destination", () => {
    const plan = planNotificationRoute({
      policy: defaultApprovalPolicy("moderate"),
      preference: preference(["slack"]),
      bindings: [binding({ state: "revoked", revokedAt: NOW })],
      availableChannels: ["slack"],
      now: NOW,
    });
    expect(plan.steps.map((s) => s.kind)).toEqual(["in_app"]);
    expect(plan.excluded).toContainEqual({
      kind: "slack",
      reason: "no_active_binding",
    });
  });

  it("adversarial: an expired binding is not a destination", () => {
    const expired = binding({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(isBindingUsable(expired, NOW)).toBe(false);
    const plan = planNotificationRoute({
      policy: defaultApprovalPolicy("moderate"),
      preference: preference(["slack"]),
      bindings: [expired],
      availableChannels: ["slack"],
      now: NOW,
    });
    expect(plan.steps.map((s) => s.kind)).toEqual(["in_app"]);
  });

  it("property: a step's mode never exceeds its channel's ceiling", () => {
    const plan = planNotificationRoute({
      policy: {
        ...defaultApprovalPolicy("low"),
        allowedChannels: [...EVERY_KIND],
        directApprovalChannels: [...EVERY_KIND],
      },
      preference: preference([...EVERY_KIND]),
      bindings: EVERY_KIND.map((kind, i) => binding({ id: `cb_${i}`, kind })),
      availableChannels: EVERY_KIND,
      now: NOW,
    });
    for (const step of plan.steps) {
      const ceiling = channelCapabilities(step.kind).maximumInteractionMode;
      expect(
        interactionRank(step.mode),
        `${step.kind} exceeded its ceiling`,
      ).toBeLessThanOrEqual(interactionRank(ceiling));
    }
  });

  it("contract: preference order is the fallback ladder", () => {
    const plan = planNotificationRoute({
      policy: { ...defaultApprovalPolicy("low"), allowedChannels: [...EVERY_KIND] },
      preference: preference(["telegram", "slack"]),
      bindings: [
        binding({ id: "cb_tg", kind: "telegram", providerId: "telegram" }),
        binding({ id: "cb_sl", kind: "slack" }),
      ],
      availableChannels: ["telegram", "slack"],
      now: NOW,
    });
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "telegram",
      "slack",
      "in_app",
    ]);
  });
});

describe("provider identity binding", () => {
  it("adversarial: the right subject in the wrong tenant does not match", () => {
    expect(
      bindingMatchesProviderIdentity(binding(), {
        providerId: "slack",
        providerTenantId: "T_ATTACKER",
        providerSubjectId: "U_PERSON",
      }),
    ).toBe(false);
  });

  it("adversarial: the wrong subject in the right tenant does not match", () => {
    expect(
      bindingMatchesProviderIdentity(binding(), {
        providerId: "slack",
        providerTenantId: "T_WORKSPACE",
        providerSubjectId: "U_SOMEONE_ELSE",
      }),
    ).toBe(false);
  });

  it("adversarial: an empty subject never matches, even against an empty stored one", () => {
    // Otherwise a provider that omits the field authenticates as everyone
    // whose binding also happens to lack it.
    expect(
      bindingMatchesProviderIdentity(binding({ providerSubjectId: "" }), {
        providerId: "slack",
        providerTenantId: "T_WORKSPACE",
        providerSubjectId: "",
      }),
    ).toBe(false);
  });
});

describe("direct settlement", () => {
  const permissive: ApprovalPolicy = {
    ...defaultApprovalPolicy("low"),
    allowedChannels: ["slack", "in_app"],
    directApprovalChannels: ["slack"],
    directDenialChannels: ["slack"],
    requireTransactionBoundActivation: false,
  };

  const goodCallback = {
    decision: "approved" as const,
    kind: "slack" as const,
    policy: permissive,
    binding: binding(),
    claimedIdentity: {
      providerId: "slack",
      providerTenantId: "T_WORKSPACE",
      providerSubjectId: "U_PERSON",
    },
    callbackAuthenticated: true,
    callbackFresh: true,
    callbackUnseen: true,
    requestPending: true,
    requestDigestMatches: true,
    comparisonSatisfied: true,
    now: NOW,
  };

  it("contract: an explicitly permitted, fully verified callback may settle", () => {
    expect(evaluateDirectSettlement(goodCallback).permitted).toBe(true);
  });

  it("property: removing any single verified fact refuses the settlement", () => {
    // Fail-closed, stated as a property rather than one case at a time: no
    // single check is decorative.
    const weakenings: { name: string; input: typeof goodCallback }[] = [
      { name: "authenticity", input: { ...goodCallback, callbackAuthenticated: false } },
      { name: "freshness", input: { ...goodCallback, callbackFresh: false } },
      { name: "replay", input: { ...goodCallback, callbackUnseen: false } },
      { name: "pending", input: { ...goodCallback, requestPending: false } },
      { name: "digest", input: { ...goodCallback, requestDigestMatches: false } },
      { name: "binding", input: { ...goodCallback, binding: binding({ state: "revoked" }) } },
      {
        name: "identity",
        input: {
          ...goodCallback,
          claimedIdentity: {
            providerId: "slack",
            providerTenantId: "T_OTHER",
            providerSubjectId: "U_PERSON",
          },
        },
      },
    ];
    for (const { name, input } of weakenings) {
      expect(evaluateDirectSettlement(input).permitted, name).toBe(false);
    }
  });

  it("adversarial: requiring an activation rules out every external channel", () => {
    // A WebAuthn ceremony cannot run inside a chat message, so a policy that
    // demands one has, by saying so, confined settlement to the app.
    const result = evaluateDirectSettlement({
      ...goodCallback,
      policy: { ...permissive, requireTransactionBoundActivation: true },
    });
    expect(result.permitted).toBe(false);
    expect(result.refusals).toContain("activation_required");
  });

  it("property: direct settlement is refused on every channel by default policy", () => {
    for (const kind of EVERY_KIND) {
      for (const risk of EVERY_RISK) {
        const result = evaluateDirectSettlement({
          ...goodCallback,
          kind,
          policy: defaultApprovalPolicy(risk),
          binding: binding({ kind }),
        });
        expect(result.permitted, `${kind}/${risk}`).toBe(false);
      }
    }
  });

  it("adversarial: a denial from an unbound destination is refused", () => {
    // The keys are omitted rather than set to undefined: under
    // exactOptionalPropertyTypes an explicit undefined is a different type
    // from an absent key, and "absent" is what a callback with no binding
    // actually looks like at the route.
    const { binding: _b, claimedIdentity: _c, ...unbound } = goodCallback;
    const result = evaluateDirectSettlement({
      ...unbound,
      decision: "denied",
    });
    expect(result.permitted).toBe(false);
    expect(result.refusals).toContain("binding_not_usable");
  });

  it("adversarial: an authentic callback is not by itself an authorization", () => {
    // Provenance and authorization are separate checks. A callback that Slack
    // really sent, from a workspace we have no binding in, settles nothing.
    const { binding: _unused, ...noBinding } = goodCallback;
    const result = evaluateDirectSettlement({
      ...noBinding,
      claimedIdentity: {
        providerId: "slack",
        providerTenantId: "T_ATTACKER_OWNS_THIS",
        providerSubjectId: "U_ANYONE",
      },
    });
    expect(result.permitted).toBe(false);
  });
});
