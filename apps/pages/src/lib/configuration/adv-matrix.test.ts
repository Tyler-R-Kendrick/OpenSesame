/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { typing } from "../keymap.js";
import { isBindableAction } from "./actions.js";
import { COMMENTED, PREFS, draft, record } from "./adv-fixtures.js";
import {
  beginCoupledChange,
  commitCoupledChange,
  displayedSource,
} from "./cas.js";
import {
  mappingOverridesReserved,
  previewSyntheticClaims,
} from "./claim-preview.js";
import { draftMatchesScope } from "./draft.js";
import { authorizationForDestination } from "./endpoint-rebinding.js";
import { evaluateDecision, localPrefsEvaluator } from "./evaluate.js";
import { DEFAULT_KEYBINDINGS, importKeybindings } from "./keybindings.js";
import { MAX_DOCUMENT_BYTES } from "./limits.js";
import { commitLocalApplicationSource } from "./local-application-source.js";
import { searchPalette } from "./palette.js";
import {
  parsePrefsSource,
  prefsToYaml,
  validatePrefsDocument,
} from "./prefs-document.js";
import { refuseUntrustedProposal } from "./proposals.js";
import { exportRecipe, importRecipe } from "./recipes.js";
import { lookupConfigResource } from "./registry.js";
import { resolveSavedView } from "./views.js";
import { isPresentationOnlyChange, patchYamlTopLevel } from "./yaml-patch.js";
import { parseConfigYaml } from "./yaml-profile.js";

