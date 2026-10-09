import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INTERACTION_ROUTE,
  claimLinks,
  claimVerificationUri,
  clientAppLink,
  interactionPath,
  resolveContinuation,
} from "./rendezvous.js";

// The one list of ceremony routes (ADR 0139, ADR 0140 §3). The Identity API
// reads its paths through ceremony-kit's builders; this holds what it emits
// to the spec file itself, not to the generated module.
const spec = JSON.parse(
  readFileSync(
    new URL("../../../../spec/config/ceremony-routes.json", import.meta.url),
    "utf8",
  ),
) as { routes: Record<string, { path: string }> };

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

  it("links every Pages ceremony at the spec's path under the client app", () => {
    const base = "https://app.example/OpenSesame/";
    const at = (id: string, ref = "") =>
      `https://app.example/OpenSesame${spec.routes[id]?.path.replace("{ref}", ref)}`;
    expect(clientAppLink(base, "interaction", { ref: REF })).toBe(
      at("interaction", REF),
    );
    expect(clientAppLink(base, "approve", { ref: "areq_1" })).toBe(
      at("approve", "areq_1"),
    );
    expect(clientAppLink(base, "device")).toBe(at("device"));
    expect(clientAppLink(base, "claim")).toBe(at("claim"));
    expect(
      claimVerificationUri(
        { publicUrl: "https://id.example", clientAppUrl: base },
        "clm_1",
      ),
    ).toBe(at("claim"));
  });

  it("links nothing without a client app, or with one that is unsafe", () => {
    for (const clientAppUrl of [undefined, " ", "http://app.example/"]) {
      expect(clientAppLink(clientAppUrl, "device")).toBeNull();
      expect(
        claimVerificationUri(
          { publicUrl: "https://id.example", clientAppUrl },
          "clm_1",
        ),
      ).toBe("https://id.example/v1/claims/clm_1/verify");
    }
  });

  it("completes a claim link with the bearer in the fragment only", () => {
    const token = "osc_clm_pub.secret";
    const claim = { session: { id: "clm_1" }, token };
    const base = "https://app.example/OpenSesame/";
    expect(
      claimLinks(
        { publicUrl: "https://id.example", clientAppUrl: base },
        claim,
      ),
    ).toEqual({
      verificationUri: `https://app.example/OpenSesame${spec.routes.claim?.path}`,
      verificationUriComplete: `https://app.example/OpenSesame${spec.routes.claim?.path}#token=${token}`,
    });
    // No client app, or an unsafe one: the zero-JS page, and no complete
    // link, because that page cannot complete a claim.
    for (const clientAppUrl of [undefined, "http://app.example/"]) {
      expect(
        claimLinks({ publicUrl: "https://id.example", clientAppUrl }, claim),
      ).toEqual({
        verificationUri: "https://id.example/v1/claims/clm_1/verify",
      });
    }
    // A bearer that is not claim-shaped is refused, never put in a link.
    expect(() =>
      claimLinks(
        { publicUrl: "https://id.example", clientAppUrl: base },
        { session: { id: "clm_1" }, token: "osc_clm_x&key=k" },
      ),
    ).toThrow("A claim link needs a claim bearer.");
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
