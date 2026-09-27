/**
 * What a reset left behind rides the address to the fresh document, and
 * only names from the closed set of areas are read back.
 */

import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import {
  captureLandingReset,
  firstVisitAddress,
  landingLeftBehind,
  readLeftBehind,
  resetLandingForTest,
} from "./browser-reset-landing.js";

afterEach(() => {
  resetLandingForTest();
  configureHost(createTestHost());
});

describe("the address a reset leaves for", () => {
  it("is the bare root when nothing was left", () => {
    expect(
      firstVisitAddress("/OpenSesame/", {
        cleared: ["session", "caches"],
        failed: [],
        kept: [],
      }),
    ).toBe("/OpenSesame/");
  });

  it("carries what failed and what was kept", () => {
    const address = firstVisitAddress("/OpenSesame/", {
      cleared: ["session"],
      failed: ["databases"],
      kept: ["caches", "service_workers"],
    });
    expect(address).toBe(
      "/OpenSesame/?reset-failed=databases&reset-kept=caches%2Cservice_workers",
    );
    expect(readLeftBehind(new URL(address, "https://a.test").search)).toEqual({
      failed: ["databases"],
      kept: ["caches", "service_workers"],
    });
  });

  it("reads only the closed set of area names", () => {
    expect(
      readLeftBehind("?reset-kept=caches,<script>,caches&reset-failed=x"),
    ).toEqual({ failed: [], kept: ["caches"] });
    expect(readLeftBehind("?reset-kept=nothing-real")).toBeNull();
    expect(readLeftBehind("?other=1")).toBeNull();
  });
});

describe("captureLandingReset", () => {
  it("reads the address once and takes the report off it", () => {
    const replaceUrl = vi.fn();
    configureHost(
      createTestHost({
        page: overlapCast({
          location: {
            href: "https://a.test/OpenSesame/?reset-kept=caches&x=1#top",
          },
          replaceUrl,
        }),
      }),
    );

    captureLandingReset();
    captureLandingReset();

    expect(landingLeftBehind()).toEqual({ failed: [], kept: ["caches"] });
    expect(replaceUrl).toHaveBeenCalledTimes(1);
    expect(replaceUrl).toHaveBeenCalledWith("/OpenSesame/?x=1#top");
  });
});
