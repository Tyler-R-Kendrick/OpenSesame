import { describe, expect, it } from "vitest";
import {
  RETIRED_CREDENTIAL_STATUS_FILE,
  retiredCredentialFiles,
} from "./retired-credential-files.js";

function files(owner: () => boolean) {
  return retiredCredentialFiles({
    owner,
    status: () => ({
      durable: true,
      traps: [
        { id: "private-trap-id", createdAt: "2026-10-05", response: "reject" },
      ],
      events: [
        {
          type: "retired_credential_observed",
          trapId: "private-trap-id",
          at: "2026-10-05",
          response: "reject",
        },
      ],
    }),
  });
}
describe("Retired password settings files", () => {
  it("exposes only counts and response choices, never identifiers or evidence", async () => {
    const provider = files(() => true);
    const text = await provider.read(RETIRED_CREDENTIAL_STATUS_FILE);
    expect(JSON.parse(text)).toEqual({
      local_only: true,
      observations: 1,
      traps: [{ response: "reject" }],
      durable: true,
    });
    expect(text).not.toContain("private-trap-id");
    expect(text).not.toContain("2026-10-05");
    expect(provider.check(RETIRED_CREDENTIAL_STATUS_FILE, "{}").ok).toBe(false);
    expect(
      (await provider.write(RETIRED_CREDENTIAL_STATUS_FILE, "{}")).ok,
    ).toBe(false);
    expect((await provider.remove(RETIRED_CREDENTIAL_STATUS_FILE)).ok).toBe(
      false,
    );
  });
  it("keeps follow-on interaction data out of the settings file", async () => {
    const provider = retiredCredentialFiles({
      owner: () => true,
      status: () => ({
        durable: true,
        traps: [],
        events: [
          {
            type: "synthetic_decoy_interaction",
            response: "synthetic_decoy",
            trapId: "private-trap-id",
            at: "2026-10-05",
            action: "authority_denied",
          },
        ],
      }),
    });
    expect(
      JSON.parse(await provider.read(RETIRED_CREDENTIAL_STATUS_FILE)),
    ).toEqual({ local_only: true, observations: 1, traps: [], durable: true });
  });
  it("reports unavailable records without exposing corrupted stored values", async () => {
    const provider = retiredCredentialFiles({
      owner: () => true,
      status: () => {
        throw new Error("private corrupt material");
      },
    });
    expect(
      JSON.parse(await provider.read(RETIRED_CREDENTIAL_STATUS_FILE)),
    ).toEqual({ local_only: true, available: false });
  });
  it("rechecks owner authority on each list and read", async () => {
    let owner = true;
    const provider = files(() => owner);
    expect(provider.list()).toHaveLength(1);
    owner = false;
    expect(provider.list()).toEqual([]);
    await expect(provider.read(RETIRED_CREDENTIAL_STATUS_FILE)).rejects.toThrow(
      "No file",
    );
  });
});
