/**
 * BUILD feature unit tests — real assertions (not checklist printers).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DURESS_CAPABILITIES,
  DURESS_STATIC_CONSTRAINTS,
  DuressOfflineAssetCache,
  assertReadableDuressHeader,
  capabilitiesForMode,
  checkStaticHostingConstraints,
  clampAssuranceForSw,
  compareDuressModes,
  evaluateOfflineAssetReadiness,
  evaluateServiceWorkerMismatch,
  explainFormatRefusal,
  loadDuressRuntime,
  refuseUnsupportedDuressFormat,
  resolveDuressMode,
  unsupportedCapabilitiesForMode,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const duressRoot = join(here, "..");

describe("BUILD-A capability registry + lazy load", () => {
  it("defaults to off and admits no capabilities", () => {
    expect(resolveDuressMode({})).toBe("off");
    expect(capabilitiesForMode("off")).toEqual([]);
    expect(unsupportedCapabilitiesForMode("off").length).toBe(
      DURESS_CAPABILITIES.length,
    );
  });

  it("local_only excludes peer; optional_peer includes peer", () => {
    const local = capabilitiesForMode("local_only").map((c) => c.id);
    const peer = capabilitiesForMode("optional_peer").map((c) => c.id);
    expect(local).not.toContain("duress.peer");
    expect(peer).toContain("duress.peer");
    expect(peer.length).toBeGreaterThan(local.length);
  });

  it("off load fetches nothing; local_only actually imports core modules", async () => {
    const off = await loadDuressRuntime("off");
    expect(off.loaded).toBe(false);
    expect(off.modules).toEqual([]);

    const local = await loadDuressRuntime("local_only");
    expect(local.loaded).toBe(true);
    expect(local.modules).toContain("duress.crypto");
    expect(local.modules).not.toContain("duress.peer");
    expect(local.modules).not.toContain("duress.ui");
    expect(local.unsupported).toContain("duress.peer");

    const withPeer = await loadDuressRuntime("optional_peer");
    expect(withPeer.modules).toContain("duress.peer");
  });
});

describe("BUILD-B offline asset readiness", () => {
  it("refuses offline-ready claim when modules missing", async () => {
    const report = await evaluateOfflineAssetReadiness("local_only", {
      modulePresent: () => false,
      durableStorageAvailable: true,
    });
    expect(report.mayClaimOfflineReady).toBe(false);
    expect(report.offlineAssets).toBe("unavailable");
  });

  it("prefetch rejects empty stubs and records real bytes", async () => {
    const cache = new DuressOfflineAssetCache();
    const result = await cache.prefetch("local_only", async (cap) => {
      if (cap.id === "duress.access") {
        return { digest: "x", bytes: new Uint8Array() };
      }
      const bytes = new TextEncoder().encode(cap.id);
      return {
        digest: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      };
    });
    expect(result.failed).toContain("duress.access");
    expect(result.cached.length).toBeGreaterThan(0);
  });

  it("verified_ready only when digests align", async () => {
    const expected: Record<string, string> = {};
    const caps = capabilitiesForMode("local_only").filter(
      (c) => c.kind !== "ui",
    );
    for (const cap of caps) {
      expected[cap.id] = `digest-${cap.id}`;
    }
    const report = await evaluateOfflineAssetReadiness("local_only", {
      modulePresent: () => true,
      moduleDigest: (cap) => expected[cap.id] ?? null,
      expectedDigests: expected,
      durableStorageAvailable: true,
    });
    expect(report.swMismatch).toBe(false);
    expect(report.offlineAssets).toBe("verified_ready");
    expect(report.mayClaimOfflineReady).toBe(true);
  });
});

describe("BUILD-C format refusal", () => {
  it("feature-off refuses armed vaults", () => {
    expect(
      refuseUnsupportedDuressFormat(
        { duressFormatVersion: 1, armed: true },
        1,
        "off",
      ),
    ).toEqual({ ok: false, code: "unsupported_profile_version" });
    expect(
      explainFormatRefusal({ duressFormatVersion: 1, armed: true }, "off"),
    ).toBe("feature_off_reader_refuses_armed_vault");
  });

  it("allows unarmed / never-enrolled even when off", () => {
    expect(refuseUnsupportedDuressFormat(null, 1, "off")).toEqual({ ok: true });
    expect(
      refuseUnsupportedDuressFormat(
        { duressFormatVersion: 1, armed: false },
        1,
        "off",
      ),
    ).toEqual({ ok: true });
  });

  it("local_only refuses newer format versions", () => {
    expect(
      assertReadableDuressHeader(
        { duressFormatVersion: 9, armed: true },
        "local_only",
        1,
      ),
    ).toEqual({ ok: false, code: "unsupported_profile_version" });
    expect(
      assertReadableDuressHeader(
        { duressFormatVersion: 1, armed: true },
        "local_only",
        1,
      ),
    ).toEqual({ ok: true });
  });
});

describe("BUILD-D static constraints", () => {
  it("declares no mandatory loopback/Identity and feature sources stay clean", () => {
    expect(DURESS_STATIC_CONSTRAINTS.mandatoryLoopback).toBe(false);
    expect(DURESS_STATIC_CONSTRAINTS.mandatoryIdentity).toBe(false);
    expect(DURESS_STATIC_CONSTRAINTS.mandatoryDaemon).toBe(false);

    const files = [
      "mode.ts",
      "registry.ts",
      "format.ts",
      "assets.ts",
      "static.ts",
      "sw-mismatch.ts",
      "index.ts",
    ];
    const sources = files
      .map((f) => join(here, f))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf8"));

    const report = checkStaticHostingConstraints({
      sources,
      basePath: "/OpenSesame/",
    });
    expect(report.ok).toBe(true);
    expect(report.forbidsMandatoryLoopback).toBe(true);
  });
});

describe("BUILD-F mode compare + SW mismatch", () => {
  it("compares off / local_only / optional_peer", () => {
    const cmp = compareDuressModes();
    expect(cmp.capabilityCounts.off).toBe(0);
    expect(cmp.peerIncluded.local_only).toBe(false);
    expect(cmp.peerIncluded.optional_peer).toBe(true);
    expect(cmp.uiAdmitted.off).toBe(false);
  });

  it("SW digest drift clamps verified_ready down to configured", () => {
    const mismatch = evaluateServiceWorkerMismatch({
      expected: { "duress.crypto": "aaa" },
      cached: { "duress.crypto": "bbb" },
    });
    expect(mismatch.mismatch).toBe(true);
    expect(mismatch.maxAssurance).toBe("configured");
    expect(clampAssuranceForSw("verified_ready", mismatch)).toBe("configured");
  });

  it("missing cache entries are unavailable, not verified_ready", () => {
    const mismatch = evaluateServiceWorkerMismatch({
      expected: { "duress.crypto": "aaa" },
      cached: {},
    });
    expect(mismatch.maxAssurance).toBe("unavailable");
    expect(clampAssuranceForSw("verified_ready", mismatch)).toBe("unavailable");
  });

  it("on-disk module paths for core capabilities exist", () => {
    for (const cap of capabilitiesForMode("local_only")) {
      if (cap.kind === "ui") continue;
      const abs = join(duressRoot, cap.modulePath.replace(/\.js$/, ".ts"));
      expect(existsSync(abs), abs).toBe(true);
    }
  });
});
