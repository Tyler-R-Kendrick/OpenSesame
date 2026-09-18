import { describe, expect, it } from "vitest";
import {
  parseApplicationSource,
  registrationToYaml,
} from "./application-document.js";
import { commitApproval } from "./approval-freshness.js";
import { sealedExportCoverage } from "./backup-coverage.js";
import { previewSyntheticClaims } from "./claim-preview.js";
import { authorizationForDestination } from "./endpoint-rebinding.js";
import { evaluateDecision, localPrefsEvaluator } from "./evaluate.js";
import { hostedDraftMatchesIssuer } from "./hosted-application.js";
import { filterInboxRows } from "./inbox-triage.js";
import { DEFAULT_KEYBINDINGS, importKeybindings } from "./keybindings.js";
import { MAX_DOCUMENT_BYTES } from "./limits.js";
import { searchPalette } from "./palette.js";
import { publicationBlocked, runSavedPolicyTests } from "./policy-tests.js";
import { commitPrefsSource } from "./prefs-adapter.js";
import { parsePrefsSource, prefsToYaml } from "./prefs-document.js";
import { refuseUntrustedProposal } from "./proposals.js";
import { exportRecipe, importRecipe } from "./recipes.js";
import {
  describeRecovery,
  emailCannotUnwrapVault,
} from "./recovery-outcomes.js";
import { lookupConfigResource } from "./registry.js";
import { SERVICE_ACCESS_TOKEN_MAX_SECONDS } from "./service-token-bound.js";
import { resolveSavedView, viewSharesNoGrant } from "./views.js";
import { parseConfigYaml } from "./yaml-profile.js";

