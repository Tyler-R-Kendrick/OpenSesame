import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  captureLinkedPairing,
  subscribeLinkedPairing,
  takeLinkedPairing,
  watchLinkedPairing,
} from "./pairing-link.js";

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

  it("captures a link that arrives in a page already open, and says so", () => {
    const events = new Map<string, () => void>();
    const target = {
      addEventListener: (type: string, listener: () => void) => {
        events.set(type, listener);
      },
    };
    const { location, history, replaced } = address("");
    watchLinkedPairing(overlapCast(target), location, history);
    let heard = 0;
    const stop = subscribeLinkedPairing(() => {
      heard += 1;
    });
    for (const type of ["hashchange", "popstate"]) {
      location.hash = "#pair-drive=opensesame-drive%3Av1%3Alate";
      events.get(type)?.();
      expect(takeLinkedPairing()).toBe("opensesame-drive:v1:late");
    }
    stop();
    expect(heard).toBe(2);
    expect(replaced).toHaveLength(2);
  });
});
