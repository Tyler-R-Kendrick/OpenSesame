import { describe, expect, it } from "vitest";
import { captureLinkedPairing, takeLinkedPairing } from "./pairing-link.js";

function address(hash: string) {
  const replaced: string[] = [];
  return {
    location: { hash, pathname: "/OpenSesame/settings/vaults", search: "?a=1" },
    history: {
      state: null,
      replaceState: (_state: null, _unused: string, url: string) => {
        replaced.push(url);
      },
    },
    replaced,
  };
}

describe("pairing link", () => {
  it("takes the code out of the address bar at once, and hands it over once", () => {
    const { location, history, replaced } = address(
      "#pair-drive=opensesame-drive%3Av1%3Aabc",
    );
    captureLinkedPairing(location, history);
    expect(replaced).toEqual(["/OpenSesame/settings/vaults?a=1"]);
    expect(takeLinkedPairing()).toBe("opensesame-drive:v1:abc");
    expect(takeLinkedPairing()).toBe("");
  });

  it("leaves an address with no pairing code alone", () => {
    const { location, history, replaced } = address("#section");
    captureLinkedPairing(location, history);
    expect(replaced).toEqual([]);
    expect(takeLinkedPairing()).toBe("");
  });

  it("still clears a malformed code, and keeps nothing from it", () => {
    const { location, history, replaced } = address("#pair-drive=%E0%A4%A");
    captureLinkedPairing(location, history);
    expect(replaced).toHaveLength(1);
    expect(takeLinkedPairing()).toBe("");
  });
});
