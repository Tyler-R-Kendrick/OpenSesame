import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import { exportControlledMcpConfiguration } from "./export.js";
import {
  type ControlledValidatorStoragePort,
  handleInstalledControlledMcpRequest,
  initializeControlledValidatorState,
  listInstalledControlledValidatorEvents,
} from "./installed-validator.js";
import { createControlledCanary } from "./registry.js";
import { parseControlledValidatorBinding } from "./validator-binding.js";
let restore = () => {};
let directory = "";
afterEach(async () => {
  restore();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("owner-exported artifact operates from a separate empty detector directory without a real vault", async () => {
  const fixture = await createRetiredCredentialFixture();
  restore = fixture.restore;
  const owner = { tomb: "personal", currentPassword: PASSWORD };
  const artifact = await createControlledCanary({
    ...owner,
    kind: "mcp_configuration",
  });
  const config = await exportControlledMcpConfiguration({
    ...owner,
    artifact,
    suppliedValidatorRef: "human_cli_stdio",
  });
  fixture.store.lock();
  directory = await mkdtemp(join(tmpdir(), "opensesame-detector-"));
  const path = join(directory, "detector.json");
  await writeFile(
    path,
    initializeControlledValidatorState(config.validatorBinding),
    { mode: 0o600 },
  );
  const storage: ControlledValidatorStoragePort = {
    transaction: async (work) =>
      work(await readFile(path, "utf8"), async (value) => {
        await writeFile(path, value, { mode: 0o600 });
      }),
  };
  const input = {
    binding: config.validatorBinding,
    storage,
    presentedId: artifact.presentedId,
  };
  expect(
    await handleInstalledControlledMcpRequest(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    }),
  ).toMatchObject({
    result: { serverInfo: { name: "OpenSesame controlled canary" } },
  });
  expect(
    await handleInstalledControlledMcpRequest(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "canary.status", arguments: {} },
    }),
  ).toMatchObject({
    result: {
      content: [{ text: '{"environment":"synthetic","status":"available"}' }],
    },
  });
  expect(
    (
      await listInstalledControlledValidatorEvents(
        config.validatorBinding,
        storage,
      )
    ).map((e) => e.phase),
  ).toEqual(["connected", "invoked"]);
  const raw = await readFile(path, "utf8");
  expect(raw).not.toContain(artifact.presentedId);
  expect(raw).not.toContain(PASSWORD);
  expect(await readdir(directory)).toEqual(["detector.json"]);
  await expect(
    handleInstalledControlledMcpRequest(
      { ...input, presentedId: `${"A".repeat(42)}B` },
      { jsonrpc: "2.0", id: 3, method: "initialize" },
    ),
  ).rejects.toThrow();
  await expect(
    handleInstalledControlledMcpRequest(
      {
        ...input,
        binding: {
          ...input.binding,
          context: { ...input.binding.context, generation: 2 },
        },
      },
      { jsonrpc: "2.0", id: 4, method: "initialize" },
    ),
  ).rejects.toThrow();
  await expect(
    handleInstalledControlledMcpRequest(
      {
        ...input,
        storage: { transaction: async (work) => work(null, async () => {}) },
      },
      { jsonrpc: "2.0", id: 5, method: "initialize" },
    ),
  ).rejects.toThrow();
  expect(() =>
    parseControlledValidatorBinding(
      JSON.stringify({ ...config.validatorBinding, rootKey: "forbidden" }),
    ),
  ).toThrow();
  await writeFile(path, "{}");
  await expect(
    handleInstalledControlledMcpRequest(input, {
      jsonrpc: "2.0",
      id: 6,
      method: "initialize",
    }),
  ).rejects.toThrow();
});
