import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CandidateCustody,
  ResetRun,
} from "@opensesame/cua-password-reset";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedResetConfiguration } from "./password-reset-config.js";
import { loadResetEffects } from "./password-reset-runtime.js";
import type { ResetVault } from "./password-reset-vault.js";

const paths: string[] = [];
afterEach(async () =>
  Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
);

describe("password reset runtime", () => {
  it("revalidates config and exchanges the approved AgentClient handle before loading effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reset-runtime-"));
    paths.push(directory);
    await writeFile(
      join(directory, "runtime.mjs"),
      `
      export function validatePasswordResetConfiguration() {}
      export function createPasswordResetEffects() {
        return {
          execute: async (step) => ({ stepId: step.id, outcome: "completed" }),
          backupCandidate: async () => {},
          verifyCandidate: async () => "verified",
          promoteCandidate: async () => {},
          compensate: async () => "compensated"
        };
      }
    `,
    );
    const loaded: LoadedResetConfiguration = {
      directory,
      config: {
        schemaVersion: 1,
        origin: "https://accounts.example.test",
        itemId: "item-1",
        transport: "cdp",
        recipe: "recipe.json",
        runtime: {
          module: "runtime.mjs",
          resource: "https://runtime.example.test",
          model: "decision-model",
          modelBaseURL: "https://model.example.test/v1",
          modelKeyEnv: "RESET_MODEL_KEY",
          browser: "/opt/user/agent-browser",
          maxSteps: 40,
        },
      },
      recipe: {
        schemaVersion: 1,
        review: "approved",
        domain: "accounts.example.test",
        entryPath: "/reset",
        allowedOrigins: ["https://accounts.example.test"],
        steps: [{ id: "open", primitive: "navigate", path: "/reset" }],
      },
    };
    const run: ResetRun = {
      id: "run-1",
      domain: "accounts.example.test",
      origin: "https://accounts.example.test",
      itemId: "item-1",
      transport: "cdp",
      grantIds: {},
      cursor: 0,
      status: "running",
      recipe: loaded.recipe,
      updatedAt: "2026-10-27T00:00:00.000Z",
    };
    const headers = vi.fn(async () => ({
      authorization: "Bearer agent-capability",
      "x-opensesame-agent-client": crypto.randomUUID(),
      "x-opensesame-agent-audience": "urn:opensesame:agent:mcp-host" as const,
    }));
    // SAFETY: the adapter fixture does not access the vault store.
    const store = {} as ResetVault["store"];
    // SAFETY: the adapter fixture does not read account-item fields.
    const item = { id: "item-1" } as ResetVault["item"];
    // SAFETY: the adapter fixture does not produce a candidate password.
    const candidate = {} as CandidateCustody;
    const effects = await loadResetEffects({
      run,
      loaded,
      store,
      item,
      candidate,
      agent: { headers, forget: vi.fn() },
    });
    expect(effects).toBeTypeOf("object");
    expect(headers).toHaveBeenCalledWith("https://runtime.example.test");
  });
});
