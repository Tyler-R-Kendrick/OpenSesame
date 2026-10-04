import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockAllTombs, unlockTomb, writeFile } from "../vfs.js";
import { allowedDestinations, effectiveDestinations } from "./destinations.js";
import {
  DEFAULT_PREFERENCE,
  QUIET_PREFERENCE,
  parsePreference,
  readPreference,
  serializePreference,
  subscribePreference,
  writePreference,
} from "./preference.js";

describe("reading a preference from text", () => {
  it("reads the closed shape", () => {
    expect(
      parsePreference('{"version":1,"destinations":["in_app","system"]}'),
    ).toEqual({
      ok: true,
      preference: { version: 1, destinations: ["in_app", "system"] },
    });
  });

  it("round-trips what it writes", () => {
    const text = serializePreference(DEFAULT_PREFERENCE);
    expect(parsePreference(text)).toEqual({
      ok: true,
      preference: DEFAULT_PREFERENCE,
    });
    expect(text.endsWith("\n")).toBe(true);
  });

  it.each([
    ["not json", "{", /not valid JSON/],
    ["an array", "[]", /version 1 object/],
    ["another version", '{"version":2,"destinations":["in_app"]}', /version 1/],
    ["nothing listed", '{"version":1,"destinations":[]}', /at least one/],
    [
      "an unknown place",
      '{"version":1,"destinations":["in_app","email"]}',
      /"email" is not a place/,
    ],
    [
      "a place twice",
      '{"version":1,"destinations":["in_app","in_app"]}',
      /twice/,
    ],
    [
      "the inbox left out",
      '{"version":1,"destinations":["system"]}',
      /in_app cannot be left out/,
    ],
    [
      "a field that could widen something",
      '{"version":1,"destinations":["in_app"],"allow":["slack"]}',
      /Unknown field "allow"/,
    ],
  ])("refuses %s, saying what is wrong", (_name, text, message) => {
    const read = parsePreference(text);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.error).toMatch(message);
  });

  it("refuses text larger than a preference can be", () => {
    expect(parsePreference(" ".repeat(5000)).ok).toBe(false);
  });
});

describe("the sealed preference", () => {
  let tomb: string;
  beforeEach(async () => {
    tomb = `local-notifications-${crypto.randomUUID()}`;
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  });
  afterEach(() => {
    lockAllTombs();
    vi.restoreAllMocks();
  });

  it("is the bell and the tab's mark until the person says otherwise, and never the system doorbell", async () => {
    expect(await readPreference(tomb)).toEqual(DEFAULT_PREFERENCE);
    expect(DEFAULT_PREFERENCE.destinations).toEqual(["in_app", "tab_title"]);
    // Not even where the browser already holds the permission: the doorbell is
    // added by the person's own press, and by nothing else.
    expect(
      effectiveDestinations(
        DEFAULT_PREFERENCE.destinations,
        allowedDestinations({ tabTitle: true, system: "granted" }),
      ),
    ).toEqual(["in_app", "tab_title"]);
  });

  it("keeps what is written and tells this tab's listeners", async () => {
    const heard = vi.fn();
    const off = subscribePreference(heard);
    await writePreference(tomb, { version: 1, destinations: ["in_app"] });
    expect(heard).toHaveBeenCalledOnce();
    expect((await readPreference(tomb)).destinations).toEqual(["in_app"]);
    off();
    await writePreference(tomb, DEFAULT_PREFERENCE);
    expect(heard).toHaveBeenCalledOnce();
  });

  it("refuses to write what would not read back", async () => {
    await expect(
      writePreference(tomb, { version: 1, destinations: ["system"] }),
    ).rejects.toThrow(/in_app/);
    expect(await readPreference(tomb)).toEqual(DEFAULT_PREFERENCE);
  });

  it("falls back to the bell alone when the file is one this build cannot read", async () => {
    await writeFile(
      tomb,
      "config/local-notifications",
      new TextEncoder().encode('{"version":9}'),
    );
    // What a file this build cannot read turned off is unknown: nothing is
    // turned on on its account.
    expect(await readPreference(tomb)).toEqual(QUIET_PREFERENCE);
    expect(QUIET_PREFERENCE.destinations).toEqual(["in_app"]);
  });

  it("is per vault", async () => {
    const other = `local-notifications-${crypto.randomUUID()}`;
    unlockTomb(other, (await mintVaultKey()).vaultKey);
    await writePreference(tomb, { version: 1, destinations: ["in_app"] });
    expect(await readPreference(other)).toEqual(DEFAULT_PREFERENCE);
  });
});
