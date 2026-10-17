import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunGrant,
  describeRunGrant,
} from "@opensesame/app-core/lib/password-agent/run-grant.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRunGrantStore } from "./parity-lease-node.js";
import { bindingFromRunArgs, claimRunGrantForRun } from "./parity-run-grant.js";

describe("run grant CLI store", () => {
  let directory: string;
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "opensesame-run-grant-"));
    previousStateDir = process.env.OPENSESAME_STATE_DIR;
    process.env.OPENSESAME_STATE_DIR = directory;
  });

  afterEach(async () => {
    if (previousStateDir === undefined)
      Reflect.deleteProperty(process.env, "OPENSESAME_STATE_DIR");
    else process.env.OPENSESAME_STATE_DIR = previousStateDir;
    await rm(directory, { recursive: true, force: true });
  });

  it("parses approve-run args into the canonical binding", () => {
    const { binding, expiresIn, uses } = bindingFromRunArgs([
      "--env",
      "B=os://personal/i2/f",
      "--env",
      "A=op://v/i/f",
      "--expires-in",
      "5m",
      "--uses",
      "3",
    ]);
    expect(binding.assignments).toEqual(["A=op://v/i/f", "B=os://personal/i2/f"]);
    expect(expiresIn).toBe("5m");
    expect(uses).toBe(3);
  });

  it("claims exactly the bound run once and refuses a widened run", async () => {
    const binding = describeRunGrant({
      assignments: [{ name: "API", reference: "op://v/i/f" }],
    });
    const store = await openRunGrantStore();
    try {
      await store.insert(
        createRunGrant({
          id: "grant-store-1",
          principal: await store.principal(),
          binding,
          now: Date.now(),
          uses: 1,
        }),
      );
    } finally {
      store.close();
    }
    await expect(claimRunGrantForRun("grant-store-1", binding)).resolves.toBeUndefined();
    await expect(claimRunGrantForRun("grant-store-1", binding)).rejects.toThrow(
      /invalid, expired, revoked, exhausted/,
    );
    const widened = describeRunGrant({
      assignments: [
        { name: "API", reference: "op://v/i/f" },
        { name: "EXTRA", reference: "op://v/i/g" },
      ],
    });
    await expect(claimRunGrantForRun("grant-store-1", widened)).rejects.toThrow(
      /does not match this run/,
    );
  });
});
