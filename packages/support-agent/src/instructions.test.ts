import { describe, expect, it } from "vitest";
import type { SupportPageContext } from "./contract.js";
import { fakeSupportPageContext } from "./fake.js";
import {
  SUPPORT_POLICY_CLAUSES,
  buildSupportInstructions,
} from "./instructions.js";

const EMPTY_CONTEXT: SupportPageContext = {
  version: 1,
  pageId: "blank",
  route: "/",
  targets: [],
  routes: [],
  state: [],
  capabilities: [],
  goals: [],
  help: [],
  tools: [],
};

describe("SUPPORT_POLICY_CLAUSES", () => {
  it("keeps every clause in the built instructions", () => {
    const instructions = buildSupportInstructions(fakeSupportPageContext());
    for (const clause of SUPPORT_POLICY_CLAUSES) {
      expect(instructions).toContain(clause);
    }
  });

  it("still carries every clause when the page context is empty", () => {
    const instructions = buildSupportInstructions(EMPTY_CONTEXT);
    for (const clause of SUPPORT_POLICY_CLAUSES) {
      expect(instructions).toContain(clause);
    }
  });

  it("covers each security rule the support surface depends on", () => {
    const all = SUPPORT_POLICY_CLAUSES.join("\n");
    expect(SUPPORT_POLICY_CLAUSES.length).toBeGreaterThanOrEqual(8);
    expect(all).toContain("in-product support assistant");
    expect(all).toContain("Nothing outside that list exists to you.");
    expect(all).toContain("recovery code");
    expect(all).toContain("never claim to have read one");
    expect(all).toContain("Never invent a target identifier");
    expect(all).toContain("Never emit a CSS selector");
    expect(all).toContain("execute a tool");
    expect(all).toContain(
      "Never claim an action succeeded until the application reports the corresponding semantic state.",
    );
    expect(all).toContain("observation boundary");
    expect(all).toContain("never perform it for the person");
    expect(all).toContain("Do not guess");
  });
});

describe("buildSupportInstructions", () => {
  it("is deterministic for the same context", () => {
    const context = fakeSupportPageContext();
    expect(buildSupportInstructions(context)).toBe(
      buildSupportInstructions(context),
    );
  });

  it("names every identifier the context supplies", () => {
    const context = fakeSupportPageContext();
    const instructions = buildSupportInstructions(context);
    for (const target of context.targets) {
      expect(instructions).toContain(target.id);
      expect(instructions).toContain(target.description);
    }
    for (const route of context.routes)
      expect(instructions).toContain(route.id);
    for (const fact of context.state) expect(instructions).toContain(fact.id);
    for (const goal of context.goals) expect(instructions).toContain(goal.id);
    for (const capability of context.capabilities) {
      expect(instructions).toContain(capability.id);
    }
  });

  it("does not name a target the context withheld", () => {
    const instructions = buildSupportInstructions(fakeSupportPageContext());
    expect(instructions).not.toContain("nav.billing");
    expect(instructions).not.toContain("/billing");
    expect(instructions).not.toContain("vault.items");
  });

  it("drops an identifier once the context stops offering it", () => {
    const context = fakeSupportPageContext();
    const withoutTargets: SupportPageContext = {
      version: 1,
      pageId: context.pageId,
      route: context.route,
      targets: [],
      routes: context.routes,
      state: context.state,
      capabilities: context.capabilities,
      goals: context.goals,
      help: context.help,
      tools: context.tools,
    };
    expect(buildSupportInstructions(withoutTargets)).not.toContain(
      "nav.connections",
    );
  });

  it("states the grammar without offering an escape hatch", () => {
    const instructions = buildSupportInstructions(fakeSupportPageContext());
    expect(instructions).toContain("guide/1");
    expect(instructions).toContain('focus "<target-id>"');
    expect(instructions).toContain(
      'wait state "<predicate-id>" is=true|false timeout=<ms>',
    );
    expect(instructions).toContain("`pause` and `end` are terminal");
    expect(instructions).not.toContain("querySelector");
    expect(instructions).not.toContain("innerHTML");
    expect(instructions).not.toContain("dangerouslySetInnerHTML");
  });

  it("states the budgets a program has to fit inside", () => {
    const instructions = buildSupportInstructions(fakeSupportPageContext());
    expect(instructions).toContain("At most 8 instructions");
    expect(instructions).toContain("500 characters");
    expect(instructions).toContain("8192 UTF-8 bytes");
    expect(instructions).toContain("between 250 and 60000 milliseconds");
  });

  it("tells the model there is nothing to point at when the page has no targets", () => {
    const instructions = buildSupportInstructions(EMPTY_CONTEXT);
    expect(instructions).toContain(
      "(none — you may not emit focus, hint, annotate, scroll or wait target)",
    );
    expect(instructions).toContain(
      "(none — you may not emit navigate or wait route)",
    );
    expect(instructions).toContain("(none — you may not emit wait state)");
  });
});
