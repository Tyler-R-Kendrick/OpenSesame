import { describe, expect, it } from "vitest";
import {
  assertAcyclic,
  createDomain,
  emptyForest,
  makeAccessDomain,
} from "../access-domain/index.js";
import {
  AUDIENCE_TEMPLATES,
  AUDIENCE_TEMPLATE_IDS,
  AudienceTemplateError,
  FORBIDDEN_TEMPLATE_KEYS,
  UNWIRED_PORTAL_SURFACES,
  getAudienceTemplate,
  listAudienceTemplates,
  parseAudienceTemplate,
  parseAudienceTemplateCatalog,
} from "../authority-templates/index.js";

const familyFixture = {
  id: "family",
  version: "1.0.0",
  label: "Family",
  summary: "Household defaults",
  vocabulary: {
    domain: "Household",
    participant: "Participant",
    supervisor: "Guardian",
  },
  defaults: {
    lifetimeKind: "temporary",
    inheritance: "inherit",
    defaultLifetimeMs: 86_400_000,
    maxLifetimeMs: 604_800_000,
    suggestedVerbs: ["request", "approve"],
    usageAccounting: "per_device",
  },
  limits: { forbidSecretReadFromSupervision: true },
  supportMatrix: [
    {
      id: "dns.blocky",
      label: "DNS (Blocky)",
      status: "configuration_required",
      note: "Not active until wired.",
    },
    {
      id: "os.app_blocking",
      label: "OS app blocking",
      status: "unsupported",
      note: "Unsupported.",
    },
  ],
  workflowHints: ["scheduled access"],
};

describe("audience template schema", () => {
  it("parses a valid template and freezes the known id set", () => {
    const template = parseAudienceTemplate(familyFixture);
    expect(template.id).toBe("family");
    expect(template.defaults.usageAccounting).toBe("per_device");
    expect(AUDIENCE_TEMPLATE_IDS).toContain("research-workshop");
  });

  it("requires family to state usage accounting", () => {
    const broken = {
      ...familyFixture,
      defaults: {
        lifetimeKind: familyFixture.defaults.lifetimeKind,
        inheritance: familyFixture.defaults.inheritance,
        defaultLifetimeMs: familyFixture.defaults.defaultLifetimeMs,
        maxLifetimeMs: familyFixture.defaults.maxLifetimeMs,
        suggestedVerbs: familyFixture.defaults.suggestedVerbs,
      },
    };
    expect(() => parseAudienceTemplate(broken)).toThrow(AudienceTemplateError);
  });

  it("refuses enforced/active support claims", () => {
    const broken = {
      ...familyFixture,
      supportMatrix: [
        {
          id: "dns.blocky",
          label: "DNS (Blocky)",
          status: "enforced",
          note: "Should refuse.",
        },
      ],
    };
    expect(() => parseAudienceTemplate(broken)).toThrow(AudienceTemplateError);
    try {
      parseAudienceTemplate(broken);
    } catch (error) {
      expect(error).toBeInstanceOf(AudienceTemplateError);
      expect(String(error)).toMatch(/honest_support|must be one of/);
    }
  });

  it("refuses local_defaults_only on unwired portal surfaces", () => {
    const broken = {
      ...familyFixture,
      supportMatrix: [
        {
          id: "dns.blocky",
          label: "DNS (Blocky)",
          status: "local_defaults_only",
          note: "Should refuse.",
        },
      ],
    };
    expect(() => parseAudienceTemplate(broken)).toThrow(AudienceTemplateError);
  });

  it("refuses forbidden engine-logic keys anywhere in the document", () => {
    for (const key of FORBIDDEN_TEMPLATE_KEYS) {
      expect(() =>
        parseAudienceTemplate({ ...familyFixture, [key]: "family" }),
      ).toThrow(/engine logic/);
    }
  });

  it("refuses duplicate catalog ids", () => {
    expect(() =>
      parseAudienceTemplateCatalog([familyFixture, familyFixture]),
    ).toThrow(/duplicate/);
  });
});

