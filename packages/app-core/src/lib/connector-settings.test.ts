/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_CONNECTOR_SETTING,
  readConnectorSettings,
  settingFor,
  writeConnectorSetting,
} from "./connector-settings.js";
import { localRequestFixture } from "./local-request.fixture.js";
import { lockAllTombs } from "./vfs.js";

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
});

it("reads {} where nothing was ever sealed", async () => {
  const fixture = await localRequestFixture();
  expect(await readConnectorSettings(fixture.tomb)).toEqual({});
});

it("round-trips one connector's settings", async () => {
  const fixture = await localRequestFixture();
  await writeConnectorSetting(fixture.tomb, "nango:github/octocat", {
    alias: "CI mirror",
    enabled: false,
    defaultPolicy: "invoke",
    defaultDurationSeconds: 86400,
  });
  const all = await readConnectorSettings(fixture.tomb);
  expect(all["nango:github/octocat"]).toEqual({
    alias: "CI mirror",
    enabled: false,
    defaultPolicy: "invoke",
    defaultDurationSeconds: 86400,
  });
  expect(settingFor(all, "nango:slack/acme")).toBe(DEFAULT_CONNECTOR_SETTING);
});

it("deletes the record when a setting returns to the defaults", async () => {
  const fixture = await localRequestFixture();
  await writeConnectorSetting(fixture.tomb, "nango:github/octocat", {
    alias: "CI mirror",
    enabled: true,
    defaultPolicy: DEFAULT_CONNECTOR_SETTING.defaultPolicy,
    defaultDurationSeconds: DEFAULT_CONNECTOR_SETTING.defaultDurationSeconds,
  });
  await writeConnectorSetting(fixture.tomb, "nango:github/octocat", {
    ...DEFAULT_CONNECTOR_SETTING,
  });
  expect(await readConnectorSettings(fixture.tomb)).toEqual({});
});

it("refuses an unknown policy, an unknown duration, and a long alias", async () => {
  const fixture = await localRequestFixture();
  await expect(
    writeConnectorSetting(fixture.tomb, "nango:github/octocat", {
      ...DEFAULT_CONNECTOR_SETTING,
      defaultPolicy: "admin",
    }),
  ).rejects.toThrow();
  await expect(
    writeConnectorSetting(fixture.tomb, "nango:github/octocat", {
      ...DEFAULT_CONNECTOR_SETTING,
      defaultDurationSeconds: 13,
    }),
  ).rejects.toThrow();
  await expect(
    writeConnectorSetting(fixture.tomb, "nango:github/octocat", {
      ...DEFAULT_CONNECTOR_SETTING,
      alias: "x".repeat(65),
    }),
  ).rejects.toThrow();
  expect(await readConnectorSettings(fixture.tomb)).toEqual({});
});
