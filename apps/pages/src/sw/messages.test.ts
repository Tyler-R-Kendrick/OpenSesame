import { describe, expect, it } from "vitest";
import { isWorkerHello, parsePlanAssets } from "./messages.js";

const base = {
  type: "PLAN_ASSETS",
  releaseId: "r1abc",
  planDigest: "sha256:abc",
};

describe("parsePlanAssets", () => {
  it("accepts the four known fields and sorts/dedupes module ids", () => {
    const parsed = parsePlanAssets({
      ...base,
      moduleIds: ["wallet.spending/runtime", "agents.webmcp/runtime", "agents.webmcp/runtime"],
    });
    expect(parsed).toEqual({
      ok: true,
      message: {
        ...base,
        moduleIds: ["agents.webmcp/runtime", "wallet.spending/runtime"],
      },
    });
  });

  it("refuses any extra field, whatever it is called", () => {
    for (const extra of ["urls", "assets", "files", "scope", "cacheName"]) {
      expect(parsePlanAssets({ ...base, moduleIds: [], [extra]: ["x"] })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("refuses a missing field, a non-array, a non-string id, another type", () => {
    expect(parsePlanAssets({ type: "PLAN_ASSETS", releaseId: "r", moduleIds: [] })).toEqual({ ok: false, reason: "malformed" });
    expect(parsePlanAssets({ ...base, moduleIds: "agents.webmcp/runtime" })).toEqual({ ok: false, reason: "malformed" });
    expect(parsePlanAssets({ ...base, moduleIds: [1] })).toEqual({ ok: false, reason: "malformed" });
    expect(parsePlanAssets({ ...base, type: "PLAN", moduleIds: [] })).toEqual({ ok: false, reason: "malformed" });
    expect(parsePlanAssets(null)).toEqual({ ok: false, reason: "malformed" });
    expect(parsePlanAssets("PLAN_ASSETS")).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a release id or plan digest off the grammar", () => {
    expect(parsePlanAssets({ ...base, releaseId: "a:b", moduleIds: [] })).toEqual({ ok: false, reason: "malformed" });
    expect(parsePlanAssets({ ...base, releaseId: "", moduleIds: [] })).toEqual({ ok: false, reason: "malformed" });
    expect(parsePlanAssets({ ...base, planDigest: "sha256:ab cd", moduleIds: [] })).toEqual({ ok: false, reason: "malformed" });
  });

  it("names a URL-looking id for what it is", () => {
    for (const id of [
      "https://evil.test/x.js",
      "//evil.test/x.js",
      "/OpenSesame/assets/main.js",
      "../sw.js",
      "assets/main-abc.js",
      "agents.webmcp/runtime?x=1",
      "agents.webmcp/runtime#frag",
      "agents.webmcp/runtime.css",
    ]) {
      expect(parsePlanAssets({ ...base, moduleIds: [id] })).toEqual({ ok: false, reason: "carries-url" });
    }
    expect(parsePlanAssets({ ...base, moduleIds: ["Agents.webmcp/runtime"] })).toEqual({ ok: false, reason: "malformed" });
    expect(parsePlanAssets({ ...base, moduleIds: ["webmcp/runtime"] })).toEqual({ ok: false, reason: "malformed" });
  });

  it("recognizes a hello and nothing that merely resembles one", () => {
    expect(isWorkerHello({ type: "WORKER_HELLO" })).toBe(true);
    expect(isWorkerHello({ type: "WORKER_HELLO", extra: 1 })).toBe(true);
    expect(isWorkerHello("WORKER_HELLO")).toBe(false);
    expect(isWorkerHello({ type: "HELLO" })).toBe(false);
  });
});
