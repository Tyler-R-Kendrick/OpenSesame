import { PASSWORD_WORKFLOW_GOALS } from "@opensesame/app-core/tutorial/registry/password-workflow-goals.js";
import { guideNavigationPath } from "@opensesame/app-core/tutorial/registry/vault-routes.js";
import { AUTHORED_GUIDE_LIMITS, compileGuide } from "@opensesame/guide-lang";
import {
  createFakeRoutes,
  createFakeState,
  createFakeTargets,
  createGuideRuntime,
  createRecordingRenderer,
  createTestClock,
} from "@opensesame/guide-runtime";
import { describe, expect, it } from "vitest";

const targets = [
  "vault.workflow.find",
  "vault.workflow.inventory",
  "vault.workflow.audit",
  "vault.workflow.template",
  "vault.workflow.read",
  "vault.workflow.private",
];

describe("password workflow tutorial", () => {
  it("reaches every step with Next, opens the sheet by navigation, and submits no workflow", async () => {
    const goal = PASSWORD_WORKFLOW_GOALS.find(
      (entry) => entry.id === "vault.password-workflows",
    );
    if (!goal) throw new Error("Password workflow tutorial missing");
    const routes = ["/vault", "/vault/password-workflows"];
    const compiled = compileGuide(
      goal.guide,
      {
        goals: [goal.id],
        targets,
        routes,
        predicates: [],
      },
      AUTHORED_GUIDE_LIMITS,
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const clock = createTestClock();
    const renderer = createRecordingRenderer();
    const routePort = createFakeRoutes(routes, "/vault");
    const destinations: (string | null)[] = [];
    const originalNavigate = routePort.navigate;
    routePort.navigate = (route) => {
      destinations.push(
        guideNavigationPath(route, { pathname: "/vault", search: "" }),
      );
      return originalNavigate(route);
    };
    const runtime = createGuideRuntime({
      clock,
      renderer,
      routes: routePort,
      targets: createFakeTargets(targets, targets),
      state: createFakeState([]),
    });
    const outcome = runtime.start(compiled.program, {
      mode: "tour",
      limits: AUTHORED_GUIDE_LIMITS,
    });
    await clock.advance(0);
    for (let count = 0; count < 15 && runtime.snapshot().tour; count += 1) {
      runtime.next();
      await clock.advance(0);
    }
    await expect(outcome).resolves.toMatchObject({ kind: "completed" });
    expect(destinations).toContain("/vault?workflow=password");
    expect(
      renderer
        .renderCalls()
        .flatMap((call) => (call.kind === "focus" ? [call.target] : [])),
    ).toEqual(targets);
    expect(goal.guide).not.toContain("event=activate");
  });
});
