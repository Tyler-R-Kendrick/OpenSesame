import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startIdentityEndpoint } from "../../tests/mtls-interop/harness/browser-cert-endpoint.mjs";
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

describe("the Identity endpoint's tsx", () => {
  it("is the CLI Node resolves from packages/control-plane", () => {
    const root = hoistedRepository();
    expect(fs.realpathSync(tsxCli(root))).toBe(
      fs.realpathSync(path.join(root, "node_modules/tsx/dist/cli.mjs")),
    );
  });

  it("is found under a hoisted layout, so the endpoint goes on to its script", async () => {
    const root = hoistedRepository();
    await expect(
      startIdentityEndpoint({
        repoRoot: root,
        pki: {},
        bindings: "",
        dir: root,
      }),
    ).rejects.toThrow(/missing harness/);
  });

  it("is refused with the reason when the workspace is not installed", async () => {
    const root = hoistedRepository();
    fs.rmSync(path.join(root, "node_modules"), { recursive: true });
    await expect(
      startIdentityEndpoint({
        repoRoot: root,
        pki: {},
        bindings: "",
        dir: root,
      }),
    ).rejects.toThrow(/tsx does not resolve from packages\/control-plane/);
  });
});
