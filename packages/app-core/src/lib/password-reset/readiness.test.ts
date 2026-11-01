/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONNECTOR_SETTING,
  writeConnectorSetting,
} from "../connector-settings.js";
import { forgetDeviceConnectors } from "../device-connectors.js";
import { localRequestFixture } from "../local-request.fixture.js";
import { lockAllTombs } from "../vfs.js";
import {
  evaluatePasswordResetReadiness,
  passwordResetFeatureApproved,
} from "./readiness.js";

const PLANE = {
  kind: "browser",
  browserPlane: "builtin",
  because: "configured",
} as const;

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
});

async function disable(tomb: string, providerId: string): Promise<void> {
  await writeConnectorSetting(tomb, providerId, {
    ...DEFAULT_CONNECTOR_SETTING,
    enabled: false,
  });
}

describe("password reset readiness", () => {
  it("requires the feature capability", () => {
    expect(passwordResetFeatureApproved([])).toBe(false);
    expect(passwordResetFeatureApproved(["ai.password-reset"])).toBe(true);
  });

  it("is runtime-ready by default via the anonymous relays, with nothing saved", async () => {
    await forgetDeviceConnectors();
    const verdict = await evaluatePasswordResetReadiness(
      ["ai.password-reset"],
      PLANE,
    );
    expect(verdict).toEqual({ ok: true });
  });

  it("refuses when both anonymous relays are disabled in connector settings", async () => {
    await forgetDeviceConnectors();
    const fixture = await localRequestFixture();
    await disable(fixture.tomb, "cloudflare-anonymous");
    await disable(fixture.tomb, "vercel-anonymous");
    const verdict = await evaluatePasswordResetReadiness(
      ["ai.password-reset"],
      PLANE,
      fixture.tomb,
    );
    expect(verdict).toEqual({ ok: false, reason: "runtime" });
  });

  it("stays ready while one anonymous relay remains enabled", async () => {
    await forgetDeviceConnectors();
    const fixture = await localRequestFixture();
    await disable(fixture.tomb, "cloudflare-anonymous");
    const verdict = await evaluatePasswordResetReadiness(
      ["ai.password-reset"],
      PLANE,
      fixture.tomb,
    );
    expect(verdict).toEqual({ ok: true });
  });
});
