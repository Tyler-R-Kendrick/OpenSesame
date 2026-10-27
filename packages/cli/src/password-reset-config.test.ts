import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadResetConfiguration } from "./password-reset-config.js";
import type { PasswordResetCommand } from "./password-reset-parse.js";

const ORIGIN = "https://accounts.example.test";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "reset-config-"));
  directories.push(directory);
  await writeFile(
    join(directory, "recipe.json"),
    JSON.stringify({
      schemaVersion: 1,
      review: "approved",
      domain: "accounts.example.test",
      entryPath: "/reset",
      allowedOrigins: [ORIGIN],
      steps: [{ id: "open", primitive: "navigate", path: "/reset" }],
    }),
  );
  await writeFile(
    join(directory, "runtime.mjs"),
    `
    import { writeFile } from "node:fs/promises";
    export async function validatePasswordResetConfiguration(config) {
      if (config.runtime.model !== "decision-model" || config.runtime.maxSteps > 80)
        throw new Error("invalid model contract");
      await writeFile(new URL("./validated.txt", import.meta.url), config.runtime.model);
    }
  `,
  );
  const command: PasswordResetCommand = {
    name: "password-reset",
    action: "configure",
    config: join(directory, "reset.json"),
    origin: ORIGIN,
    itemId: "item-1",
    recipe: "recipe.json",
    transport: "cdp",
    runtimeModule: "runtime.mjs",
    runtimeResource: "https://runtime.example.test",
    model: "decision-model",
    modelBaseURL: "https://model.example.test/v1",
    modelKeyEnv: "RESET_MODEL_KEY",
    browser: "/opt/user/agent-browser",
    maxSteps: 40,
    flags: { json: true },
  };
  return { directory, command };
}

describe("password reset configuration", () => {
  it("runs the adapter's real config probe and persists only non-secret references", async () => {
    const { directory, command } = await fixture();
    const configured = await loadResetConfiguration(command);
    expect(configured.config.transport).toBe("cdp");
    expect(await readFile(join(directory, "validated.txt"), "utf8")).toBe(
      "decision-model",
    );
    const text = await readFile(command.config, "utf8");
    expect(text).toContain("RESET_MODEL_KEY");
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain("OPENSESAME_LIVE_LINK");
    await expect(
      loadResetConfiguration({ ...command, action: "run" }),
    ).resolves.toMatchObject({ recipe: { review: "approved" } });
  });

  it("does not save configuration when validation fails", async () => {
    const { command } = await fixture();
    await expect(
      loadResetConfiguration({ ...command, model: "wrong-model" }),
    ).rejects.toThrow("invalid model contract");
    await expect(readFile(command.config, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
