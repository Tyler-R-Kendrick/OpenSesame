/**
 * The bare-isolate proof (ADR 0133 §6). The portable entry and the runtime
 * contract are bundled and run inside `vm.createContext({})` — a V8 context
 * with the ECMAScript built-ins and nothing else: no `crypto`, no
 * `TextEncoder`, no `URL`, no timers, no `process`, no DOM. That is what
 * Android's JavaScriptSandbox gives the core. Loading the core there must
 * touch no platform global, and the golden vault vectors must open unchanged.
 */
import { randomFillSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { type JsonValue, overlapCast } from "@opensesame/os-domain";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import trapVectors from "../lib/retired-credentials/protocol-vectors.json";
import { createNodeHost } from "../node/host.js";
import type { SandboxHostOptions } from "./host.js";
import type { RuntimeContractOptions } from "./runtime-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const osDomain = join(here, "../../../os-domain/src");
type Listed = { id: string; name: string; kind: string };
type Vector = {
  file: string;
  expect: {
    tomb: string;
    bound: boolean;
    rev: number | null;
    items: Listed[];
    /** Listed by path alone (ADR 0160 §5), for the vector that carries a key. */
    concealed?: string[];
  };
};
type Fixture = {
  password: string;
  passwordNfkc: string;
  vectors: Record<string, Vector>;
};
type Opened = Omit<Vector["expect"], "items" | "concealed"> & {
  items: (Listed & { path: string })[];
  concealed: string[];
};

const fixture: Fixture = overlapCast(
  JSON.parse(
    readFileSync(
      join(here, "../../../../spec/conformance/vault-vectors.json"),
      "utf8",
    ),
  ),
);

async function bundle(entry: string, globalName: string): Promise<string> {
  const result = await build({
    entryPoints: [join(here, entry)],
    bundle: true,
    write: false,
    format: "iife",
    globalName,
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    conditions: ["browser", "import", "default"],
    alias: {
      "@opensesame/os-domain/authority-templates": join(
        osDomain,
        "authority-templates/index.ts",
      ),
      "@opensesame/os-domain/wallet": join(osDomain, "wallet/index.ts"),
      "@opensesame/os-domain": join(osDomain, "browser.ts"),
    },
    logLevel: "silent",
  });
  const [output] = result.outputFiles;
  if (!output) throw new Error(`esbuild emitted nothing for ${entry}`);
  return output.text;
}

let runtime = "";
let core = "";

/** What the test hands into an isolate's global scope, and nothing else. */
type Isolate = {
  __persistence?: SandboxHostOptions["persistence"];
  __trapRecords?: string;
  __options?: RuntimeContractOptions;
  __file?: string;
  __password?: string;
  __nfkc?: string;
};

/** A fresh, empty context with the contract installed and the core loaded. */
function isolate(entropy = true): Isolate {
  const context: Isolate = createContext({});
  runInContext(runtime, context);
  runInContext(
    "OpenSesameRuntime.installRuntimeContract(globalThis, globalThis.__options)",
    Object.assign(context, {
      __options: entropy
        ? {
            getRandomValues: (array: Uint8Array | null) =>
              array === null ? array : randomFillSync(array),
          }
        : {},
    }),
  );
  runInContext(core, context);
  return context;
}

/** Run `source` inside the isolate; results cross back as JSON only. */
async function inside(context: Isolate, source: string): Promise<JsonValue> {
  const text = await runInContext(
    `(async () => JSON.stringify(await (async () => { ${source} })()))()`,
    context,
  );
  return text === undefined ? null : JSON.parse(text);
}

beforeAll(async () => {
  runtime = await bundle("runtime-contract.ts", "OpenSesameRuntime");
  core = await bundle("portable.ts", "OpenSesameCore");
}, 60_000);

describe("the portable core in a bare V8 context", () => {
  it("observes retired credentials through durable native ports after a fresh isolate opens", async () => {
    const directory = mkdtempSync(join(tmpdir(), "retired-isolate-proof-"));
    try {
      const node = createNodeHost({ stateDir: directory });
      if (!node.atRestKeys || !node.originFiles || !node.locks)
        throw new Error("Missing durable ports.");
      const persistence = {
        atRestKeys: node.atRestKeys,
        originFiles: node.originFiles,
        locks: node.locks,
      };
      const vector = trapVectors.vectors[0];
      if (!vector) throw new Error("Missing trap vector.");
      const first = Object.assign(isolate(), {
        __persistence: persistence,
        __trapRecords: JSON.stringify({
          v: 1,
          tomb: "native",
          events: [],
          traps: [
            {
              id: "vector",
              createdAt: new Date().toISOString(),
              response: "reject",
              salt: vector.saltB64,
              verifier: vector.verifierB64,
            },
          ],
        }),
      });
      await inside(
        first,
        `OpenSesameCore.configureHost(OpenSesameCore.createSandboxHost({persistence: __persistence})); await OpenSesameCore.kvSetDurable('tomb/native/retired-credentials.v1', __trapRecords); return true;`,
      );
      const reopened = Object.assign(isolate(), {
        __persistence: persistence,
        __password: vector.password,
      });
      expect(
        await inside(
          reopened,
          `OpenSesameCore.configureHost(OpenSesameCore.createSandboxHost({persistence: __persistence})); const match = await OpenSesameCore.probeRetiredCredential(__password, 'native'); return {id: match?.id, durable: OpenSesameCore.retiredCredentialStatus('native').durable};`,
        ),
      ).toEqual({ id: "vector", durable: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("starts from a context with no platform globals", () => {
    const empty = createContext({});
    const missing = runInContext(
      `["crypto","TextEncoder","URL","setTimeout","process","window","localStorage","navigator","fetch"].filter((name) => typeof globalThis[name] !== "undefined")`,
      empty,
    );
    expect(JSON.parse(JSON.stringify(missing))).toEqual([]);
  });

  it("loads without a host and without touching a platform global", async () => {
    const context = isolate();
    expect(
      await inside(context, "return typeof OpenSesameCore.openVaultFile"),
    ).toBe("function");
    expect(
      await inside(
        context,
        "try { OpenSesameCore.createSandboxHost; return typeof globalThis.__opensesameAppCoreHost; } catch (e) { return String(e); }",
      ),
    ).toBe("undefined");
  });

  it("refuses a host without Unicode normalisation", async () => {
    const context = isolate();
    expect(
      await inside(context, "OpenSesameRuntime.assertHostIntl(); return 'ok'"),
    ).toBe("ok");
    expect(
      await inside(
        context,
        `const real = String.prototype.normalize;
         String.prototype.normalize = function () { return String(this); };
         try { OpenSesameRuntime.assertHostIntl(); return "accepted"; }
         catch (e) { return e.message; }
         finally { String.prototype.normalize = real; }`,
      ),
    ).toMatch(/cannot normalise Unicode/);
  });

  it.each(Object.entries(fixture.vectors))(
    "opens the %s vector unchanged",
    async (_name, vector) => {
      const context = isolate();
      Object.assign(context, {
        __file: vector.file,
        __password: fixture.password,
      });
      const opened: Opened = overlapCast(
        await inside(
          context,
          `OpenSesameCore.configureHost(OpenSesameCore.createSandboxHost());
         return OpenSesameCore.openVaultFile(__file, __password);`,
        ),
      );
      expect({
        tomb: opened.tomb,
        bound: opened.bound,
        rev: opened.rev,
        items: opened.items.map(({ id, name, kind }) => ({
          id,
          name,
          kind,
        })),
        ...("concealed" in vector.expect
          ? { concealed: opened.concealed }
          : undefined),
      }).toEqual({
        ...vector.expect,
        // The golden files hold legacy logins; the core reads them as accounts
        // (ADR 0172), where the Rust reader still lists them as written.
        items: vector.expect.items.map((item) => ({
          ...item,
          kind: item.kind === "login" ? "account" : item.kind,
        })),
      });
    },
    120_000,
  );

  it("normalises the password with NFKC and refuses a wrong one", async () => {
    const context = isolate();
    Object.assign(context, {
      __file: fixture.vectors["export-personal"].file,
      __nfkc: fixture.passwordNfkc,
    });
    const result = await inside(
      context,
      `OpenSesameCore.configureHost(OpenSesameCore.createSandboxHost());
       const ok = await OpenSesameCore.openVaultFile(__file, __nfkc);
       let wrong = "opened";
       try { await OpenSesameCore.openVaultFile(__file, "not the password"); }
       catch (e) { wrong = e instanceof OpenSesameCore.WrongPasswordError ? "WrongPasswordError" : String(e); }
       return { items: ok.items.length, wrong };`,
    );
    expect(result).toEqual({
      items: fixture.vectors["export-personal"].expect.items.length,
      wrong: "WrongPasswordError",
    });
  }, 120_000);

  it("never runs an untrusted pattern on the isolate's only thread", async () => {
    const context = isolate();
    const results = await inside(
      context,
      `OpenSesameCore.configureHost(OpenSesameCore.createSandboxHost());
       return Promise.all([
         OpenSesameCore.testWebsitePattern({ uri: "(a+)+$", match: "regex" }, "example.com"),
         OpenSesameCore.testWebsitePattern({ uri: "*", match: "wildcard" }, "example.com"),
       ]);`,
    );
    expect(results).toEqual(["unavailable", "match"]);
  });

  it("searches and lists items with the same model the PWA uses", async () => {
    const context = isolate();
    const result = await inside(
      context,
      `OpenSesameCore.configureHost(OpenSesameCore.createSandboxHost());
       const item = OpenSesameCore.createItem("account", "Example Bank");
       return {
         found: OpenSesameCore.searchMatches(item, "bank"),
         missed: OpenSesameCore.searchMatches(item, "zzz"),
         host: OpenSesameCore.hostOf("https://www.example.com/login"),
         rows: OpenSesameCore.buildRows([item], [], new Set(), "").map((r) => r.type),
       };`,
    );
    expect(result).toEqual({
      found: true,
      missed: false,
      host: expect.stringContaining("example.com"),
      rows: ["item"],
    });
  });

  it("fails closed with no entropy source", async () => {
    const context = isolate(false);
    expect(
      await inside(
        context,
        `try { crypto.getRandomValues(new Uint8Array(4)); return "random"; }
         catch (e) { return e.message; }`,
      ),
    ).toMatch(/no entropy source/);
  });
});