describe("built-in audience catalog", () => {
  it("validates every shipped template and covers the primary audiences", () => {
    const ids = listAudienceTemplates().map((template) => template.id);
    expect(ids).toEqual([...AUDIENCE_TEMPLATE_IDS]);
    expect(getAudienceTemplate("contractor")?.label).toMatch(/Contractor/i);
    expect(getAudienceTemplate("raid")?.limits.observerOnlyAllowed).toBe(true);
    expect(AUDIENCE_TEMPLATES).toHaveLength(AUDIENCE_TEMPLATE_IDS.length);
  });

  it("never advertises Blocky or OS app blocking as active/enforced", () => {
    for (const template of AUDIENCE_TEMPLATES) {
      for (const claim of template.supportMatrix) {
        expect(claim.status).toMatch(
          /^(unsupported|configuration_required|local_defaults_only)$/,
        );
        // SAFETY: fixture constructed in this test matches the declared contract.
        if ((UNWIRED_PORTAL_SURFACES as readonly string[]).includes(claim.id)) {
          expect(claim.status).not.toBe("local_defaults_only");
          expect(claim.note.toLowerCase()).not.toMatch(
            /\b(is|are|treated as) (active|enforced|protected)\b/,
          );
        }
      }
    }
  });

  it("is JSON-serializable data only (no functions / class instances)", () => {
    const roundTrip = JSON.parse(JSON.stringify(AUDIENCE_TEMPLATES));
    expect(parseAudienceTemplateCatalog(roundTrip)).toEqual(AUDIENCE_TEMPLATES);
  });
});

describe("templates do not inject privileged engine logic", () => {
  it("AccessDomain forest APIs ignore audience labels", () => {
    const realm = {
      projectId: "prj_demo",
      projectKind: "temporary" as const,
    };
    const forest = emptyForest(realm);
    const withRoot = createDomain(forest, {
      id: "dom_root",
      slug: "workshop",
      displayName: "Workshop",
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
      lifetime: {
        kind: "temporary",
        expiresAt: new Date("2026-09-16T00:00:00.000Z"),
      },
    });
    for (const id of AUDIENCE_TEMPLATE_IDS) {
      expect(
        [...withRoot.nodes.values()].some((node) => node.slug === id),
      ).toBe(false);
      expect(() =>
        makeAccessDomain({
          id: `dom_${id}`,
          realm,
          slug: "cell",
          displayName: id,
          createdAt: new Date("2026-09-15T00:00:00.000Z"),
          lifetime: {
            kind: "temporary",
            expiresAt: new Date("2026-09-16T00:00:00.000Z"),
          },
        }),
      ).not.toThrow();
    }
    assertAcyclic(withRoot);
  });

  it("catalog entries expose no evaluate/authorize hooks", () => {
    for (const template of AUDIENCE_TEMPLATES) {
      expect("evaluate" in template).toBe(false);
      expect("authorize" in template).toBe(false);
      expect("accessLease" in template).toBe(false);
    }
  });
});

describe("FIX-GENERALITY declarative templates", () => {
  it("loads declarative templates without audience-specific engine branches", () => {
    const tangential = [
      "guest",
      "classroom",
      "incident",
      "ci",
      "research-workshop",
      "family",
      "contractor",
      "raid",
      "agent-workcell",
    ] as const;
    for (const id of tangential) {
      const template = getAudienceTemplate(id);
      expect(template, `missing template ${id}`).toBeDefined();
      expect(template?.id).toBe(id);
      // Labels are vocabulary only — forest construction ignores them.
      expect(template?.vocabulary.domain.length).toBeGreaterThan(0);
      expect("evaluate" in (template ?? {})).toBe(false);
      expect("authorize" in (template ?? {})).toBe(false);
      for (const key of FORBIDDEN_TEMPLATE_KEYS) {
        expect(key in (template ?? {})).toBe(false);
      }
    }
    // Same AccessDomain path for every audience — no engine switch on id.
    const realm = {
      projectId: "prj_generality",
      projectKind: "temporary" as const,
    };
    for (const id of tangential) {
      expect(() =>
        makeAccessDomain({
          id: `dom_${id}`,
          realm,
          slug: "cell",
          displayName: getAudienceTemplate(id)?.label ?? id,
          createdAt: new Date("2026-09-15T00:00:00.000Z"),
          lifetime: {
            kind: "temporary",
            expiresAt: new Date("2026-09-16T00:00:00.000Z"),
          },
        }),
      ).not.toThrow();
    }
  });
});
