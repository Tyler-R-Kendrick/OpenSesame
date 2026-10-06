/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet } from "../../lib/kv.js";
import { TRAVEL_SAFE_KEY } from "../../lib/travel/safe-flags.js";
import { DURESS_STATUS_FILE } from "./duress-status-files.js";
import { RETIRED_CREDENTIAL_STATUS_FILE } from "./retired-credential-files.js";
import { securityFiles } from "./security-files.js";
import { TRAVEL_SAFE_FILE } from "./travel-safe-files.js";

describe("Settings › Security's files, on the sheets' own seams", () => {
  beforeEach(() => kvDelete(TRAVEL_SAFE_KEY));

  it("lists the travel file and the duress file to the owner, neither otherwise", () => {
    expect(
      securityFiles(() => true)
        .list()
        .map((file) => file.path),
    ).toEqual([
      TRAVEL_SAFE_FILE,
      DURESS_STATUS_FILE,
      RETIRED_CREDENTIAL_STATUS_FILE,
    ]);
    expect(securityFiles(() => false).list()).toEqual([]);
  });

  it("reads the duress status of this device", async () => {
    const text = await securityFiles(() => true).read(DURESS_STATUS_FILE);
    expect(JSON.parse(text)).toMatchObject({ incident_fence: false });
  });

  it("stores a mark where the Travel sheet stores it, and refuses a guest tomb", async () => {
    const files = securityFiles(() => true);
    expect(JSON.parse(await files.read(TRAVEL_SAFE_FILE))).toEqual({
      safe: [],
    });
    const guest = await files.write(TRAVEL_SAFE_FILE, '{"safe":["guest"]}');
    expect(guest.ok).toBe(false);
    expect(kvGet(TRAVEL_SAFE_KEY)).toBeNull();
    const marked = await files.write(TRAVEL_SAFE_FILE, '{"safe":["personal"]}');
    expect(marked.ok).toBe(true);
    expect(JSON.parse(kvGet(TRAVEL_SAFE_KEY) ?? "null")).toEqual({
      safe: ["personal"],
    });
  });
});
