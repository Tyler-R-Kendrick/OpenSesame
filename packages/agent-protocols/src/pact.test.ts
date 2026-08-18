import { describe, expect, it } from "vitest";
import {
  assertNoSecretFields,
  assertSourceOrder,
} from "@opensesame/testing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAgentCard, renderAuthMd } from "./render.js";

const here = dirname(fileURLToPath(import.meta.url));

const config = {
  serviceName: "OpenSesame",
  protectedResource: "https://api.opensesame.test",
  authorizationServer: "http://127.0.0.1:8788",
  consoleOrigin: "http://127.0.0.1:5173",
};

describe("PACT — agent-protocols", () => {
  it("property: concurrent renders are deterministic and omit secrets", async () => {
    const mds = await Promise.all(
      Array.from({ length: 16 }, () => Promise.resolve(renderAuthMd(config))),
    );
    expect(new Set(mds).size).toBe(1);
    expect(mds[0]).toContain("Never print `device_code`");
    assertNoSecretFields(renderAgentCard({ name: "card", url: config.authorizationServer }));
  });

  it("adversarial: secret-shaped config is refused before render", () => {
    expect(() =>
      renderAuthMd({ ...config, serviceName: "sk_live_should_not_render" }),
    ).toThrow(/agent_protocol_secret_refused/);
    expect(() =>
      renderAgentCard({
        name: "n",
        url: "http://127.0.0.1:8788",
        description: "Bearer abcdefghijklmnopqrstuvwxyz012345",
      }),
    ).toThrow(/agent_protocol_secret_refused/);
  });

  it("chaos: a poisoned field does not produce a partial document", () => {
    expect(() =>
      renderAuthMd({ ...config, postClaimBehavior: "osc_clm_claimpub.secret" }),
    ).toThrow(/agent_protocol_secret_refused/);
  });

  it("contract: production asserts config before interpolating", () => {
    assertSourceOrder(readFileSync(join(here, "render.ts"), "utf8"), [
      "function assertSafeConfig",
      "export function renderAuthMd",
      "assertSafeConfig(\"authMd\", config)",
    ]);
  });
});
