/** Actual independent detector and receiver processes; secrets stay in private files. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const requireCore = createRequire(
  path.join(root, "packages/app-core/package.json"),
);

export async function privateFixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "os-controlled-browser-"),
  );
  await chmod(directory, 0o700);
  return directory;
}

async function exited(child, timeout = 20000) {
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("Controlled child process exceeded its deadline."));
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function detectorCommand(directory, argv, input = "") {
  const job = await mkdtemp(path.join(directory, "command-"));
  const names = ["input", "output", "error"].map((name) =>
    path.join(job, name),
  );
  await writeFile(names[0], input, { mode: 0o600 });
  const handles = await Promise.all([
    open(names[0], "r"),
    open(names[1], "w", 0o600),
    open(names[2], "w", 0o600),
  ]);
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/bin.ts", ...argv],
      {
        cwd: path.join(root, "packages/cli"),
        env: {
          ...process.env,
          OPENSESAME_STATE_DIR: path.join(directory, "empty-detector"),
        },
        stdio: handles.map((handle) => handle.fd),
      },
    );
    const code = await exited(child);
    return {
      code,
      out: await readFile(names[1], "utf8"),
      err: await readFile(names[2], "utf8"),
    };
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function independentReceiver(directory) {
  const { build } = await import(requireCore.resolve("esbuild"));
  const bundle = path.join(directory, "receiver.mjs");
  await build({
    entryPoints: [
      path.join(
        root,
        "packages/app-core/src/node/credential-observation-server.ts",
      ),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    outfile: bundle,
    logLevel: "silent",
  });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const pairingFile = path.join(directory, "pairing.json");
  const receiptsFile = path.join(directory, "receipts.json");
  const provision = spawn(
    process.execPath,
    [bundle, "--provision", pairingFile, origin, "--allow-loopback"],
    { stdio: "ignore" },
  );
  assert.equal(
    await exited(provision),
    0,
    "independent provisioning process succeeds",
  );
  const child = spawn(
    process.execPath,
    [bundle, pairingFile, receiptsFile, String(port)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const finished = new Promise((resolve) => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Controlled receiver did not become ready.")),
        20000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Receiver exited before readiness."));
      });
      child.stdout.once("data", (data) => {
        clearTimeout(timer);
        try {
          const status = JSON.parse(data.toString());
          assert.equal(
            status.msg,
            "Controlled observation receiver listening on loopback.",
          );
          assert.equal(status.name, "credential-observation-receiver");
          assert.equal(status.level, 30);
          resolve();
        } catch {
          reject(new Error("Unexpected receiver readiness response."));
        }
      });
    });
  } catch (error) {
    child.kill("SIGTERM");
    await finished;
    throw error;
  }
  return {
    origin,
    pairingFile,
    receiptsFile,
    async receipts() {
      try {
        return JSON.parse(await readFile(receiptsFile, "utf8")).receipts;
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    },
    async close() {
      child.kill("SIGTERM");
      assert.equal(await finished, 0, "independent receiver closes cleanly");
    },
  };
}

export async function downloadCanary(page, dialog, directory, password) {
  await dialog
    .getByLabel("Canary type", { exact: true })
    .selectOption("mcp_configuration");
  await dialog
    .getByLabel("Current vault password", { exact: true })
    .fill(password);
  const downloaded = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Create and export canary", exact: true })
    .click();
  const file = path.join(directory, "opensesame-canary.json");
  await (await downloaded).saveAs(file);
  await chmod(file, 0o600);
  const config = JSON.parse(await readFile(file, "utf8"));
  assert.equal(config.artifact.context.kind, "mcp_configuration");
  assert.match(config.validatorBinding.validatorId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(
    (await dialog.innerText()).includes(config.artifact.presentedId),
    false,
    "one-time identifier is absent from the interface",
  );
  return { file, config };
}

function assertSyntheticProtocol(responses) {
  assert.equal(
    responses[0].result.serverInfo.name,
    "OpenSesame controlled canary",
  );
  assert.deepEqual(
    responses[1].result.tools.map((tool) => tool.name),
    ["canary.status"],
  );
  assert.equal(
    responses[2].result.content[0].text,
    '{"environment":"synthetic","status":"available"}',
  );
  assert.equal(responses[3].error.message, "Canary request rejected.");
}

export async function proveIndependentDetector(
  directory,
  file,
  config,
  realName,
) {
  const args = ["--config", file];
  const install = await detectorCommand(directory, [
    "canary",
    "install",
    ...args,
    "--trust-configuration",
    "--json",
  ]);
  assert.equal(
    install.code,
    0,
    "browser export installs in a separate empty CLI environment",
  );
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "canary.status", arguments: {} },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "vault.export", arguments: {} },
    },
  ];
  const served = await detectorCommand(
    directory,
    ["canary", "serve", ...args],
    `${requests.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  assert.equal(served.code, 0);
  const responses = served.out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assertSyntheticProtocol(responses);
  const observed = await detectorCommand(directory, [
    "canary",
    "events",
    ...args,
    "--json",
  ]);
  assert.equal(observed.code, 0);
  const events = JSON.parse(observed.out).events;
  assert.deepEqual(
    events.map((event) => event.phase),
    ["connected", "invoked"],
  );
  for (const result of [install, served, observed]) {
    assert.equal(
      (result.out + result.err).includes(config.artifact.presentedId),
      false,
    );
    assert.equal((result.out + result.err).includes(realName), false);
  }
  assert.equal(
    (
      await detectorCommand(directory, [
        "canary",
        "uninstall",
        ...args,
        "--json",
      ])
    ).code,
    0,
  );
  const revoked = await detectorCommand(
    directory,
    ["canary", "serve", ...args],
    `${JSON.stringify(requests[0])}\n`,
  );
  assert.equal(revoked.out.includes("serverInfo"), false);
  assert.equal(revoked.out.includes("Canary request rejected."), true);
  return {
    separateEnvironment: true,
    actualProcesses: 5,
    phases: events.map((event) => event.phase),
    productionToolDenied: true,
    uninstalledReplayDenied: true,
  };
}
