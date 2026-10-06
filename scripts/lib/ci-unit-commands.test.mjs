import { describe, expect, it } from "vitest";
import { describePlans, unitTestCommands } from "./ci-unit-commands.mjs";

const scoped = {
  name: "@t/a",
  dir: "packages/a",
  mode: "scoped",
  related: ["packages/a/src/x.ts"],
  hubs: [],
  hubTests: [],
  structural: ["src/ledger.test.ts"],
  extra: "node --test t/*.mjs",
  extraRuns: true,
};

describe("ci unit commands", () => {
  it("runs every package whole when the diff could not be read", () => {
    const [only] = unitTestCommands("/r", ["@t/a", "@t/b"], undefined);
    expect(unitTestCommands("/r", ["@t/a", "@t/b"], undefined)).toHaveLength(1);
    expect(only.args).toEqual(
      expect.arrayContaining(["--filter=@t/a", "--filter=@t/b"]),
    );
  });

  it("runs full packages through one turbo call and scoped ones by test", () => {
    const commands = unitTestCommands(
      "/r",
      [],
      [
        { name: "@t/w", dir: "packages/w", mode: "full", why: "manifest" },
        scoped,
      ],
    );
    expect(commands[0].args).toEqual([
      "exec",
      "turbo",
      "run",
      "test",
      "--concurrency=4",
      "--filter=@t/w",
    ]);
    expect(commands[1].args).toEqual([
      "--filter",
      "@t/a",
      "exec",
      "vitest",
      "related",
      "/r/packages/a/src/x.ts",
      "--run",
      "--passWithNoTests",
    ]);
    expect(commands[2].args).toContain("src/ledger.test.ts");
    expect(commands[3].args.slice(-3)).toEqual(["sh", "-c", scoped.extra]);
  });

  it("skips the rest of a vitest chain when nothing under the package changed", () => {
    const commands = unitTestCommands(
      "/r",
      [],
      [{ ...scoped, extraRuns: false }],
    );
    expect(commands.some((c) => c.args.includes("sh"))).toBe(false);
  });

  it("names a hub's depth in a note and omits the related call when nothing is related", () => {
    const commands = unitTestCommands(
      "/r",
      [],
      [
        {
          ...scoped,
          related: [],
          hubs: ["packages/a/src/hub.ts"],
          hubTests: ["src/near.test.ts"],
        },
      ],
    );
    expect(commands.some((c) => c.args.includes("related"))).toBe(false);
    expect(commands[0].note).toContain("packages/a/src/hub.ts");
    expect(commands[0].args).toContain("src/near.test.ts");
  });

  it("runs nothing for a package without tests", () => {
    expect(
      unitTestCommands("/r", [], [{ name: "@t/n", dir: "p/n", mode: "none" }]),
    ).toEqual([]);
  });

  it("describes each plan", () => {
    expect(
      describePlans([{ name: "@t/w", mode: "full", why: "manifest" }]),
    ).toEqual(["unit tests: @t/w full (manifest)"]);
    expect(describePlans(undefined)).toEqual([]);
  });
});
