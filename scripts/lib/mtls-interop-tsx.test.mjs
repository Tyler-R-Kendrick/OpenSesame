import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tsxCli } from "../../tests/mtls-interop/harness/tsx-cli.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(root, file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
}

/**
 * A repository whose install hoisted tsx to the root and wrote no `.bin`
 * shim under packages/control-plane, as npm-style layouts do. It holds no
 * harness script, so an endpoint that found tsx stops at the script.
 */
function hoistedRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mtls-tsx-"));
  roots.push(root);
  writeJson(root, "packages/control-plane/package.json", {
    name: "@opensesame/control-plane",
  });
  writeJson(root, "node_modules/tsx/package.json", {
    name: "tsx",
    type: "module",
    exports: { "./cli": "./dist/cli.mjs", "./package.json": "./package.json" },
  });
  fs.mkdirSync(path.join(root, "node_modules/tsx/dist"));
  fs.writeFileSync(path.join(root, "node_modules/tsx/dist/cli.mjs"), "");
  return root;
}

/** Run Node's actual resolver without the test runner's global dependency path. */
function identityEndpointFailure(repoRoot, env = process.env) {
  const endpoint = new URL(
    "../../tests/mtls-interop/harness/browser-cert-endpoint.mjs",
    import.meta.url,
  ).href;
  const child = spawnSync(
    process.execPath,
    [
      "--no-global-search-paths",
      "--input-type=module",
      "--eval",
      `const { startIdentityEndpoint } = await import(process.argv[1]);
       const repoRoot = process.argv[2];
       await startIdentityEndpoint({ repoRoot, pki: {}, bindings: "", dir: repoRoot });`,
      endpoint,
      repoRoot,
    ],
    { cwd: repoRoot, env, encoding: "utf8", timeout: 5_000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(1);
  return child.stderr;
}

describe("the Identity endpoint's tsx", () => {
  it("is the CLI Node resolves from packages/control-plane", () => {
    const root = hoistedRepository();
    expect(fs.realpathSync(tsxCli(root))).toBe(
      fs.realpathSync(path.join(root, "node_modules/tsx/dist/cli.mjs")),
    );
  });

  it("is found under a hoisted layout, so the endpoint goes on to its script", () => {
    const root = hoistedRepository();
    expect(identityEndpointFailure(root)).toMatch(/missing harness/);
  });

  it("is refused with the reason when the workspace is not installed", () => {
    const root = hoistedRepository();
    fs.rmSync(path.join(root, "node_modules"), { recursive: true });
    const failure = identityEndpointFailure(root);
    expect(failure).toMatch(
      /tsx does not resolve from packages\/control-plane/,
    );
    expect(failure).toContain("MODULE_NOT_FOUND");
  });

  it("isolates an uninstalled workspace from an available global tsx", () => {
    const globalRoot = hoistedRepository();
    const root = hoistedRepository();
    fs.rmSync(path.join(root, "node_modules"), { recursive: true });
    const env = {
      ...process.env,
      NODE_PATH: path.join(globalRoot, "node_modules"),
    };
    const cli = new URL(
      "../../tests/mtls-interop/harness/tsx-cli.mjs",
      import.meta.url,
    );
    const control = spawnSync(process.execPath, [fileURLToPath(cli), root], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(control.error).toBeUndefined();
    expect(control.signal).toBeNull();
    expect(control.status).toBe(0);
    expect(fs.realpathSync(control.stdout.trim())).toBe(
      fs.realpathSync(path.join(globalRoot, "node_modules/tsx/dist/cli.mjs")),
    );
    const failure = identityEndpointFailure(root, env);
    expect(failure).toMatch(
      /tsx does not resolve from packages\/control-plane/,
    );
    expect(failure).toContain("MODULE_NOT_FOUND");
  });
});
