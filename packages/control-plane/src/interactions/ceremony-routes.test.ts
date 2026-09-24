import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INTERACTION_ROUTE,
  interactionPath,
  resolveContinuation,
} from "./rendezvous.js";

// The one list of ceremony routes (ADR 0139, ADR 0140 §3). The Identity API
// does not depend on ceremony-kit, so it holds its one literal to the spec
// here rather than reading the generated module.
const spec = JSON.parse(
  readFileSync(
    new URL("../../../../spec/config/ceremony-routes.json", import.meta.url),
    "utf8",
  ),
) as { routes: { interaction: { path: string } } };

const REF = `i_abc.${"a".repeat(32)}`;

describe("the interaction route agrees with spec/config/ceremony-routes.json", () => {
  it("is the spec's interaction path", () => {
    expect(`${INTERACTION_ROUTE}/{ref}`).toBe(spec.routes.interaction.path);
    expect(interactionPath(REF)).toBe(
      spec.routes.interaction.path.replace("{ref}", REF),
    );
  });

  it("launches the client app at the spec's interaction path", () => {
    expect(
      resolveContinuation({
        clientAppUrl: "https://app.example/OpenSesame/",
        ref: REF,
      }),
    ).toEqual({
      mode: "launcher",
      url: `https://app.example/OpenSesame${spec.routes.interaction.path.replace("{ref}", REF)}`,
    });
  });

  it("mounts the short link at the spec's interaction path", () => {
    const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(app).toContain(
      "app.route(INTERACTION_ROUTE, createInteractionLinkRoutes());",
    );
    const handoff = readFileSync(
      new URL("../routes/interaction-handoff.ts", import.meta.url),
      "utf8",
    );
    const code = handoff
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    expect(code.join("\n")).not.toMatch(/[`"']\/i\//);
  });

  it("documents the short link at the spec's interaction path", () => {
    const openapi = JSON.parse(
      readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"),
    ) as { paths: Record<string, unknown> };
    expect(Object.keys(openapi.paths)).toContain(spec.routes.interaction.path);
  });
});
