/** @vitest-environment jsdom */

/**
 * The registries under attack, through the app's own compile and run edges.
 *
 * `validate.test.ts` proves the two-stage compiler against a hand-written
 * vocabulary; this proves the same refusals against the vocabulary this
 * application actually publishes, and then proves the runtime refuses again
 * when a program is handed to it as an AST — the path a parser bug, or any
 * future caller that builds a program itself, would take.
 */

import { compileGuide } from "@opensesame/guide-lang";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  GUIDE_ROUTES,
  guideRouteForPath,
  isKnownGuideRoute,
} from "../../registry/routes.js";
import {
  duplicateGuideTargetMounts,
  mountGuideTarget,
  resolveGuideTargetElement,
} from "../../registry/targets.js";
import {
  type SupportChain,
  createSupportChain,
  guideSource,
  settle,
} from "./harness.js";

let chain: SupportChain | null = null;

function open(route = "/vault"): SupportChain {
  const built = createSupportChain(route);
  chain = built;
  return built;
}

afterEach(() => {
  chain?.dispose();
  chain = null;
  document.body.replaceChildren();
});

function compile(active: SupportChain, source: string) {
  return compileGuide(source, active.vocabulary);
}

describe("an identifier this build does not declare", () => {
  it("is rejected with the code that names what was missing", () => {
    const active = open();
    const cases: readonly { source: string; code: string }[] = [
      {
        source: guideSource('focus "nav.imaginary" "x"'),
        code: "unknown_target",
      },
      {
        source: guideSource('scroll "vault.ghost"'),
        code: "unknown_target",
      },
      {
        source: guideSource('navigate "/admin/secrets"'),
        code: "unknown_route",
      },
      {
        source: guideSource(
          'wait state "vault.master-password" is=true timeout=1000',
        ),
        code: "unknown_predicate",
      },
      {
        source: ["guide/1", 'goal "vault.exfiltrate"', 'say "hello"'].join(
          "\n",
        ),
        code: "unknown_goal",
      },
    ];

    for (const entry of cases) {
      const result = compile(active, entry.source);
      expect(result.ok, entry.source).toBe(false);
      if (result.ok) continue;
      expect(result.stage).toBe("validate");
      expect(result.errors.map((error) => error.code)).toContain(entry.code);
    }
    expect(active.renderer.calls).toEqual([]);
  });
});

describe("a route that is well-formed but nobody registered", () => {
  it("is refused by the registry, the compiler and the runtime alike", async () => {
    const active = open();
    expect(isKnownGuideRoute("/admin/secrets")).toBe(false);

    const compiled = compile(active, guideSource('navigate "/admin/secrets"'));
    expect(compiled.ok).toBe(false);

    // Handed straight to the runtime as an AST, the way a parser regression or
    // a future caller that assembles a program itself would reach it.
    const outcome = await active.runtime.start({
      version: 1,
      goal: "vault.lock",
      instructions: [{ kind: "navigate", route: "/admin/secrets" }],
    });

    expect(outcome).toEqual({
      kind: "failed",
      goal: "vault.lock",
      error: { code: "UNKNOWN_ROUTE", detail: "/admin/secrets" },
    });
    expect(active.routes.navigations()).toEqual([]);
    expect(active.routes.current()).toBe("/vault");
  });

  it("never appears as the route the page reports, for any path", () => {
    const registered = new Set(GUIDE_ROUTES.map((route) => route.id));
    fc.assert(
      fc.property(fc.webPath(), (path) => {
        expect(registered.has(guideRouteForPath(path))).toBe(true);
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (path) => {
        expect(registered.has(guideRouteForPath(path))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("a second element claiming a target already on screen", () => {
  /**
   * The registry allows a control to exist twice — the vault filters are chips
   * on a phone and rail rows on a desktop — so the assertion that matters is
   * not that a second mount is refused, it is that it cannot take the
   * highlight away from the control the person can already see.
   */
  it("cannot take the binding from the element already on screen", () => {
    const active = open();
    const original = active.targets.element("shell.lock");
    const impostor = document.createElement("button");
    impostor.type = "button";
    impostor.textContent = "Lock";
    document.body.appendChild(impostor);

    let detach: (() => void) | null = null;
    try {
      detach = mountGuideTarget("shell.lock", impostor);
    } catch {
      // A registry that refuses the second element outright satisfies the
      // property too; the assertion below is the one under test either way.
    }

    expect(resolveGuideTargetElement("shell.lock")).toBe(original);
    detach?.();
    expect(resolveGuideTargetElement("shell.lock")).toBe(original);
    impostor.remove();
  });

  it("records or refuses the same element mounted twice", () => {
    const active = open();
    const original = active.targets.element("shell.lock");
    const before = duplicateGuideTargetMounts().length;

    let detach: (() => void) | null = null;
    let refused = false;
    try {
      detach = mountGuideTarget("shell.lock", original);
    } catch {
      refused = true;
    }

    expect(refused || duplicateGuideTargetMounts().length > before).toBe(true);
    expect(resolveGuideTargetElement("shell.lock")).toBe(original);
    detach?.();
  });
});

describe("a target that leaves the page mid-walkthrough", () => {
  it("stops the trajectory instead of pointing at nothing", async () => {
    const active = open();
    const program = active.compile(
      guideSource(
        'focus "vault.create" "Start here." side=bottom',
        'wait target "vault.create" event=disappear timeout=30000',
        'focus "vault.create" "Still here?" side=bottom',
      ),
    );
    if (program === null) throw new Error("fixture did not compile");

    const running = active.runtime.start(program);
    await settle();
    active.targets.unmount("vault.create");

    expect(await running).toEqual({
      kind: "failed",
      goal: "vault.lock",
      error: { code: "TARGET_NOT_MOUNTED", detail: "vault.create" },
    });
    expect(active.renderer.renderCalls()).toHaveLength(1);
    expect(active.clock.pending()).toBe(0);
  });
});
