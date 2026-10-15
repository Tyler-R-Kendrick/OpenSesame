import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import artifacts from "./onepassword-artifacts.json" with { type: "json" };

describe("1Password protocol in a fresh CSP-like realm", () => {
  it("seeds jitless before real schema construction without probing Function", async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(
          new URL("./onepassword-worker-protocol.ts", import.meta.url),
        ),
      ],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "OnePasswordProtocol",
      platform: "neutral",
      target: "es2022",
      mainFields: ["module", "main"],
      conditions: ["browser", "import", "default"],
      logLevel: "silent",
    });
    const [output] = result.outputFiles;
    if (!output) throw new Error("The real protocol bundle was not emitted.");
    let probes = 0;
    function blockedFunction(): never {
      probes++;
      throw new EvalError(
        "Function construction is forbidden in this test realm.",
      );
    }
    // Keep native callable detection intact while denying only construction.
    Object.defineProperty(blockedFunction, "prototype", {
      value: Function.prototype,
    });
    const realm = createContext({
      Function: blockedFunction,
      URL,
      TextEncoder,
      Uint8Array,
      artifacts,
    });
    // vm evaluates the fixture source; only generated Function construction is denied.
    runInContext(output.text, realm);
    const receipt: string = runInContext(
      `
      const assets = {
        origin: "https://app.example",
        runtimeUrl: "https://app.example/base/" + artifacts.assets.runtime,
        wasmUrl: "https://app.example/base/" + artifacts.assets.wasm
      };
      const initialize = OnePasswordProtocol.OnePasswordWorkerRequestSchema.parse({
        type: "initialize", id: 1, assets,
        settings: {
          accountOrigin: "https://account.example",
          serviceAccountToken: "unit-fixture-not-a-provider-token",
          vaultId: "chosen-vault"
        }
      });
      const invoke = OnePasswordProtocol.OnePasswordWorkerRequestSchema.parse({
        type: "invoke", id: 2, command: { name: "ItemsList" }
      });
      const reply = OnePasswordProtocol.OnePasswordWorkerReplySchema.parse({
        type: "result", id: 2, result: { notes: ["bounded"] }
      });
      const request = OnePasswordProtocol.OnePasswordFetchRequestSchema.parse({
        type: "fetch", id: 1, url: "https://account.example/api/v3/auth/start",
        method: "POST", headers: [], body: new Uint8Array([0, 255])
      });
      JSON.stringify({
        initialize: initialize.type,
        command: invoke.command.name,
        result: reply.result,
        binary: request.body[1],
        parsed: OnePasswordProtocol.parseOnePasswordResult('{"note":"native JSON"}'),
        malformedRejected: !OnePasswordProtocol.OnePasswordWorkerRequestSchema.safeParse({
          type: "invoke", id: 3, command: { name: "invoke_sync" }
        }).success,
        jitless: globalThis.__zod_globalConfig?.jitless
      });
    `,
      realm,
    );
    expect(probes).toBe(0);
    expect(JSON.parse(receipt)).toEqual({
      initialize: "initialize",
      command: "ItemsList",
      result: { notes: ["bounded"] },
      binary: 255,
      parsed: { note: "native JSON" },
      malformedRejected: true,
      jitless: true,
    });
  });
});
