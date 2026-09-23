/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ online: true }));
import {
  type FailureClass,
  classifyResponse,
  classifyThrown,
  failureLabel,
  failureSentence,
  probeFailureSeams,
} from "./probe-failure.js";

const isOnline = vi.fn(() => env.online);
probeFailureSeams.isOnline = isOnline;

const ALL: FailureClass[] = [
  "offline",
  "timeout",
  "unreachable",
  "rejected",
  "server-error",
  "not-opensesame",
];

afterEach(() => {
  env.online = true;
});

describe("classifyThrown", () => {
  it("calls anything offline when the browser says there is no network", () => {
    env.online = false;
    // Even a timeout is really "no network" once the radio is off; saying
    // "Host did not answer in time" would send someone to check a host that
    // was never reachable in the first place.
    expect(
      classifyThrown(
        new DOMException("Timed out after 4000ms", "TimeoutError"),
      ),
    ).toBe("offline");
    expect(classifyThrown(new TypeError("Failed to fetch"))).toBe("offline");
  });

  it("recognises our own abort timer, under either DOMException name", () => {
    // localNetworkFetch aborts with a TimeoutError; an outer signal aborts
    // with an AbortError. Both mean the same thing to an operator.
    expect(
      classifyThrown(
        new DOMException("Timed out after 4000ms", "TimeoutError"),
      ),
    ).toBe("timeout");
    expect(classifyThrown(new DOMException("aborted", "AbortError"))).toBe(
      "timeout",
    );
  });

  it("recognises a timeout reported as a plain Error", () => {
    // Not every layer throws a DOMException — some wrap it.
    expect(classifyThrown(new Error("Request timed out after 4000ms"))).toBe(
      "timeout",
    );
    expect(classifyThrown(new Error("TIMED OUT"))).toBe("timeout");
  });

  it("does not mistake an unrelated DOMException for a timeout", () => {
    expect(classifyThrown(new DOMException("nope", "NotAllowedError"))).toBe(
      "unreachable",
    );
  });

  it("buckets everything a browser refuses to distinguish", () => {
    // Connection refused, DNS failure, TLS rejection and CORS denial all
    // arrive as an identical opaque TypeError. Guessing between them would
    // put a confident wrong diagnosis in front of an operator.
    expect(classifyThrown(new TypeError("Failed to fetch"))).toBe(
      "unreachable",
    );
    expect(classifyThrown(new TypeError("NetworkError"))).toBe("unreachable");
  });

  it("survives being handed something that is not an Error at all", () => {
    expect(classifyThrown("nope")).toBe("unreachable");
    expect(classifyThrown(null)).toBe("unreachable");
    expect(classifyThrown(undefined)).toBe("unreachable");
    expect(classifyThrown({ message: "timed out" })).toBe("unreachable");
  });
});

describe("classifyResponse", () => {
  it("separates credentials from connectivity", () => {
    expect(classifyResponse(401)).toBe("rejected");
    expect(classifyResponse(403)).toBe("rejected");
  });

  it("treats every 5xx as the service's own failure", () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(classifyResponse(status)).toBe("server-error");
    }
  });

  it("reads any other answer as the wrong service listening", () => {
    // A 200 that failed the shape check, a 404, a 418 — something is there,
    // it just is not OpenSesame.
    for (const status of [200, 204, 301, 400, 404, 418, 429]) {
      expect(classifyResponse(status)).toBe("not-opensesame");
    }
  });
});

describe("failureSentence", () => {
  it.each(ALL)("gives %s a sentence of its own", (failure) => {
    const sentence = failureSentence(failure, "Host");
    expect(sentence.length).toBeGreaterThan(0);
    expect(sentence.trim()).toBe(sentence);
    expect(sentence.endsWith(".")).toBe(true);
  });

  it("names the thing it is talking about, except when offline", () => {
    for (const failure of ALL) {
      const sentence = failureSentence(failure, "Identity");
      if (failure === "offline") {
        // Offline is about this device, so naming an endpoint would mislead.
        expect(sentence).not.toContain("Identity");
      } else {
        expect(sentence).toContain("Identity");
      }
    }
  });

  it("says something different for every class", () => {
    const sentences = ALL.map((failure) => failureSentence(failure, "Host"));
    expect(new Set(sentences).size).toBe(ALL.length);
  });
});

describe("failureLabel", () => {
  it.each(ALL)("gives %s a short label of its own", (failure) => {
    expect(failureLabel(failure, "127.0.0.1:18787").length).toBeGreaterThan(0);
  });

  it("carries the address, except when offline", () => {
    for (const failure of ALL) {
      const label = failureLabel(failure, "127.0.0.1:18787");
      if (failure === "offline") {
        expect(label).toBe("Offline");
      } else {
        expect(label).toContain("127.0.0.1:18787");
      }
    }
  });

  it("stays short enough for the line under a connector name", () => {
    for (const failure of ALL) {
      expect(failureLabel(failure, "box.tailnet.ts.net").length).toBeLessThan(
        48,
      );
    }
  });

  it("says something different for every class", () => {
    const labels = ALL.map((failure) => failureLabel(failure, "host:1"));
    expect(new Set(labels).size).toBe(ALL.length);
  });
});
