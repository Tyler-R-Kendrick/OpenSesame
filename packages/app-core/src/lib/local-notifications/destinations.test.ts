import { describe, expect, it } from "vitest";
import {
  LOCAL_DESTINATIONS,
  LOCAL_DESTINATION_MODE,
  type LocalDestination,
  type LocalEnvironment,
  allowedDestinations,
  effectiveDestinations,
  mayDecideFrom,
} from "./destinations.js";

const BROWSER: LocalEnvironment = { tabTitle: true, system: "granted" };

describe("what a place may be trusted with", () => {
  it("lets only the in-app ceremony carry a decision", () => {
    expect(LOCAL_DESTINATIONS.filter(mayDecideFrom)).toEqual(["in_app"]);
    expect(LOCAL_DESTINATION_MODE.tab_title).toBe("notify");
    expect(LOCAL_DESTINATION_MODE.system).toBe("notify");
  });
});

describe("what policy allows on this device", () => {
  it("always allows the in-app place and nothing else by default", () => {
    expect(allowedDestinations({ tabTitle: false, system: "default" })).toEqual(
      ["in_app"],
    );
  });

  it("allows a system notification only once the browser permits it", () => {
    for (const system of ["default", "denied", "unsupported"] as const)
      expect(
        allowedDestinations({ tabTitle: true, system }),
        system,
      ).not.toContain("system");
    expect(allowedDestinations(BROWSER)).toEqual([
      "in_app",
      "tab_title",
      "system",
    ]);
  });

  it("allows the tab's mark only where there is a document to carry it", () => {
    expect(allowedDestinations({ tabTitle: false, system: "granted" })).toEqual(
      ["in_app", "system"],
    );
  });
});

describe("what a preference may do to it", () => {
  const all: readonly LocalDestination[] = ["in_app", "tab_title", "system"];

  it("reorders what is allowed", () => {
    expect(
      effectiveDestinations(["system", "in_app", "tab_title"], all),
    ).toEqual(["system", "in_app", "tab_title"]);
  });

  it("narrows what is allowed", () => {
    expect(effectiveDestinations(["in_app", "tab_title"], all)).toEqual([
      "in_app",
      "tab_title",
    ]);
  });

  it("never adds a place policy refused", () => {
    const allowed = allowedDestinations({ tabTitle: true, system: "denied" });
    expect(effectiveDestinations(all, allowed)).toEqual([
      "in_app",
      "tab_title",
    ]);
    expect(effectiveDestinations(all, ["in_app"])).toEqual(["in_app"]);
  });

  it("never turns the in-app place off, however the preference reads", () => {
    expect(effectiveDestinations(["system"], all)).toEqual([
      "in_app",
      "system",
    ]);
    expect(effectiveDestinations([], all)).toEqual(["in_app"]);
    expect(effectiveDestinations([], [])).toEqual(["in_app"]);
  });

  it("never yields a place twice", () => {
    expect(
      effectiveDestinations(["tab_title", "tab_title", "in_app"], all),
    ).toEqual(["tab_title", "in_app"]);
  });

  it("only ever yields a place of the closed set", () => {
    for (const place of effectiveDestinations(all, all))
      expect(LOCAL_DESTINATIONS).toContain(place);
  });

  it("never lets a result carry a decision from a place that cannot", () => {
    for (const preferred of [all, ["system"] as const, [] as const])
      for (const place of effectiveDestinations(preferred, all))
        expect(mayDecideFrom(place), place).toBe(place === "in_app");
  });
});