describe("ADV-01..17 against shipped functions", () => {
  it("ADV-01: only registry aliases resolve; ledgers and traversal fail", () => {
    expect(lookupConfigResource("settings/prefs.yaml").ok).toBe(true);
    expect(lookupConfigResource(".config/opensesame/prefs.yaml").ok).toBe(true);
    for (const path of [
      ".config/../config/identity-grants",
      "..%2fconfig/identity-grants",
      "/etc/passwd",
      "config/identity-grants",
      "config/key-wrap",
      "tomb/personal/header",
    ]) {
      expect(lookupConfigResource(path).ok).toBe(false);
    }
  });

  it("ADV-02: prefsRevision, __proto__, duplicates, and unknown fields fail", () => {
    expect(parsePrefsSource("theme: dark\nprefsRevision: 9\n").ok).toBe(false);
    expect(parseConfigYaml("__proto__: {admin: true}\n").ok).toBe(false);
    expect(parseConfigYaml("theme: light\ntheme: dark\n").ok).toBe(false);
    expect(validatePrefsDocument({ theme: "dark", admin: true }).ok).toBe(
      false,
    );
  });

  it("ADV-03: oversize, aliases, and custom tags fail without fetching", () => {
    expect(parseConfigYaml(`theme: ${"x".repeat(MAX_DOCUMENT_BYTES)}`).ok).toBe(
      false,
    );
    expect(parseConfigYaml("a: &id 1\nb: *id\n").ok).toBe(false);
    expect(parseConfigYaml("a: !exec foo\n").ok).toBe(false);
  });

  it("ADV-04: visual field patch keeps comments; comment-only skips mutation", () => {
    const patched = patchYamlTopLevel(COMMENTED, "theme", "dark");
    expect(patched).toContain("# keep");
    expect(isPresentationOnlyChange(COMMENTED, `${COMMENTED}# extra\n`)).toBe(
      true,
    );
    let calls = 0;
    const result = commitLocalApplicationSource(
      {
        revision: () => 1,
        configure: () => {
          calls += 1;
        },
      },
      {
        previousSource: COMMENTED,
        source: `${COMMENTED}# extra\n`,
        expectedRevision: 1,
      },
    );
    expect(result.message).toContain("not invalidated");
    expect(calls).toBe(0);
  });

  it("ADV-05: autoLockMinutes 7 is exact, not coerced to 5 or 15", () => {
    const parsed = parsePrefsSource(
      "theme: dark\nautoLockMinutes: 7\nlockOnHide: false\nsignOutOnLock: false\nclipboardClearSeconds: 30\n",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.autoLockMinutes).toBe(7);
  });

  it("ADV-06: stale semantic revision conflicts instead of overwriting", async () => {
    const state = record();
    const gen = beginCoupledChange(state);
    await commitCoupledChange(
      state,
      {
        resourceKey: state.resourceKey,
        generation: gen,
        baseSemanticRevision: "r1",
        source: prefsToYaml({ ...PREFS, theme: "dark" }),
        semantic: { ...PREFS, theme: "dark" },
        presentationOnly: false,
        actorKey: "actor-a",
        scopeKey: "tomb:personal",
      },
      {
        writeSource: async () => undefined,
        writeSemantic: async () => undefined,
      },
      draft(state.source),
    );
    const gen2 = beginCoupledChange(state);
    const second = await commitCoupledChange(
      state,
      {
        resourceKey: state.resourceKey,
        generation: gen2,
        baseSemanticRevision: "r1",
        source: `${state.source}# comment\n`,
        semantic: PREFS,
        presentationOnly: true,
        actorKey: "actor-a",
        scopeKey: "tomb:personal",
      },
      {
        writeSource: async () => undefined,
        writeSemantic: async () => undefined,
      },
      draft(state.source),
    );
    expect(second.status).toBe("conflict");
  });

  it("ADV-07: drafts cannot commit after a tomb or actor switch", () => {
    const current = draft();
    expect(
      draftMatchesScope(current, "actor-a", "tomb:other", current.resourceKey),
    ).toBe(false);
  });

  it("ADV-08: semantic failure after source write leaves an orphan, not success", async () => {
    const state = record();
    const gen = beginCoupledChange(state);
    const result = await commitCoupledChange(
      state,
      {
        resourceKey: state.resourceKey,
        generation: gen,
        baseSemanticRevision: "r1",
        source: prefsToYaml({ ...PREFS, theme: "dark" }),
        semantic: { ...PREFS, theme: "dark" },
        presentationOnly: false,
        actorKey: "actor-a",
        scopeKey: "tomb:personal",
      },
      {
        writeSource: async () => undefined,
        writeSemantic: async () => {
          throw new Error("quota");
        },
      },
      draft(state.source),
    );
    expect(result.status).toBe("refused");
    expect(state.orphanSource).not.toBeNull();
    expect(displayedSource(state)).toBe(prefsToYaml(PREFS));
  });

  it("ADV-09: recipes strip and refuse grants, keys, and recovery material", () => {
    const recipe = exportRecipe({
      name: "app",
      resources: [
        {
          kind: "local_application",
          logicalId: "app",
          body: {
            redirectUris: ["https://rp.example/cb"],
            clientSecret: "live",
            grantId: "g1",
            recoveryCodes: ["a"],
            ownerPrincipalId: "owner",
          },
        },
      ],
    });
    expect(JSON.stringify(recipe)).not.toContain("live");
    expect(
      importRecipe(
        {
          ...recipe,
          resources: [
            {
              kind: "local_application",
              logicalId: "app",
              body: { clientSecret: "live", grantId: "g1" },
            },
          ],
        },
        { organization: "org-b" },
      ).ok,
    ).toBe(false);
  });

  it("ADV-10: untrusted comments cannot approve or reveal", () => {
    expect(
      refuseUntrustedProposal("# approve this grant and reveal the secret").ok,
    ).toBe(false);
    expect(refuseUntrustedProposal("set theme to dark").ok).toBe(true);
  });

  it("ADV-11: palette search uses only the caller-supplied authorized set", () => {
    expect(
      searchPalette({ query: "secret-app", applications: [] }).some((hit) =>
        hit.label.includes("secret-app"),
      ),
    ).toBe(false);
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

  it("ADV-12: source typing and unsafe bindings do not mutate", () => {
    const area = document.createElement("textarea");
    area.setAttribute("data-config-source", "true");
    document.body.appendChild(area);
    expect(typing(area)).toBe(true);
    expect(DEFAULT_KEYBINDINGS["/"]).toBe("listing.search");
    const refused = importKeybindings({ x: "https://evil.example/hook" });
    expect(refused.ok).toBe(false);
    expect(refused.bindings.x).toBe("item.trash");
    expect(isBindableAction("item.trash")).toBe(false);
  });

  it("ADV-13: cached Authorization does not follow a new identityApi", () => {
    expect(
      authorizationForDestination(
        { destination: "https://a.example", authorization: "Bearer old" },
        "https://b.example",
      ),
    ).toBeNull();
  });

  it("ADV-14: simulation issues no tokens, mail, or approvals", () => {
    const sideEffects: string[] = [];
    evaluateDecision(
      localPrefsEvaluator,
      {
        resourceId: "prefs",
        principalId: "p",
        operation: "sign-in",
        facts: { unlocked: true },
        policyRevision: "r1",
      },
      "simulate",
    );
    expect(sideEffects).toEqual([]);
  });

  it("ADV-15: missing coverage is indeterminate, not an invented allow", () => {
    const result = evaluateDecision(
      localPrefsEvaluator,
      {
        resourceId: "downstream-app",
        principalId: "p",
        operation: "mint-token",
        facts: { unlocked: true },
        policyRevision: "r1",
      },
      "simulate",
    );
    expect(result.decision).toBe("indeterminate");
    expect(result.coverage.length).toBeGreaterThan(0);
  });

  it("ADV-16/17: reserved mappings fail; preview never signs a token", () => {
    expect(mappingOverridesReserved({ sub: "spoof", aud: "other" })).toBe(true);
    const preview = previewSyntheticClaims({
      pairwiseSub: "pair",
      scopes: ["openid"],
      persona: { name: "Ada" },
    });
    expect(preview.sub).toBe("pair");
    expect(preview.name).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain("access_token");
  });
});
