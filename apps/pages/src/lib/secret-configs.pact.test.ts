import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * PACT — the project-config surface in Pages is value-blind.
 *
 * The Host never returns a secret value on this surface; these checks pin the
 * client to the same posture so a regression cannot quietly start rendering
 * one.
 */
describe("PACT — Pages secret configs never render a value", () => {
  it("lib guards every response for credential-shaped fields", () => {
    const src = readFileSync(join(here, "secret-configs.ts"), "utf8");
    // The recursive guard names the forbidden keys and runs on every parsed
    // response body before anything reaches a caller.
    assertSourceOrder(src, [
      "FORBIDDEN_KEYS",
      "value|secret|password|token|access_token|refresh_token|plaintext|ciphertext",
      "assertNoSecretLeak(body)",
    ]);
    // No normalized client type carries a value field off the wire.
    expect(src).not.toMatch(/value:\s*(raw|body|row)\./);
  });

  it("panel module never renders a value field", () => {
    const src = readFileSync(
      join(here, "../sections/settings/SecretConfigsPanel.tsx"),
      "utf8",
    );
    // The set-input is masked, write-only UI: the value goes up once and the
    // input is cleared on submit, success or failure.
    assertSourceOrder(src, [
      "putConfigSecrets(selectedId",
      'setNewKeyValue("")',
      'type="password"',
    ]);
    // Nothing read from the Host is rendered as a value: the panel renders
    // key names, version numbers and timestamps only.
    expect(src).not.toMatch(/\{\s*\w+\.(value|plaintext|secret)\b/);
    expect(src).not.toMatch(/\.value\s*\}/);
    // Rollback requires an explicit confirm step.
    assertSourceOrder(src, [
      "async function onRollback",
      "Confirm rollback",
      "setConfirmRollback({",
    ]);
  });

  it("contract: config responses parse strictly and reject values", async () => {
    const { ConfigKeysResponseSchema, SecretConfigViewSchema } = await import(
      "@opensesame/contracts"
    );
    const keys = ConfigKeysResponseSchema.parse({
      keys: [
        {
          key_name: "DATABASE_URL",
          version: 1,
          updated_at: "2026-08-20T00:00:00.000Z",
        },
      ],
    });
    expect(keys.keys[0]?.key_name).toBe("DATABASE_URL");
    expect(
      ConfigKeysResponseSchema.safeParse({
        keys: [
          {
            key_name: "DATABASE_URL",
            version: 1,
            updated_at: "2026-08-20T00:00:00.000Z",
            value: "leak",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SecretConfigViewSchema.safeParse({
        id: "config:1",
        organization_id: "org:1",
        project_id: "project:1",
        slug: "production",
        display_name: "Production",
        environment: "production",
        created_at: "2026-08-20T00:00:00.000Z",
        updated_at: "2026-08-20T00:00:00.000Z",
        access_token: "leak",
      }).success,
    ).toBe(false);
  });
});
