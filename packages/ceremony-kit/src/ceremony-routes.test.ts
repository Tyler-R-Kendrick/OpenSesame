import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderModule, specPath } from "../scripts/emit-ceremony-routes.mjs";
import { parseAuthenticatorInvocation } from "./authenticator-invocation.js";
import { CEREMONY_ROUTES_JSON } from "./ceremony-routes.generated.js";
import {
  AUTHENTICATOR_INVOCATION_KINDS,
  CEREMONY_ROUTES,
  type CeremonyRouteId,
  LEGACY_LINKS,
  ceremonyPath,
  ceremonyRoutePrefix,
  invokeKind,
  matchCeremonyPath,
} from "./ceremony-routes.js";
import {
  buildInteractionUrl,
  parseInteractionUrl,
  parseLegacyInteractionLink,
} from "./interaction-url.js";

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const REF = `i_abc.${"a".repeat(32)}`;

describe("ceremony routes (ADR 0139, ADR 0140 §3)", () => {
  it("embeds spec/config/ceremony-routes.json as it is", () => {
    expect(JSON.parse(CEREMONY_ROUTES_JSON)).toEqual({
      routes: spec.routes,
      legacy: spec.legacy,
    });
    expect(renderModule()).toContain(JSON.stringify(CEREMONY_ROUTES_JSON));
  });

  it("names the ceremonies ADR 0140 routes, and only those", () => {
    expect(Object.keys(CEREMONY_ROUTES).sort()).toEqual(
      [
        "approve",
        "claim",
        "delegate",
        "device",
        "guest",
        "interaction",
        "invoke",
      ].sort(),
    );
    for (const route of Object.values(CEREMONY_ROUTES)) {
      expect(route.path.startsWith("/")).toBe(true);
      expect(route.path.endsWith("/")).toBe(false);
      // A bearer rides in the fragment; the query never names one.
      for (const name of route.query ?? []) {
        expect(["user_code", "request_id", "request_uri"]).toContain(name);
      }
    }
  });

  it("builds and matches every route's own path", () => {
    for (const id of Object.keys(CEREMONY_ROUTES) as CeremonyRouteId[]) {
      const path = ceremonyPath(id, { ref: REF, kind: "mfa" });
      const params = matchCeremonyPath(id, `/OpenSesame${path}`);
      expect(params).not.toBeNull();
      expect(path.startsWith(ceremonyRoutePrefix(id))).toBe(true);
    }
    expect(ceremonyPath("interaction", { ref: REF })).toBe(`/i/${REF}`);
    expect(ceremonyPath("approve", { ref: "r/1" })).toBe("/approve/r%2F1");
    expect(ceremonyPath("device")).toBe("/device");
    expect(() => ceremonyPath("invoke")).toThrow();
    expect(matchCeremonyPath("invoke", "/invoke/oid4vp")).toEqual({
      kind: "oid4vp",
    });
    expect(matchCeremonyPath("invoke", "/invoke/")).toBeNull();
    expect(matchCeremonyPath("claim", "/claimx")).toBeNull();
  });

  it("builds and reads the interaction link at the spec's path", () => {
    const [before, after] = spec.routes.interaction.path.split("{ref}");
    const url = buildInteractionUrl("https://app.example/OpenSesame/", REF);
    expect(url).toBe(`https://app.example/OpenSesame${before}${REF}${after}`);
    expect(parseInteractionUrl(url)).toEqual({
      origin: "https://app.example",
      ref: REF,
    });
  });

  it("reads every legacy link shape the spec lists, and no other", () => {
    for (const shape of LEGACY_LINKS.links) {
      const route = shape.route ?? "example.test/";
      for (const name of LEGACY_LINKS.query) {
        const href = `${shape.scheme}://${route}?${name}=ab-12`;
        expect(parseLegacyInteractionLink(href)).toEqual({ userCode: "AB-12" });
      }
    }
    expect(
      parseLegacyInteractionLink("opensesame://elsewhere?user_code=AB"),
    ).toBeNull();
    expect(parseLegacyInteractionLink("ftp://x.test/?user_code=AB")).toBeNull();
    expect(LEGACY_LINKS.opens).toBe("device");
  });

  it("hands off every invoke kind to its spec app link", () => {
    expect(AUTHENTICATOR_INVOCATION_KINDS).toEqual(
      Object.keys(spec.routes.invoke.kinds),
    );
    const mfa = invokeKind("mfa");
    // The authenticator's app link is the legacy scheme the app registered.
    expect(
      LEGACY_LINKS.links.some(
        (link) => `${link.scheme}://${link.route}` === mfa.app,
      ),
    ).toBe(true);
    expect(
      parseAuthenticatorInvocation("mfa", "?user_code=ab").appUrl.startsWith(
        `${mfa.app}?`,
      ),
    ).toBe(true);
    for (const kind of ["oid4vp", "oid4vci"] as const) {
      const { app, appParameter } = invokeKind(kind);
      expect(
        parseAuthenticatorInvocation(
          kind,
          "?request_uri=https%3A%2F%2Fr.example%2F1",
        ).appUrl,
      ).toBe(`${app}?${appParameter}=https%3A%2F%2Fr.example%2F1`);
    }
  });
});