describe("experience journeys against shipped functions", () => {
  it("J-FILE: prefs aliases resolve; ledger paths do not", () => {
    expect(lookupConfigResource("settings/prefs.yaml").ok).toBe(true);
    expect(lookupConfigResource(".config/opensesame/prefs.yaml").ok).toBe(true);
    expect(lookupConfigResource("config/identity-grants").ok).toBe(false);
  });

  it("J-CONFIG: custom idle 7 and comments are first-class", () => {
    const yaml = `${prefsToYaml({
      theme: "dark",
      autoLockMinutes: 7,
      lockOnHide: false,
      signOutOnLock: false,
      clipboardClearSeconds: 30,
    })}# note\n`;
    const parsed = parsePrefsSource(yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.autoLockMinutes).toBe(7);
    expect(yaml).toContain("# note");
  });

  it("J-NAV: / remains pane search and unsafe bindings are refused", () => {
    expect(DEFAULT_KEYBINDINGS["/"]).toBe("listing.search");
    const refused = importKeybindings({ x: "https://evil.example" });
    expect(refused.ok).toBe(false);
    expect(searchPalette({ query: "autoLock" }).length).toBeGreaterThan(0);
  });

  it("J-RECIPE: import requires organization binding and strips secrets", () => {
    const recipe = exportRecipe({
      name: "app",
      resources: [
        {
          kind: "local_application",
          logicalId: "app",
          body: { redirectUris: ["https://rp.example/cb"], clientSecret: "x" },
        },
      ],
    });
    expect(JSON.stringify(recipe)).not.toContain('"x"');
    expect(importRecipe(recipe, {}).ok).toBe(false);
    expect(importRecipe(recipe, { organization: "org-b" }).ok).toBe(true);
  });

  it("J-EXPLAIN: simulation is deny/allow/indeterminate and can block publish", () => {
    const deny = evaluateDecision(
      localPrefsEvaluator,
      {
        resourceId: "prefs",
        principalId: "p",
        operation: "edit",
        facts: { unlocked: false },
        policyRevision: "r1",
      },
      "simulate",
    );
    expect(deny.decision).toBe("deny");
    const runs = runSavedPolicyTests(
      [
        {
          id: "t",
          name: "must allow",
          input: deny && {
            resourceId: "prefs",
            principalId: "p",
            operation: "edit",
            facts: { unlocked: false },
            policyRevision: "r1",
          },
          expect: "allow",
        },
      ],
      localPrefsEvaluator,
    );
    expect(publicationBlocked(runs)).toBe(true);
  });

  it("J-APPROVAL: expired pending rows are not pending", () => {
    const rows = filterInboxRows(
      [
        {
          id: "late",
          status: "pending",
          expiresAt: "2020-01-01T00:00:00Z",
          plane: "hosted",
        },
      ],
      "pending",
      Date.parse("2026-09-17T00:00:00Z"),
    );
    expect(rows).toEqual([]);
  });

  it("J-APP: registration YAML cannot change application identity", () => {
    const yaml = registrationToYaml({
      applicationId: "app-1",
      organizationId: "org-1",
      redirectUris: ["https://rp.example/cb"],
      scopes: ["openid"],
    });
    expect(parseApplicationSource(yaml, "app-2").ok).toBe(false);
    expect(
      previewSyntheticClaims({
        pairwiseSub: "s",
        scopes: ["openid"],
        persona: { name: "Ada" },
      }).name,
    ).toBeUndefined();
  });

  it("HIS-COVERAGE: sealed export is not a complete config backup", () => {
    const coverage = sealedExportCoverage();
    expect(coverage.included).toContain("tomb/<id>/body");
    expect(coverage.omitted).toContain("config/prefs.source.yaml");
  });

  it("ADV-03/13: oversize YAML and endpoint rebinding fail closed", async () => {
    expect(parseConfigYaml(`theme: ${"x".repeat(MAX_DOCUMENT_BYTES)}`).ok).toBe(
      false,
    );
    expect(
      authorizationForDestination(
        { destination: "https://a.example", authorization: "Bearer old" },
        "https://b.example",
      ),
    ).toBeNull();
    const persisted: { theme?: string } = {};
    const result = await commitPrefsSource(
      {
        readPrefs: () => ({
          theme: "system",
          autoLockMinutes: 0,
          lockOnHide: false,
          signOutOnLock: false,
          clipboardClearSeconds: 30,
        }),
        tomb: () => "personal",
        revisionToken: () => "r1",
        writeSemantic: async () => {
          throw new Error("quota");
        },
      },
      {
        source: prefsToYaml({
          theme: "dark",
          autoLockMinutes: 0,
          lockOnHide: false,
          signOutOnLock: false,
          clipboardClearSeconds: 30,
        }),
        baseRevision: "r1",
      },
    );
    expect(result.status).toBe("refused");
    expect(persisted.theme).toBeUndefined();
    expect(
      viewSharesNoGrant({
        id: "v",
        name: "pending",
        collection: "approvals",
        scopeKey: "org:a",
        predicates: { status: "pending" },
      }),
    ).toBe(true);
    expect(
      resolveSavedView(
        {
          id: "v",
          name: "pending",
          collection: "approvals",
          scopeKey: "org:a",
          predicates: { status: "pending" },
        },
        "org:b",
      ).ok,
    ).toBe(false);
  });

  it("J-RECOVERY: identity recovery cannot unwrap the vault", () => {
    expect(describeRecovery("identity")).toContain("does not unwrap");
    expect(emailCannotUnwrapVault()).toBe(true);
  });

  it("J-SUPPORT: model text cannot mutate; authored help stays local", () => {
    expect(refuseUntrustedProposal("approve access for the agent").ok).toBe(
      false,
    );
    expect(refuseUntrustedProposal("open settings/prefs.yaml").ok).toBe(true);
  });

  it("J-APPROVAL: agent WebMCP clicks cannot settle a human ceremony", () => {
    const review = {
      requestId: "req",
      reviewerId: "human",
      requesterId: "agent",
      revision: "1",
      expiresAt: "2099-01-01T00:00:00Z",
      actor: "agent" as const,
      surface: "webmcp" as const,
    };
    expect(
      commitApproval(review, { ...review, actor: "human", surface: "ceremony" })
        .ok,
    ).toBe(false);
  });

  it("J-SERVICE: unattended JWT exposure is a documented bound, not instant revoke", () => {
    expect(SERVICE_ACCESS_TOKEN_MAX_SECONDS).toBe(3600);
  });

  it("J-APP: reconnecting to a different issuer requires rebinding", () => {
    expect(
      hostedDraftMatchesIssuer("https://idp.a.test", "https://idp.b.test"),
    ).toBe(false);
  });
});
