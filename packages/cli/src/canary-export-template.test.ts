import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePresentedId } from "@opensesame/app-core/lib/credential-canaries/identifier.js";
import * as canaries from "@opensesame/app-core/lib/credential-canaries/index.js";
import { expect, it, vi } from "vitest";
import { parseCanaryConfiguration } from "./canary-config.js";
import {
  MAX_CANARY_CONFIGURATION_BYTES,
  assertCanaryExportOutputFits,
  cliCanaryServer,
} from "./canary-export-template.js";
import { runCli } from "./run.js";
import { vaultKvSeams } from "./vault-kv.js";

function serverBranch(output: string): string {
  return `${JSON.stringify(
    { mcpServers: { OpenSesameCanary: cliCanaryServer(output) } },
    null,
    2,
  )}\n`;
}
function boundaryOutput(): string {
  const overhead = Buffer.byteLength(serverBranch("/x"), "utf8") - 2;
  return `/${"x".repeat(MAX_CANARY_CONFIGURATION_BYTES - overhead - 1)}`;
}
it("refuses an impossible export before prompting or touching a fresh vault or artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "os-export-preflight-"));
  const password = vi.fn(async () => {
    throw new Error("No password should be requested for impossible output.");
  });
  const read = vi.spyOn(vaultKvSeams, "readText");
  const create = vi.spyOn(canaries, "createControlledCanary");
  let errors = "";
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((value) => {
      errors += String(value);
      return true;
    });
  try {
    const output = join(directory, "x".repeat(5000));
    const code = await runCli(
      ["security", "canary", "export-mcp", "--output", output],
      { stateDir: join(directory, "never-created"), readPassword: password },
    );
    expect(code).toBe(1);
    expect(errors).toContain("Canary configuration exceeds 4 KiB.");
    expect(password).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    stderr.mockRestore();
    read.mockRestore();
    create.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
it("accepts an exact boundary lower bound and rejects the next UTF8 byte", () => {
  const output = boundaryOutput();
  expect(Buffer.byteLength(serverBranch(output), "utf8")).toBe(4096);
  expect(() => assertCanaryExportOutputFits(output)).not.toThrow();
  expect(() => assertCanaryExportOutputFits(`${output}x`)).toThrow("4 KiB");
});
it("counts escaped multibyte path bytes rather than JavaScript string length", () => {
  const output = `/${"é".repeat(2000)}`;
  const raw = serverBranch(output);
  expect(raw.length).toBeLessThan(MAX_CANARY_CONFIGURATION_BYTES);
  expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(
    MAX_CANARY_CONFIGURATION_BYTES,
  );
  expect(() => assertCanaryExportOutputFits(output)).toThrow("4 KiB");
});
it("keeps the final complete configuration validation after a fitting lower bound", () => {
  const output = boundaryOutput();
  assertCanaryExportOutputFits(output);
  const configuration = {
    v: 1,
    tomb: "personal",
    artifact: {
      id: crypto.randomUUID(),
      presentedId: encodePresentedId(
        crypto.getRandomValues(new Uint8Array(32)),
      ),
      context: {
        vaultIdentity: "generated-fixture",
        kind: "mcp_configuration",
        generation: 1,
      },
    },
    mcpServers: { OpenSesameCanary: cliCanaryServer(output) },
  };
  const full = `${JSON.stringify(configuration, null, 2)}\n`;
  expect(() => parseCanaryConfiguration(full)).toThrow("4 KiB");
  configuration.mcpServers.OpenSesameCanary = cliCanaryServer("canary.json");
  expect(
    parseCanaryConfiguration(`${JSON.stringify(configuration, null, 2)}\n`)
      .mcpServers,
  ).toEqual(configuration.mcpServers);
});
