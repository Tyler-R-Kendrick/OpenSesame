/**
 * What the real catalog holds back for a reload (RELOAD_REQUIRED). Enabling a
 * capability after boot must start it in place unless it truly needs a fresh
 * document: `verify:webmcp` chooses WebMCP after boot and reads its native
 * tools, so a document that has already run modules must still start every
 * optional capability. Only boot-time silent sign-in waits, and only when the
 * document had not approved it at load.
 */
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import {
  FIXTURE_FACTS,
  type ResolveInput,
  buildConsentReceipt,
  fixtureResolveInput,
  fixtureSelection,
  resolveComposition,
} from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import { distributionFromOwnership } from "./ownership.js";

const NOW = "2026-09-27T00:00:00.000Z";
const OPTIONAL = CAPABILITY_CATALOG.capabilities
  .filter((d) => d.tier === "optional")
  .map((d) => d.id);

function midSession(approvedAtLoad: readonly string[]) {
  const input: ResolveInput = fixtureResolveInput({
    catalog: CAPABILITY_CATALOG,
    distribution: distributionFromOwnership("selective"),
    installation: fixtureSelection({
      instanceId: "personal-local",
      acceptedRequired: [],
      selectedOptional: OPTIONAL,
    }),
    facts: {
      ...FIXTURE_FACTS,
      cleanRealm: false,
      evaluatedModuleIds: ["vault.passwords/runtime"],
      approvedAtLoad,
    },
  });
  const receipt = buildConsentReceipt(
    resolveComposition(input),
    CAPABILITY_CATALOG,
    NOW,
  );
  return resolveComposition({ ...input, receipt });
}

function waiting(approvedAtLoad: readonly string[]): string[] {
  const plan = midSession(approvedAtLoad);
  return Object.values(plan.capabilities)
    .filter((s) => s.reasons.includes("RELOAD_REQUIRED"))
    .map((s) => s.id);
}

describe("RELOAD_REQUIRED over the real catalog", () => {
  it("an optional capability enabled after boot, WebMCP included, starts in place", () => {
    const plan = midSession([]);
    expect(plan.capabilities["agents.webmcp"]?.approved).toBe(true);
    expect(plan.capabilities["agents.webmcp"]?.reasons).toEqual([]);
    // Silent sign-in is the one optional capability that waits for a document.
    expect(waiting([]).filter((id) => id !== "identity.ambient-sso")).toEqual(
      [],
    );
  });

  it("silent sign-in waits only when the document did not approve it at load", () => {
    expect(waiting([])).toEqual(["identity.ambient-sso"]);
    expect(waiting(["identity.ambient-sso"])).toEqual([]);
  });
});
